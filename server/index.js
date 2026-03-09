require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const stringSimilarity = require('string-similarity');
const pLimit = require('p-limit');
const { Anthropic } = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY || 'fake_key',
});

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b-instruct-q4_K_M';
const ANTHROPIC_MODEL = 'claude-3-5-sonnet-20241022';
let lastEngineUsed = 'none';
const MATCH_THRESHOLD = 0.82;
const FUZZY_THRESHOLD = 0.62;
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 900000);
const SEMANTIC_MAX_CALLS = Number(process.env.SEMANTIC_MAX_CALLS || 18);

function isAnthropicEnabled() {
    return Boolean(
        process.env.ANTHROPIC_API_KEY &&
        !process.env.ANTHROPIC_API_KEY.includes('your_api_key')
    );
}

function isOllamaEnabled() {
    return process.env.OLLAMA_ENABLED === 'true';
}

function selectEngine() {
    if (isAnthropicEnabled()) return 'Anthropic_Claude';
    if (isOllamaEnabled()) return `Ollama_${OLLAMA_MODEL}`;
    return 'Local_Regex_Heuristic';
}

function buildPrompt(canonicalUrl, canonicalData, targetsData, fields) {
    let promptText = `Return JSON only. No markdown. No prose.\n\n`;
    promptText += `Compare each watched field against canonical truth and all target URLs.\n`;
    promptText += `You must produce one target result for every target URL.\n\n`;
    promptText += `Status types:\n`;
    promptText += `- exact_match: same value/meaning\n`;
    promptText += `- fuzzy_match: minor wording/format variance with same meaning\n`;
    promptText += `- mismatch: conflicting value/meaning\n`;
    promptText += `- no_match: field not found on that target URL\n\n`;
    promptText += `Severity:\n`;
    promptText += `- exact_match/fuzzy_match => low\n`;
    promptText += `- no_match => medium\n`;
    promptText += `- mismatch => high\n\n`;
    promptText += `Output schema exactly:\n`;
    promptText += `{"results":{"<field_label>":{"canonical":"...","targets":[{"url":"https://...","found":"...","type":"exact_match|fuzzy_match|mismatch|no_match","severity":"low|medium|high","confidence":0.0,"snippet":"..."}]}}}\n\n`;
    promptText += `Watched fields:\n${fields.map((f) => `- ${f}`).join('\n')}\n\n`;
    promptText += `Canonical URL: ${canonicalUrl}\nCanonical text:\n---\n${canonicalData.extracted_text}\n---\n\n`;
    promptText += `Targets:\n`;
    targetsData.forEach((target, i) => {
        promptText += `Target ${i + 1} URL: ${target.url}\n---\n${target.extracted_text}\n---\n\n`;
    });
    return promptText;
}

function parseResultsFromModelOutput(outputText) {
    const text = String(outputText || '').trim();
    if (!text) return {};

    const tryParse = (candidate) => {
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object') {
                if (parsed.results && typeof parsed.results === 'object') return parsed.results;
                return parsed;
            }
        } catch (_e) {
            // continue
        }
        return null;
    };

    const direct = tryParse(text);
    if (direct) return direct;

    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch?.[1]) {
        const fenced = tryParse(fenceMatch[1].trim());
        if (fenced) return fenced;
    }

    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const block = tryParse(text.slice(firstBrace, lastBrace + 1));
        if (block) return block;
    }

    throw new Error('No parseable JSON object in model output');
}

function normalizeWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function extractCanonicalLinesFromJson(payload) {
    const lines = [];
    const root = (payload && payload.data && payload.data.content) ? payload.data : payload;
    const push = (label, value) => {
        const l = normalizeWhitespace(label);
        const v = normalizeWhitespace(value);
        if (!l && !v) return;
        if (l && v) lines.push(`${l}: ${v}`);
        else lines.push(l || v);
    };

    const sections = asArray(root?.content?.sections);
    sections.forEach((section) => {
        asArray(section?.items).forEach((item) => {
            if (typeof item === 'string') lines.push(normalizeWhitespace(item));
        });
    });
    asArray(root?.content?.announcements).forEach((a) => push(a?.label, a?.value));
    asArray(root?.content?.contacts).forEach((c) => push(c?.label, c?.value));
    asArray(root?.content?.highlights).forEach((h) => {
        if (typeof h === 'string') lines.push(normalizeWhitespace(h));
    });

    const claims = root?.claims || root?.content?.claims || payload?.claims || [];
    (Array.isArray(claims) ? claims : []).forEach((claim) => {
        const label = claim?.label || claim?.field || claim?.key || claim?.name;
        const value = claim?.value || claim?.text || claim?.claim || claim?.normalized_value;
        push(label, value);
    });

    return lines.filter(Boolean);
}

function toFieldKey(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function sanitizeFieldLabel(value) {
    return normalizeWhitespace(String(value || '').replace(/^['"]+|['"]+$/g, ''));
}

function clampConfidence(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return Number(n.toFixed(2));
}

function statusToSeverity(status) {
    if (status === 'match') return 'low';
    if (status === 'fuzzy_match') return 'medium';
    return 'high';
}

function classifyFieldKind(fieldLabel) {
    const f = String(fieldLabel || '').toLowerCase();
    if (f.includes('email')) return 'email';
    if (f.includes('fee') || f.includes('tuition') || f.includes('amount') || f.includes('per unit') || f.includes('cost')) return 'amount';
    if (f.includes('date') || f.includes('deadline') || f.includes('trimester') || f.includes('semester') || f.includes('schedule')) return 'date';
    if (f.includes('chancellor') || f.includes('president') || f.includes('dean') || f.includes('director') || f.includes('vice') || f.includes('head') || f.includes('officer')) return 'name';
    if (f.includes('requirement') || f.includes('policy') || f.includes('copy') || f.includes('documents') || f.includes('mail') || f.includes('allowed') || f.includes('prohibited') || f.includes('must') || f.includes('should')) return 'policy';
    return 'text';
}

function normalizeName(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/\b(dr|mr|mrs|ms|prof|phd|ph\.d)\b\.?/g, ' ')
        .replace(/[^a-z\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractPossibleNameFragments(text) {
    const textStr = String(text || '');
    if (!textStr) return [];
    const out = [];
    textStr.split(/[\n;():|]/).forEach((part) => {
        part.split(',').forEach(subPart => {
            const fragment = normalizeName(subPart);
            if (!fragment) return;
            const tokens = fragment.split(' ').filter(Boolean);
            if (tokens.length >= 2 && tokens.length <= 6) out.push(tokens.join(' '));
        })
    });
    return Array.from(new Set(out));
}

function extractMoneyAmounts(text, options = {}) {
    const { requireContext = true } = options;
    const source = String(text || '');
    const out = [];
    const moneyPattern = /(?:\b(?:PHP|USD|EUR|JPY|AUD|CAD|GBP)\b|[$₱€£])\s*\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\b\d+\.\d{1,2}\b/g;
    const moneyKeywords = /\b(fee|tuition|application|amount|cost|payment|per unit|per term|undergrad|undergraduate|foreign|filipino|non[-\s]?refundable)\b/i;
    const contactKeywords = /\b(contact|phone|telephone|tel\.?|trunkline|hotline|loc\.?|local|fax|mobile)\b/i;
    const phoneLike = /\+?\d{2,4}[\s-]?\d{2,4}[\s-]?\d{3,5}(?:[\s-]?\d{1,4})?/;

    let match = moneyPattern.exec(source);
    while (match) {
        const raw = match[0];
        const index = match.index || 0;
        const left = Math.max(0, index - 28);
        const right = Math.min(source.length, index + raw.length + 28);
        const window = source.slice(left, right);
        const hasCurrency = /\b(?:PHP|USD|EUR|JPY|AUD|CAD|GBP)\b|[$₱€£]/i.test(raw);
        const hasMoneyContext = moneyKeywords.test(window);
        const hasContactContext = contactKeywords.test(window) || phoneLike.test(window);

        if (requireContext && !hasCurrency && !hasMoneyContext) {
            match = moneyPattern.exec(source);
            continue;
        }
        if (hasContactContext && !hasCurrency && !hasMoneyContext) {
            match = moneyPattern.exec(source);
            continue;
        }

        const numeric = Number(String(raw).replace(/[^0-9.]/g, ''));
        if (Number.isFinite(numeric) && numeric > 0) {
            out.push(Number(numeric.toFixed(2)));
        }

        match = moneyPattern.exec(source);
    }

    return Array.from(new Set(out));
}

function isLikelyContactOnlySnippet(text) {
    const source = String(text || '').toLowerCase();
    if (!source) return false;
    const hasContactCue = /\b(contact|phone|telephone|tel\.?|trunkline|hotline|loc\.?|local|fax|mobile)\b/.test(source);
    const hasPhoneLike = /\+?\d{2,4}[\s-]?\d{2,4}[\s-]?\d{3,5}(?:[\s-]?\d{1,4})?/.test(source);
    const hasMoneyCue = /\b(php|usd|application fee|tuition|non[-\s]?refundable|fee)\b/.test(source);
    return hasContactCue && hasPhoneLike && !hasMoneyCue;
}

function extractDateTokens(text) {
    const source = String(text || '');
    const out = [];
    const datePattern = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4}\b/gi;
    const numericDatePattern = /\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/g;
    (source.match(datePattern) || []).forEach((d) => out.push(normalizeWhitespace(d.toLowerCase())));
    (source.match(numericDatePattern) || []).forEach((d) => out.push(normalizeWhitespace(d.toLowerCase())));
    return Array.from(new Set(out));
}

function jaccardTokenSimilarity(a, b) {
    const ta = new Set(String(a || '').split(/\s+/).filter(Boolean));
    const tb = new Set(String(b || '').split(/\s+/).filter(Boolean));
    if (!ta.size || !tb.size) return 0;
    let intersection = 0;
    ta.forEach((token) => {
        if (tb.has(token)) intersection += 1;
    });
    const union = new Set([...ta, ...tb]).size;
    return union ? intersection / union : 0;
}

function policyNormalize(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/\bhard\s*copies?\b|\bhardcopy\b|\bhard copy\b/g, ' hardcopy ')
        .replace(/\bdocuments?\b/g, ' document ')
        .replace(/\brequires?\b|\brequired\b|\bstrictly required\b|\bmust\b|\bmandatory\b/g, ' require ')
        .replace(/\bsubmits?\b|\bsubmitted\b|\bsubmission\b|\bsubmitting\b/g, ' submit ')
        .replace(/\bvia mail\b|\bby mail\b|\bpostal\b|\bcourier\b|\bmail\b/g, ' mail ')
        .replace(/\s+/g, ' ')
        .trim();
}

function policySignalMap(text) {
    const t = policyNormalize(text);
    return {
        require: /\brequire\b/.test(t),
        optional: /\boptional\b|\bwaived\b|\bnot required\b|\bnot necessary\b/.test(String(text || '').toLowerCase()),
        hardcopy: /\bhardcopy\b/.test(t),
        document: /\bdocument\b/.test(t),
        submit: /\bsubmit\b/.test(t),
        mail: /\bmail\b/.test(t)
    };
}

function policyMeaningfulTokens(text) {
    const stop = new Set(['the', 'of', 'for', 'and', 'to', 'a', 'an', 'all', 'are', 'is', 'in', 'on', 'by', 'via']);
    return policyNormalize(text)
        .split(' ')
        .map((token) => token.trim())
        .filter((token) => token && !stop.has(token));
}

function policySemanticScore(snippetText, canonicalText) {
    const s = String(snippetText || '');
    const c = String(canonicalText || '');
    const sNorm = policyNormalize(s);
    const cNorm = policyNormalize(c);
    const lexical = stringSimilarity.compareTwoStrings(sNorm, cNorm);

    const st = new Set(policyMeaningfulTokens(sNorm));
    const ct = new Set(policyMeaningfulTokens(cNorm));
    const intersection = [...ct].filter((token) => st.has(token)).length;
    const union = new Set([...st, ...ct]).size || 1;
    const jaccard = intersection / union;

    const cSig = policySignalMap(c);
    const sSig = policySignalMap(s);

    const canonicalRequiredSignals = ['require', 'hardcopy', 'document', 'submit', 'mail']
        .filter((key) => cSig[key]).length;
    const matchedSignals = ['require', 'hardcopy', 'document', 'submit', 'mail']
        .filter((key) => cSig[key] && sSig[key]).length;
    const coverage = canonicalRequiredSignals > 0 ? matchedSignals / canonicalRequiredSignals : 0;

    let score = (lexical * 0.35) + (jaccard * 0.2) + (coverage * 0.45);

    // Hard contradiction: canonical says required but snippet says optional/not required.
    if (cSig.require && sSig.optional) {
        score -= 0.45;
    }
    // If canonical explicitly requires mail but snippet omits it, keep as fuzzy possible (not automatic no-match).
    if (cSig.mail && !sSig.mail) {
        score -= 0.03;
    }
    // Strong evidence for equivalent policy despite wording differences.
    if (cSig.require && sSig.require && cSig.hardcopy && sSig.hardcopy && cSig.document && sSig.document) {
        score += 0.22;
    }

    // Treat same policy intent as fuzzy/match even if channel detail ("mail") is omitted.
    if (cSig.require && cSig.hardcopy && cSig.document && sSig.require && sSig.hardcopy && sSig.document && !sSig.optional) {
        score = Math.max(score, (cSig.mail && !sSig.mail) ? 0.67 : 0.78);
    }

    return Math.max(0, Math.min(1, score));
}

function compareByFieldKind(fieldKind, snippetText, canonicalText) {
    if (fieldKind === 'email') {
        const sEmails = extractEmails(snippetText).map((e) => e.toLowerCase());
        const cEmails = extractEmails(canonicalText).map((e) => e.toLowerCase());
        if (!sEmails.length || !cEmails.length) return 0;
        if (sEmails.some((e) => cEmails.includes(e))) return 1;
        const domainOverlap = sEmails.some((e) => {
            const parts = e.split('@');
            if (parts.length !== 2) return false;
            return cEmails.some((c) => c.endsWith(`@${parts[1]}`));
        });
        return domainOverlap ? 0.55 : 0.2;
    }

    if (fieldKind === 'amount') {
        if (isLikelyContactOnlySnippet(snippetText)) return 0.03;

        const sAmounts = extractMoneyAmounts(snippetText, { requireContext: true });
        const cAmounts = extractMoneyAmounts(canonicalText, { requireContext: false });
        if (sAmounts.length && cAmounts.length) {
            if (sAmounts.some((v) => cAmounts.includes(v))) return 1;
            const near = sAmounts.some((sv) => cAmounts.some((cv) => Math.abs(sv - cv) <= Math.max(0.5, cv * 0.02)));
            if (near) return 0.68;
            return 0.18;
        }
        return stringSimilarity.compareTwoStrings(String(snippetText || '').toLowerCase(), String(canonicalText || '').toLowerCase());
    }

    if (fieldKind === 'date') {
        const sDates = extractDateTokens(snippetText);
        const cDates = extractDateTokens(canonicalText);
        if (sDates.length && cDates.length) {
            if (sDates.some((d) => cDates.includes(d))) return 1;
            const yearOverlap = sDates.some((d) => {
                const year = d.match(/\b(19|20)\d{2}\b/)?.[0];
                return year ? cDates.some((cd) => cd.includes(year)) : false;
            });
            return yearOverlap ? 0.68 : 0.22;
        }
        return stringSimilarity.compareTwoStrings(String(snippetText || '').toLowerCase(), String(canonicalText || '').toLowerCase());
    }

    if (fieldKind === 'name') {
        const snippetNames = extractPossibleNameFragments(snippetText);
        const canonicalNames = extractPossibleNameFragments(canonicalText);
        if (snippetNames.length && canonicalNames.length) {
            let best = 0;
            snippetNames.forEach((sn) => {
                canonicalNames.forEach((cn) => {
                    best = Math.max(best, jaccardTokenSimilarity(sn, cn), stringSimilarity.compareTwoStrings(sn, cn));
                });
            });
            return best;
        }
        return Math.max(
            stringSimilarity.compareTwoStrings(normalizeName(snippetText), normalizeName(canonicalText)),
            stringSimilarity.compareTwoStrings(String(snippetText || '').toLowerCase(), String(canonicalText || '').toLowerCase())
        );
    }

    if (fieldKind === 'policy') {
        return policySemanticScore(snippetText, canonicalText);
    }

    return stringSimilarity.compareTwoStrings(String(snippetText || '').toLowerCase(), String(canonicalText || '').toLowerCase());
}

function classifyFoundVsCanonical(canonical, found) {
    const c = normalizeWhitespace(canonical).toLowerCase();
    const f = normalizeWhitespace(found).toLowerCase();
    if (!f || f === 'no mention' || f === 'not found' || f === 'null') return { type: 'no_match', severity: 'medium', confidence: 0 };
    if (!c) return { type: 'mismatch', severity: 'high', confidence: 0.35 };
    const similarity = stringSimilarity.compareTwoStrings(c, f);
    if (similarity >= 0.97) return { type: 'exact_match', severity: 'low', confidence: similarity };
    if (similarity >= 0.72) return { type: 'fuzzy_match', severity: 'low', confidence: similarity };
    return { type: 'mismatch', severity: 'high', confidence: similarity };
}

function buildCanonicalFieldMap(canonicalData, fields) {
    const map = {};
    const lines = Array.isArray(canonicalData?.chunksArray) ? canonicalData.chunksArray.map((l) => normalizeWhitespace(l)) : [];
    const lineEntries = lines.map((line) => {
        const idx = line.indexOf(':');
        if (idx > 0) {
            return { label: normalizeWhitespace(line.slice(0, idx)), value: normalizeWhitespace(line.slice(idx + 1)), line };
        }
        return { label: line, value: line, line };
    });

    (fields || []).forEach((field) => {
        const f = sanitizeFieldLabel(field).toLowerCase();
        let best = null;
        let bestScore = 0;
        lineEntries.forEach((entry) => {
            const scoreLabel = stringSimilarity.compareTwoStrings(f, entry.label.toLowerCase());
            const scoreLine = stringSimilarity.compareTwoStrings(f, entry.line.toLowerCase());
            const score = Math.max(scoreLabel, scoreLine);
            if (score > bestScore) {
                bestScore = score;
                best = entry;
            }
        });
        map[f] = bestScore >= 0.35 ? (best?.value || '') : '';
    });
    return map;
}

function normalizeModelResults(rawResults, fields, targetUrls, canonicalFieldMap = {}) {
    const out = {};
    const safeFields = (fields || []).map(sanitizeFieldLabel).filter(Boolean);
    const safeTargetUrls = (targetUrls || []).map((u) => String(u || '').trim()).filter(Boolean);
    const byLabel = {};
    if (Array.isArray(rawResults)) {
        rawResults.forEach((r) => {
            const label = sanitizeFieldLabel(r?.label || r?.field || '');
            if (label) byLabel[label] = r;
        });
    } else if (rawResults && typeof rawResults === 'object') {
        Object.assign(byLabel, rawResults);
    }

    safeFields.forEach((fieldLabel) => {
        const row = byLabel[fieldLabel] || byLabel[toFieldKey(fieldLabel)] || {};
        const canonicalFallback = canonicalFieldMap[fieldLabel.toLowerCase()] || '';
        const canonical = normalizeWhitespace(row.canonical || row.canonical_value || canonicalFallback);
        const targetsRaw = Array.isArray(row.targets) ? row.targets : null;
        const conflicts = [];
        let fieldSeverity = 'low';

        safeTargetUrls.forEach((url, idx) => {
            let targetRow = null;
            if (targetsRaw) {
                targetRow = targetsRaw.find((t) => normalizeWhitespace(t.url) === normalizeWhitespace(url)) || targetsRaw[idx] || null;
            }

            const legacyFound = row[`target${idx + 1}`] ?? row[`source${idx + 1}`];
            const found = normalizeWhitespace(targetRow?.found ?? targetRow?.target_value ?? legacyFound ?? '');
            const explicitType = targetRow?.type || targetRow?.status || null;
            const explicitSeverity = targetRow?.severity || null;
            const classified = classifyFoundVsCanonical(canonical, found);
            const type = ['exact_match', 'fuzzy_match', 'mismatch', 'no_match'].includes(String(explicitType)) ? explicitType : classified.type;
            const severity = ['low', 'medium', 'high'].includes(String(explicitSeverity)) ? explicitSeverity : classified.severity;
            const confidence = typeof targetRow?.confidence === 'number' ? targetRow.confidence : classified.confidence;
            const snippet = normalizeWhitespace(targetRow?.snippet || found);

            if (type === 'exact_match') return;
            if (severity === 'high') fieldSeverity = 'high';
            if (severity === 'medium' && fieldSeverity !== 'high') fieldSeverity = 'medium';

            conflicts.push({
                url,
                found,
                type,
                severity,
                snippet,
                confidence
            });
        });

        if (conflicts.length > 0) {
            out[toFieldKey(fieldLabel)] = {
                canonical,
                type: 'entity',
                severity: fieldSeverity,
                conflicts
            };
        }
    });

    return out;
}

function createScanTimestamp() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
}

function loadLocalCanonicalFallback(canonicalUrl) {
    try {
        const localCanonPath = path.resolve(__dirname, '..', 'canon.json');
        if (!fs.existsSync(localCanonPath)) return null;
        const raw = JSON.parse(fs.readFileSync(localCanonPath, 'utf8'));
        const lines = extractCanonicalLinesFromJson(raw);
        return {
            url: canonicalUrl || 'local://canon.json',
            extracted_text: lines.join('\n').substring(0, 15000),
            chunksArray: lines,
            chunks: lines.length,
            success: true,
            source: 'local_canon_fallback'
        };
    } catch (error) {
        console.error('Failed loading local canonical fallback:', error.message);
        return null;
    }
}

function saveScanArtifact(payload) {
    try {
        const outDir = path.resolve(__dirname, '..', 'scan-results');
        fs.mkdirSync(outDir, { recursive: true });
        const timestamp = createScanTimestamp();
        const outPath = path.join(outDir, `scan-${timestamp}.json`);
        fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
        return outPath;
    } catch (error) {
        console.error('Failed to save scan artifact:', error.message);
        return null;
    }
}

async function getOllamaHealth() {
    const ollamaEnabled = isOllamaEnabled();
    const result = {
        enabled: ollamaEnabled,
        base_url: OLLAMA_BASE_URL,
        model: OLLAMA_MODEL,
        reachable: false,
        model_installed: false,
        error: null
    };

    if (!ollamaEnabled) return result;

    try {
        const response = await axios.get(`${OLLAMA_BASE_URL}/api/tags`, { timeout: 5000 });
        result.reachable = true;
        const models = response?.data?.models || [];
        result.model_installed = models.some((m) => m?.name === OLLAMA_MODEL);
    } catch (error) {
        result.error = error.message;
    }

    return result;
}

async function crawlUrl(url) {
    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 15000
        });
        if (typeof response.data === 'object' && response.data !== null) {
            const lines = extractCanonicalLinesFromJson(response.data);
            const extractedText = lines.join('\n').substring(0, 15000);
            return {
                url,
                extracted_text: extractedText,
                chunksArray: lines,
                chunks: lines.length,
                success: true
            };
        }
        const $ = cheerio.load(response.data);

        // Remove boilerplate/noise elements
        $('script, style, nav, footer, iframe, noscript, header, svg, img, form, button').remove();

        // Extract text blocks
        const chunks = [];
        $('h1, h2, h3, h4, h5, p, li, td, th').each((i, el) => {
            const text = $(el).text().replace(/\s+/g, ' ').trim();
            // Only keep substantial chunks to avoid link noise
            if (text.length > 20) {
                chunks.push(text);
            }
        });

        let extractedText = chunks.join('\n\n');
        if (extractedText.length < 50) {
            const bodyLines = $('body').text().split('\n').map(t => t.trim()).filter(Boolean);
            extractedText = bodyLines.join('\n\n');
            if (chunks.length === 0) {
                chunks.push(...bodyLines);
            }
        }

        return {
            url,
            extracted_text: extractedText.substring(0, 15000),
            chunksArray: chunks, // Keep array for heuristics
            chunks: chunks.length,
            success: true
        };
    } catch (error) {
        console.error(`Error crawling ${url}:`, error.message);
        return {
            url,
            extracted_text: `[Error fetching URL: ${error.message}]`,
            chunksArray: [],
            chunks: 0,
            success: false
        };
    }
}

function buildCanonicalVariants(canonicalUrl) {
    const variants = [canonicalUrl];
    if (!canonicalUrl.includes('/api/admissions')) return variants;
    try {
        const u = new URL(canonicalUrl);
        const base = `${u.origin}${u.pathname}`;
        variants.push(base);
        const claims = new URL(base);
        claims.searchParams.set('include', 'claims');
        variants.push(claims.toString());
    } catch (_e) {
        // keep original only
    }
    return Array.from(new Set(variants));
}

async function chooseCanonicalInput(canonicalUrl) {
    const variants = buildCanonicalVariants(canonicalUrl);
    const crawled = await Promise.all(variants.map((u) => crawlUrl(u)));
    const scored = crawled.map((item) => {
        const claimBonus = /claims?[\].:]/i.test(item.extracted_text || '') ? 250 : 0;
        const score = (item.success ? 1 : 0) * 10000 + (item.chunks || 0) * 3 + (item.extracted_text || '').length + claimBonus;
        return { ...item, score };
    });
    scored.sort((a, b) => b.score - a.score);
    let selected = scored[0] || crawled[0];
    if (!selected || !selected.success || !selected.extracted_text || selected.extracted_text.length < 50) {
        const fallback = loadLocalCanonicalFallback(canonicalUrl);
        if (fallback) selected = fallback;
    }
    return {
        selected,
        candidates: scored
    };
}

function buildAdmissionsOrigin(canonicalUrl) {
    try {
        const u = new URL(canonicalUrl);
        return `${u.origin}`;
    } catch (_e) {
        return null;
    }
}

function valueToStrings(value) {
    if (value === null || value === undefined) return [];
    if (Array.isArray(value)) return value.flatMap(valueToStrings);
    if (typeof value === 'object') return Object.values(value).flatMap(valueToStrings);
    return [normalizeWhitespace(String(value))].filter(Boolean);
}

function normalizeFlatCanon(flatPayload) {
    const root = flatPayload?.data || flatPayload || {};
    const entries = [];
    const pushEntry = (canonicalRef, text) => {
        const ref = normalizeWhitespace(canonicalRef);
        const t = normalizeWhitespace(text);
        if (!ref || !t) return;
        entries.push({ canonical_ref: ref, text: t });
    };

    const kv = root?.kv_index || {};
    Object.entries(kv).forEach(([k, v]) => {
        valueToStrings(v).forEach((txt) => pushEntry(k, txt));
    });

    const sections = root?.sections || {};
    Object.entries(sections).forEach(([sectionName, sectionValue]) => {
        if (Array.isArray(sectionValue)) {
            sectionValue.forEach((item, idx) => valueToStrings(item).forEach((txt) => pushEntry(`${sectionName}[${idx}]`, txt)));
            return;
        }
        if (sectionValue && typeof sectionValue === 'object') {
            if (sectionValue.pairs && typeof sectionValue.pairs === 'object') {
                Object.entries(sectionValue.pairs).forEach(([k, v]) => valueToStrings(v).forEach((txt) => pushEntry(`${sectionName}.${k}`, txt)));
            }
            if (Array.isArray(sectionValue.items)) {
                sectionValue.items.forEach((item, idx) => valueToStrings(item).forEach((txt) => pushEntry(`${sectionName}.items[${idx}]`, txt)));
            }
            Object.entries(sectionValue).forEach(([k, v]) => {
                if (k === 'pairs' || k === 'items') return;
                valueToStrings(v).forEach((txt) => pushEntry(`${sectionName}.${k}`, txt));
            });
            return;
        }
        valueToStrings(sectionValue).forEach((txt) => pushEntry(sectionName, txt));
    });

    const summary = root?.section_summaries || {};
    Object.entries(summary).forEach(([k, v]) => valueToStrings(v).forEach((txt) => pushEntry(`section_summaries.${k}`, txt)));
    const announcements = root?.announcements;
    if (Array.isArray(announcements)) {
        announcements.forEach((a, idx) => pushEntry(`announcements[${idx}].${a?.label || 'item'}`, a?.value || a?.text || ''));
    } else if (announcements && typeof announcements === 'object') {
        Object.entries(announcements).forEach(([k, v], idx) => {
            valueToStrings(v).forEach((txt) => pushEntry(`announcements.${k || idx}`, txt));
        });
    }

    const contacts = root?.contacts;
    if (Array.isArray(contacts)) {
        contacts.forEach((c, idx) => pushEntry(`contacts[${idx}].${c?.label || 'item'}`, c?.value || c?.text || ''));
    } else if (contacts && typeof contacts === 'object') {
        Object.entries(contacts).forEach(([k, v], idx) => {
            valueToStrings(v).forEach((txt) => pushEntry(`contacts.${k || idx}`, txt));
        });
    }

    const dedup = [];
    const seen = new Set();
    entries.forEach((e) => {
        const key = `${e.canonical_ref}::${e.text}`;
        if (seen.has(key)) return;
        seen.add(key);
        dedup.push(e);
    });
    return dedup;
}

function parseClaimsJsonl(claimsText) {
    const out = [];
    const text = String(claimsText || '').trim();
    if (!text) return out;
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    let rows = [];
    if (lines.length === 1 && lines[0].startsWith('[')) {
        try { rows = JSON.parse(lines[0]); } catch (_e) { rows = []; }
    } else {
        rows = lines.map((line) => {
            try { return JSON.parse(line); } catch (_e) { return null; }
        }).filter(Boolean);
    }

    if (rows.length === 1 && rows[0] && !Array.isArray(rows[0]) && typeof rows[0] === 'object') {
        if (Array.isArray(rows[0].data)) rows = rows[0].data;
        else if (Array.isArray(rows[0].claims)) rows = rows[0].claims;
    }

    rows.forEach((row, idx) => {
        const claimId = row.claim_id || row.id || `row_${idx + 1}`;
        const canonicalText = normalizeWhitespace(row.canonical_text || row.text || row.value || row.claim || '');
        const aliases = valueToStrings(row.aliases || []);
        const entities = valueToStrings(row.entities || []);
        if (!canonicalText && aliases.length === 0) return;
        out.push({
            canonical_ref: `claim_id:${claimId}`,
            canonical_text: canonicalText || aliases[0] || '',
            aliases,
            entities
        });
    });
    return out;
}

function normalizeTokenString(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function canonicalRefLabel(canonicalRef) {
    const ref = String(canonicalRef || '');
    const parts = ref.split('.');
    return normalizeTokenString(parts[parts.length - 1] || ref);
}

function roleCompatibilityScore(fieldLabel, candidateLabel) {
    const field = normalizeTokenString(fieldLabel);
    const candidate = normalizeTokenString(candidateLabel);
    const has = (phrase) => candidate.includes(normalizeTokenString(phrase));

    if (!field.includes('chancellor')) return 0;

    if (field.includes('vice chancellor for academic affairs')) {
        if (has('vice chancellor') && (has('academic affairs') || has('academic'))) return 0.45;
        if (has('vice chancellor')) return -0.2;
        return -0.5;
    }

    if (field.includes('vice chancellor for finance and administration')) {
        if (has('vice chancellor') && (has('finance') || has('administration'))) return 0.45;
        if (has('vice chancellor')) return -0.2;
        return -0.5;
    }

    if (field.includes('vice chancellor')) {
        return has('vice chancellor') ? 0.25 : -0.35;
    }

    if (field.includes('chancellor')) {
        if (has('vice chancellor')) return -0.45;
        if (has('chancellor')) return 0.25;
        return -0.25;
    }

    return 0;
}

function splitMeaningfulTokens(value) {
    const stop = new Set(['for', 'and', 'of', 'the', 'per', 'by', 'to', 'in', 'on', 'a', 'an', 'via']);
    return normalizeTokenString(value)
        .split(' ')
        .filter((token) => token && !stop.has(token));
}

function tokenOverlapScore(fieldLabel, candidateLabel) {
    const fieldTokens = splitMeaningfulTokens(fieldLabel);
    const candidateTokens = new Set(splitMeaningfulTokens(candidateLabel));
    if (!fieldTokens.length || !candidateTokens.size) return 0;
    const matched = fieldTokens.filter((token) => candidateTokens.has(token)).length;
    return matched / fieldTokens.length;
}

async function fetchCanonicalDatasets(canonicalUrl) {
    const origin = buildAdmissionsOrigin(canonicalUrl);
    if (!origin) {
        return {
            flatEntries: normalizeFlatCanon({}),
            claims: [],
            meta: {
                origin: canonicalUrl,
                flat_url: null,
                claims_url: null,
                snapshot_url: null,
                claims_source: 'none',
                flat_source: 'none',
                snapshot_source: 'none',
                fallback: true
            }
        };
    }

    const flatUrl = `${origin}/api/admissions/flat`;
    const claimsUrl = `${origin}/api/admissions/claims?format=jsonl`;
    const snapshotUrl = `${origin}/api/admissions`;

    let flatData = null;
    let claimsData = '';
    let snapshotData = null;
    let claimsSource = 'unavailable';
    let flatSource = 'unavailable';
    let snapshotSource = 'unavailable';

    try {
        const claimsResp = await axios.get(claimsUrl, { timeout: 20000, responseType: 'text' });
        claimsData = claimsResp?.data || '';
        claimsSource = 'api';
    } catch (_e) {
        claimsSource = 'unavailable';
    }

    try {
        const flatResp = await axios.get(flatUrl, { timeout: 20000 });
        flatData = flatResp?.data;
        flatSource = 'api';
    } catch (_e) {
        flatSource = 'unavailable';
    }

    try {
        const snapshotResp = await axios.get(snapshotUrl, { timeout: 20000 });
        snapshotData = snapshotResp?.data;
        snapshotSource = 'api';
    } catch (_e) {
        snapshotSource = 'unavailable';
    }

    let flatEntries = normalizeFlatCanon(flatData || {});
    if (flatEntries.length === 0) {
        flatEntries = extractCanonicalLinesFromJson(snapshotData || {}).map((line, idx) => {
            const i = line.indexOf(':');
            if (i > 0) {
                return { canonical_ref: normalizeWhitespace(line.slice(0, i)), text: normalizeWhitespace(line.slice(i + 1)) };
            }
            return { canonical_ref: `snapshot.${idx + 1}`, text: normalizeWhitespace(line) };
        });
        if (flatEntries.length > 0) flatSource = flatSource === 'api' ? 'api+snapshot_fallback' : 'snapshot_fallback';
    }

    if (flatEntries.length === 0) {
        const local = loadLocalCanonicalFallback(canonicalUrl);
        flatEntries = (local?.chunksArray || []).map((line, idx) => {
            const i = String(line).indexOf(':');
            if (i > 0) return { canonical_ref: normalizeWhitespace(String(line).slice(0, i)), text: normalizeWhitespace(String(line).slice(i + 1)) };
            return { canonical_ref: `local.${idx + 1}`, text: normalizeWhitespace(line) };
        });
        if (flatEntries.length > 0) {
            flatSource = 'local_canon_json';
            if (snapshotSource === 'unavailable') snapshotSource = 'local_canon_json';
        }
    }

    let claims = parseClaimsJsonl(claimsData);
    if (claims.length === 0 && snapshotData) {
        const lines = extractCanonicalLinesFromJson(snapshotData);
        claims = lines.slice(0, 300).map((line, idx) => ({
            canonical_ref: `claim_id:snapshot.${idx + 1}`,
            canonical_text: line,
            aliases: [],
            entities: []
        }));
        if (claims.length > 0) claimsSource = claimsSource === 'api' ? 'api+snapshot_fallback' : 'snapshot_fallback';
    }

    if (claims.length === 0 && flatEntries.length > 0) {
        claims = flatEntries.slice(0, 300).map((entry, idx) => ({
            canonical_ref: `claim_id:flat.${idx + 1}`,
            canonical_text: `${entry.canonical_ref}: ${entry.text}`,
            aliases: [entry.canonical_ref],
            entities: []
        }));
        if (claims.length > 0) claimsSource = claimsSource === 'api' ? 'api+flat_fallback' : 'flat_fallback';
    }

    return {
        flatEntries,
        claims,
        meta: {
            origin,
            flat_url: flatUrl,
            claims_url: claimsUrl,
            snapshot_url: snapshotUrl,
            claims_source: claimsSource,
            flat_source: flatSource,
            snapshot_source: snapshotSource
        }
    };
}

function getCanonicalCandidates(fieldLabel, flatEntries, claims) {
    const term = sanitizeFieldLabel(fieldLabel).toLowerCase();
    const fieldKind = classifyFieldKind(fieldLabel);
    const scoredClaims = [];
    const scoredFlat = [];
    const score = (a, b) => stringSimilarity.compareTwoStrings(String(a || '').toLowerCase(), String(b || '').toLowerCase());
    const termKey = toFieldKey(term);

    flatEntries.forEach((entry) => {
        const ref = String(entry.canonical_ref || '');
        const text = String(entry.text || '');
        const label = canonicalRefLabel(ref);
        const labelScore = Math.max(score(term, label), score(term, ref));
        const valueScore = score(term, text);
        const overlap = tokenOverlapScore(fieldLabel, `${label} ${ref}`);
        const roleScore = fieldKind === 'name' ? roleCompatibilityScore(fieldLabel, `${label} ${ref}`) : 0;
        const keyBonus = toFieldKey(ref).includes(termKey) ? 0.2 : 0;
        let s = (fieldKind === 'name')
            ? (labelScore * 0.78) + (valueScore * 0.12) + (overlap * 0.25) + roleScore + keyBonus
            : (labelScore * 0.62) + (valueScore * 0.28) + (overlap * 0.18) + keyBonus;
        s = Math.max(0, Math.min(1, s));

        if (fieldKind === 'name' && labelScore < 0.22 && roleScore <= 0) return;
        if (s > 0.2) {
            scoredFlat.push({ canonical_ref: entry.canonical_ref, text: entry.text, score: s, source: 'flat' });
        }
    });
    claims.forEach((claim) => {
        const aliasBest = Math.max(0, ...claim.aliases.map((a) => score(term, a)));
        const entBest = Math.max(0, ...claim.entities.map((e) => score(term, e)));
        const textScore = score(term, claim.canonical_text);
        const labelPrefix = normalizeTokenString(String(claim.canonical_text || '').split(':')[0] || '');
        const refLabel = canonicalRefLabel(claim.canonical_ref || '');
        const labelScore = Math.max(aliasBest, score(term, labelPrefix), score(term, refLabel));
        const overlap = tokenOverlapScore(fieldLabel, `${labelPrefix} ${refLabel} ${claim.aliases.join(' ')}`);
        const roleScore = fieldKind === 'name' ? roleCompatibilityScore(fieldLabel, `${labelPrefix} ${refLabel} ${claim.aliases.join(' ')}`) : 0;
        const hasKey = toFieldKey(claim.canonical_text || '').includes(termKey);
        let s = (fieldKind === 'name')
            ? (labelScore * 0.76) + (textScore * 0.1) + (overlap * 0.24) + roleScore + (hasKey ? 0.08 : 0)
            : (Math.max(labelScore, entBest) * 0.64) + (textScore * 0.26) + (overlap * 0.2) + (hasKey ? 0.08 : 0);
        s = Math.max(0, Math.min(1, s));

        if (fieldKind === 'name' && labelScore < 0.22 && roleScore <= 0) return;
        if (s > 0.2) {
            scoredClaims.push({ canonical_ref: claim.canonical_ref, text: claim.canonical_text, score: s, source: 'claim' });
        }
    });

    scoredClaims.sort((a, b) => b.score - a.score);
    scoredFlat.sort((a, b) => b.score - a.score);
    const topClaims = scoredClaims.slice(0, 3);
    const topFlat = scoredFlat.slice(0, 3);
    const merged = [...topClaims, ...topFlat];
    const dedup = [];
    const seen = new Set();
    merged.forEach((m) => {
        const key = `${m.canonical_ref}::${m.text}`;
        if (seen.has(key)) return;
        seen.add(key);
        dedup.push({ canonical_ref: m.canonical_ref, text: m.text });
    });

    if (dedup.length === 0 && claims.length > 0) {
        claims.slice(0, 3).forEach((claim) => {
            dedup.push({ canonical_ref: claim.canonical_ref, text: claim.canonical_text });
        });
    }
    if (dedup.length === 0 && flatEntries.length > 0) {
        flatEntries.slice(0, 3).forEach((entry) => {
            dedup.push({ canonical_ref: entry.canonical_ref, text: entry.text });
        });
    }

    return dedup;
}

function buildTargetSnippets(target) {
    const chunks = Array.isArray(target?.chunksArray) ? target.chunksArray : [];
    let snippets = chunks.map((text, idx) => ({
        id: `s${idx + 1}`,
        text: normalizeWhitespace(text)
    })).filter((s) => s.text);

    if (snippets.length === 0) {
        const parts = String(target?.extracted_text || '')
            .split(/[\n]+|(?<=[.?!])\s+/)
            .map((text) => normalizeWhitespace(text))
            .filter((text) => text.length > 20)
            .slice(0, 80);
        snippets = parts.map((text, idx) => ({ id: `s${idx + 1}`, text }));
    }
    return snippets;
}

function extractEmails(text) {
    return String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
}

function snippetRoleMentionScore(fieldLabel, snippetText) {
    const field = normalizeTokenString(fieldLabel);
    const snippet = normalizeTokenString(snippetText);
    if (!snippet) return 0;

    if (field.includes('vice chancellor for academic affairs')) {
        if (snippet.includes('vice chancellor') && (snippet.includes('academic affairs') || snippet.includes('academic'))) return 1;
        if (snippet.includes('vice chancellor')) return 0.55;
        return 0;
    }
    if (field.includes('vice chancellor for finance and administration')) {
        if (snippet.includes('vice chancellor') && (snippet.includes('finance') || snippet.includes('administration'))) return 1;
        if (snippet.includes('vice chancellor')) return 0.55;
        return 0;
    }
    if (field.includes('chancellor') && !field.includes('vice chancellor')) {
        if (snippet.includes('vice chancellor')) return 0;
        return snippet.includes('chancellor') ? 1 : 0.3;
    }
    return tokenOverlapScore(fieldLabel, snippetText);
}

function hasExactNameEvidence(snippetText, canonicalText) {
    const snippetCandidates = extractPossibleNameFragments(snippetText);
    const canonicalCandidates = extractPossibleNameFragments(canonicalText);

    if (snippetCandidates.length === 0) snippetCandidates.push(normalizeName(snippetText));
    if (canonicalCandidates.length === 0) canonicalCandidates.push(normalizeName(canonicalText));

    for (const s of snippetCandidates) {
        if (!s) continue;
        for (const c of canonicalCandidates) {
            if (!c) continue;
            const sim = stringSimilarity.compareTwoStrings(s, c);
            if (sim >= 0.95) return true;
        }
    }
    return false;
}

function deterministicAdjudication(fieldLabel, candidates, snippets, preferredCandidate = null) {
    const canonicalCandidate = preferredCandidate || candidates[0] || null;

    if (!snippets.length) {
        return {
            fact: '',
            canonical_ref: canonicalCandidate?.canonical_ref || '',
            status: 'no_match',
            confidence: 0,
            reason: 'No target snippets available',
            target_snippet_ids: [],
            canonical_text: canonicalCandidate?.text || ''
        };
    }
    if (!canonicalCandidate) {
        return { fact: '', canonical_ref: '', status: 'no_match', confidence: 0, reason: 'No canonical candidates found', target_snippet_ids: [], canonical_text: '' };
    }

    const fieldKind = classifyFieldKind(fieldLabel);
    let best = { score: 0, snippet: snippets[0], candidate: canonicalCandidate };
    let hasRoleMention = false;
    let exactNameMatched = false;

    snippets.forEach((snippet) => {
        let s = compareByFieldKind(fieldKind, snippet.text, canonicalCandidate.text);
        if (fieldKind === 'name') {
            const exactName = hasExactNameEvidence(snippet.text, canonicalCandidate.text);
            if (exactName) {
                exactNameMatched = true;
                hasRoleMention = true;
                s = Math.max(s, 0.97);
            } else {
                const roleMention = snippetRoleMentionScore(fieldLabel, snippet.text);
                hasRoleMention = hasRoleMention || roleMention >= 0.55;
                s *= (0.55 + (roleMention * 0.45));
            }
        }
        if (s > best.score) best = { score: s, snippet, candidate: canonicalCandidate };
    });

    let conf = clampConfidence(best.score);
    if (fieldKind === 'name' && !hasRoleMention && !exactNameMatched && conf < MATCH_THRESHOLD) {
        conf = Math.min(conf, 0.4);
    }
    const status = conf >= MATCH_THRESHOLD ? 'match' : conf >= FUZZY_THRESHOLD ? 'fuzzy_match' : 'no_match';
    const reason = status === 'match'
        ? `Deterministic ${fieldKind} check found strong alignment with canonical candidate.`
        : status === 'fuzzy_match'
            ? `Deterministic ${fieldKind} check found partial alignment; wording/format differs.`
            : `Deterministic ${fieldKind} check found insufficient evidence for a reliable match.`;

    return {
        fact: (status === 'no_match' && fieldKind !== 'policy') ? '' : (best.snippet?.text || ''),
        canonical_ref: canonicalCandidate?.canonical_ref || '',
        status,
        confidence: conf,
        reason,
        target_snippet_ids: ((status === 'no_match' && fieldKind !== 'policy') || !best.snippet?.id) ? [] : [best.snippet.id],
        canonical_text: canonicalCandidate?.text || '',
        field_kind: fieldKind
    };
}

async function semanticAdjudicationWithOllama(fieldLabel, candidates, targetUrl, snippets, deterministic, semanticBudget, preferredCandidate = null) {
    if (!isOllamaEnabled()) return deterministic;
    if (semanticBudget.used >= semanticBudget.max) return deterministic;
    if (deterministic.status === 'match' && deterministic.confidence >= MATCH_THRESHOLD) return deterministic;
    if (deterministic.status === 'no_match' && deterministic.confidence < FUZZY_THRESHOLD) {
        const policyNeedsSemantic = deterministic.field_kind === 'policy' && deterministic.confidence >= 0.35;
        if (!policyNeedsSemantic) return deterministic;
    }

    semanticBudget.used += 1;
    const payload = {
        watched_field: fieldLabel,
        canonical_candidates: candidates.slice(0, 3).map((c) => ({ canonical_ref: c.canonical_ref, text: c.text })),
        target_url: targetUrl,
        target_snippets: snippets.slice(0, 8),
        rules: { labels: ['match', 'fuzzy_match', 'no_match'] }
    };
    const system = 'You are a strict admissions consistency checker. Use only the provided evidence. If evidence is missing or ambiguous, return no_match. Return valid JSON only.';
    const prompt = `${system}\n\n${JSON.stringify(payload)}`;

    try {
        const resp = await axios.post(`${OLLAMA_BASE_URL}/api/generate`, {
            model: OLLAMA_MODEL,
            prompt,
            stream: false,
            format: 'json',
            options: { temperature: 0 }
        }, { timeout: OLLAMA_TIMEOUT_MS });

        const parsed = parseResultsFromModelOutput(resp?.data?.response || '{}');
        const status = ['match', 'fuzzy_match', 'no_match'].includes(parsed.status) ? parsed.status : deterministic.status;
        const confidence = typeof parsed.confidence === 'number' ? clampConfidence(parsed.confidence) : deterministic.confidence;
        const allowedRefs = new Set(candidates.map((c) => c.canonical_ref));
        const parsedRef = normalizeWhitespace(parsed.canonical_ref || '');
        const canonical_ref = (allowedRefs.has(parsedRef) ? parsedRef : '')
            || preferredCandidate?.canonical_ref
            || deterministic.canonical_ref;
        const reason = normalizeWhitespace(parsed.reason || deterministic.reason);
        const ids = Array.isArray(parsed.target_snippet_ids) ? parsed.target_snippet_ids : deterministic.target_snippet_ids;
        const firstSnippet = snippets.find((s) => ids.includes(s.id))
            || snippets.find((s) => String(parsed.fact || '').toLowerCase() && s.text.toLowerCase().includes(String(parsed.fact).toLowerCase()))
            || snippets[0];
        const canonicalText = candidates.find((c) => c.canonical_ref === canonical_ref)?.text
            || preferredCandidate?.text
            || deterministic.canonical_text;

        const normalizedStatus = confidence >= MATCH_THRESHOLD ? 'match' : confidence >= FUZZY_THRESHOLD ? 'fuzzy_match' : 'no_match';
        const finalStatus = ['match', 'fuzzy_match', 'no_match'].includes(status) ? status : normalizedStatus;
        return {
            fact: normalizeWhitespace(parsed.fact || firstSnippet?.text || deterministic.fact),
            canonical_ref,
            status: finalStatus,
            confidence,
            reason,
            target_snippet_ids: ids,
            canonical_text: canonicalText,
            field_kind: deterministic.field_kind
        };
    } catch (_e) {
        return deterministic;
    }
}

// ----------------------------------------------------
// FREE LOCAL HEURISTIC ENGINE (No API Key Required)
// ----------------------------------------------------
function guessValueRegex(fieldName) {
    const f = fieldName.toLowerCase();
    if (f.includes('year') || f.includes('found')) return /\b(16|17|18|19|20)\d{2}\b/g;
    if (f.includes('locat') || f.includes('address') || f.includes('campus')) return /\d{1,5}\s(?:[A-Za-z0-9.-]+\s){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Circle|Cir)\b/gi;
    if (f.includes('phone') || f.includes('contact')) return /\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
    // Default/Names (President, Chancellor, etc.) look for Title Case words
    return /(?:Dr\.|Mr\.|Mrs\.|Ms\.|Prof\.)?\s*([A-Z][a-z]+(?: [A-Z][a-z]+)+)/g;
}

function extractHeuristic(textChunks, fieldName) {
    const keyword = fieldName.toLowerCase().split(' ')[0]; // E.g., 'chancellor'
    const regex = guessValueRegex(fieldName);

    // 1. Search in chunks containing the keyword
    for (let chunk of textChunks) {
        if (chunk.toLowerCase().includes(keyword)) {
            const matches = chunk.match(regex);
            if (matches && matches.length > 0) {
                return { value: matches[0].trim(), snippet: chunk.substring(0, 150) + "..." };
            }
        }
    }

    // 2. Fallback search entire text
    const fallbackMatch = textChunks.join(' ').match(regex);
    if (fallbackMatch && fallbackMatch.length > 0) {
        return { value: fallbackMatch[0].trim(), snippet: "Extracted via local Regex heuristic match without keyword context." };
    }

    return null;
}

function runLocalEngine(canonicalData, targetsData, fields) {
    const results = {};

    fields.forEach(field => {
        // Find Canonical Value
        const canonicalMatch = extractHeuristic(canonicalData.chunksArray, field);
        if (!canonicalMatch) return; // Skip if we can't establish a canonical truth

        const fieldResult = {
            canonical: canonicalMatch.value,
            severity: "medium", // Default heuristic severity
            type: field.toLowerCase().includes('year') ? 'date' : field.toLowerCase().includes('phone') ? 'contact' : 'entity',
            conflicts: []
        };

        // Check Targets against Canonical
        targetsData.forEach(target => {
            const targetMatch = extractHeuristic(target.chunksArray, field);
            if (!targetMatch) return; // Not found on this page

            const similarity = stringSimilarity.compareTwoStrings(
                canonicalMatch.value.toLowerCase(),
                targetMatch.value.toLowerCase()
            );

            // If completely equal, no conflict
            if (similarity > 0.95) return;

            // Determine match type
            const matchType = similarity > 0.60 ? 'fuzzy_match' : 'mismatch';
            const severity = similarity > 0.60 ? 'low' : 'high';
            if (severity === 'high') fieldResult.severity = 'high';

            fieldResult.conflicts.push({
                url: target.url,
                found: targetMatch.value,
                type: matchType,
                snippet: targetMatch.snippet,
                confidence: similarity < 0.2 ? 0.9 : similarity // Heuristic confidence mapped
            });
        });

        if (fieldResult.conflicts.length > 0) {
            results[field.toLowerCase().replace(/ /g, '_')] = fieldResult;
        }
    });

    return results;
}
// ----------------------------------------------------


app.post('/api/scan', async (req, res) => {
    const { canonicalUrl, targetUrls, fields } = req.body;
    const normalizedTargetUrls = (Array.isArray(targetUrls) ? targetUrls : []).map((u) => String(u || '').trim()).filter(Boolean);
    const normalizedFields = (Array.isArray(fields) ? fields : []).map(sanitizeFieldLabel).filter(Boolean);

    if (!canonicalUrl || normalizedTargetUrls.length === 0 || normalizedFields.length === 0) {
        return res.status(400).json({ error: 'canonicalUrl, targetUrls, and fields are required.' });
    }

    try {
        console.log(`Crawling ${normalizedTargetUrls.length + 1} URLs (Batching concurrency: 2)...`);
        const limit = pLimit(2);
        const canonicalPromise = crawlUrl(canonicalUrl);
        const canonicalDatasetsPromise = fetchCanonicalDatasets(canonicalUrl);

        const targetPromises = normalizedTargetUrls.map((url, index) => limit(async () => {
            if (index > 0) {
                await new Promise(resolve => setTimeout(resolve, 700));
            }
            return crawlUrl(url);
        }));
        const [canonicalData, canonicalDatasets, targetsData] = await Promise.all([
            canonicalPromise,
            canonicalDatasetsPromise,
            Promise.all(targetPromises)
        ]);

        const crawlResults = [canonicalData, ...targetsData];
        const engineUsed = isOllamaEnabled() ? `Ollama_${OLLAMA_MODEL}` : 'Deterministic_ClaimsFlat';
        const totalPairs = normalizedFields.length * normalizedTargetUrls.length;
        const semanticBudget = {
            used: 0,
            max: Math.max(3, Math.min(totalPairs, SEMANTIC_MAX_CALLS))
        };
        const contractResults = [];
        const uiResults = [];
        const fieldStats = {};
        const urlStats = {};
        const semanticInputs = [];

        for (const field of normalizedFields) {
            const candidates = getCanonicalCandidates(field, canonicalDatasets.flatEntries, canonicalDatasets.claims);
            const deterministicCandidates = candidates.filter((c) => !String(c.canonical_ref || '').startsWith('claim_id:'));
            const deterministicPool = deterministicCandidates.length > 0 ? deterministicCandidates : candidates;
            const primaryCanonical = deterministicPool[0] || candidates[0] || null;
            fieldStats[field] = { match: 0, fuzzy_match: 0, no_match: 0, total: 0 };

            for (const target of targetsData) {
                const snippets = buildTargetSnippets(target);
                const deterministic = deterministicAdjudication(field, deterministicPool, snippets, primaryCanonical);
                const semanticInputMeta = {
                    watched_field: field,
                    target_url: target.url,
                    candidate_refs: candidates.slice(0, 3).map((c) => c.canonical_ref),
                    primary_canonical_ref: primaryCanonical?.canonical_ref || '',
                    snippet_ids: snippets.slice(0, 8).map((s) => s.id)
                };
                let adjudicated = deterministic;

                if (candidates.length > 0 && snippets.length > 0) {
                    adjudicated = await semanticAdjudicationWithOllama(
                        field,
                        candidates,
                        target.url,
                        snippets,
                        deterministic,
                        semanticBudget,
                        primaryCanonical
                    );
                }

                semanticInputs.push({
                    ...semanticInputMeta,
                    deterministic: {
                        status: deterministic.status,
                        confidence: deterministic.confidence,
                        canonical_ref: deterministic.canonical_ref
                    },
                    final: {
                        status: adjudicated.status,
                        confidence: adjudicated.confidence,
                        canonical_ref: adjudicated.canonical_ref
                    }
                });

                const contractRow = {
                    fact: normalizeWhitespace(adjudicated.fact || ''),
                    canonical_ref: normalizeWhitespace(adjudicated.canonical_ref || ''),
                    status: ['match', 'fuzzy_match', 'no_match'].includes(adjudicated.status) ? adjudicated.status : 'no_match',
                    confidence: clampConfidence(adjudicated.confidence),
                    reason: normalizeWhitespace(adjudicated.reason || 'No reason provided.')
                };
                contractResults.push(contractRow);

                const canonicalText = adjudicated.canonical_text
                    || candidates.find((c) => c.canonical_ref === contractRow.canonical_ref)?.text
                    || '';
                const severity = statusToSeverity(contractRow.status);
                uiResults.push({
                    watched_field: field,
                    target_url: target.url,
                    canonical_ref: contractRow.canonical_ref,
                    canonical_source: canonicalText,
                    found_value: contractRow.fact,
                    status: contractRow.status,
                    confidence: contractRow.confidence,
                    match_severity: severity,
                    reason: contractRow.reason,
                    target_snippet_ids: Array.isArray(adjudicated.target_snippet_ids) ? adjudicated.target_snippet_ids : []
                });

                fieldStats[field].total += 1;
                fieldStats[field][contractRow.status] = (fieldStats[field][contractRow.status] || 0) + 1;

                if (!urlStats[target.url]) {
                    urlStats[target.url] = { match: 0, fuzzy_match: 0, no_match: 0, total: 0 };
                }
                urlStats[target.url].total += 1;
                urlStats[target.url][contractRow.status] = (urlStats[target.url][contractRow.status] || 0) + 1;
            }
        }

        const confidenceSum = contractResults.reduce((sum, row) => sum + clampConfidence(row.confidence), 0);
        const overallConsistencyScore = contractResults.length ? Number((confidenceSum / contractResults.length).toFixed(2)) : 0;

        const responsePayload = {
            raw_data: crawlResults,
            results: contractResults,
            ui_results: uiResults,
            engine_used: engineUsed,
            canonical_selected: canonicalUrl,
            canonical_datasets: {
                claims_url: canonicalDatasets.meta.claims_url,
                flat_url: canonicalDatasets.meta.flat_url,
                snapshot_url: canonicalDatasets.meta.snapshot_url,
                claims_source: canonicalDatasets.meta.claims_source,
                flat_source: canonicalDatasets.meta.flat_source,
                snapshot_source: canonicalDatasets.meta.snapshot_source,
                claims_count: canonicalDatasets.claims.length,
                flat_entries_count: canonicalDatasets.flatEntries.length
            },
            stats: {
                by_field: fieldStats,
                by_url: urlStats,
                overall_consistency_score: overallConsistencyScore,
                semantic_calls_used: semanticBudget.used,
                semantic_calls_max: semanticBudget.max
            }
        };

        const scanArtifactPath = saveScanArtifact({
            timestamp: new Date().toISOString(),
            request: {
                canonicalUrl,
                targetUrls: normalizedTargetUrls,
                fields: normalizedFields
            },
            canonical_datasets: responsePayload.canonical_datasets,
            semantic_calls: semanticInputs,
            response: responsePayload
        });
        if (scanArtifactPath) {
            responsePayload.saved_scan_path = scanArtifactPath;
        }

        res.json(responsePayload);
        lastEngineUsed = engineUsed;

    } catch (error) {
        console.error(error);
        saveScanArtifact({
            timestamp: new Date().toISOString(),
            request: {
                canonicalUrl,
                targetUrls: normalizedTargetUrls,
                fields: normalizedFields
            },
            error: {
                message: error.message
            }
        });
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/health', async (_req, res) => {
    try {
        const anthropicConfigured = isAnthropicEnabled();
        const selectedEngine = selectEngine();
        const ollamaHealth = await getOllamaHealth();

        res.json({
            ok: true,
            selected_engine: selectedEngine,
            last_engine_used: lastEngineUsed,
            anthropic: {
                configured: anthropicConfigured,
                model: ANTHROPIC_MODEL,
                being_used: selectedEngine === 'Anthropic_Claude'
            },
            ollama: {
                ...ollamaHealth,
                being_used: selectedEngine.startsWith('Ollama_')
            }
        });
    } catch (error) {
        console.error('Health check failed:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Universiy Recon Crawler Backend running on port ${PORT}`);
});
