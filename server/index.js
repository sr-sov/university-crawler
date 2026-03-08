require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
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
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 300000);
const ANTHROPIC_MODEL = 'claude-3-5-sonnet-20241022';
let lastEngineUsed = 'none';

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
    const fieldsDescription = fields.join(', ');
    let promptText = `You are an automated data consistency verifier. Your job is to extract facts from unstructured web raw text dumps, and compare secondary domains against the primary canonical truth.\n\n`;
    promptText += `AUTHORITATIVE SOURCE (CANONICAL): URL: ${canonicalUrl}\n---\n${canonicalData.extracted_text}\n---\n\n`;
    promptText += `TARGET SOURCES TO VERIFY:\n`;
    targetsData.forEach((target, i) => {
        promptText += `Source ${i + 1}: URL: ${target.url}\n---\n${target.extracted_text}\n---\n\n`;
    });
    promptText += `Please analyze the target sources against the canonical source. Look specifically to verify consistency regarding these conceptual fields: ${fieldsDescription}.\n\n`;
    promptText += `Rules:\n`;
    promptText += `1. Normalize semantic variations. Minor typo/format variants are fuzzy_match + low severity (e.g. "Sarah" vs "Sara", "Sarah" vs "Sarah C").\n`;
    promptText += `2. Clearly different entities are mismatch + high severity (e.g. "Sarah" vs "Dan").\n`;
    promptText += `3. Output strict JSON only (no markdown, no prose) using this schema exactly:\n`;
    promptText += `{"results":{"<field_key>":{"canonical":"...","type":"entity|date|contact","severity":"low|medium|high","conflicts":[{"url":"https://...","found":"...","type":"fuzzy_match|mismatch","severity":"low|high","snippet":"...","confidence":0.0}]}}}\n`;
    return promptText;
}

function toFieldKey(field) {
    return String(field || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function inferFieldType(field) {
    const value = String(field || '').toLowerCase();
    if (value.includes('year') || value.includes('date') || value.includes('deadline') || value.includes('term')) return 'date';
    if (value.includes('phone') || value.includes('contact') || value.includes('email') || value.includes('address')) return 'contact';
    return 'entity';
}

function parseResultsFromModelOutput(outputText) {
    const jsonStr = outputText.substring(outputText.indexOf('{'), outputText.lastIndexOf('}') + 1);
    return JSON.parse(jsonStr).results || {};
}

function flattenCanonicalSnapshot(snapshot) {
    const normalized = snapshot?.data && typeof snapshot.data === 'object' ? snapshot.data : snapshot;
    const lines = [];

    if (!normalized || typeof normalized !== 'object') {
        return { extractedText: '', derivedFields: [], metadata: {} };
    }

    const content = normalized.content || {};
    const crawler = normalized.crawler || {};

    if (normalized.title) lines.push(`Title: ${normalized.title}`);
    if (normalized.subtitle) lines.push(`Subtitle: ${normalized.subtitle}`);

    const highlights = Array.isArray(content.highlights) ? content.highlights : [];
    if (highlights.length > 0) {
        lines.push('Highlights:');
        highlights.forEach((item) => lines.push(`- ${item}`));
    }

    const sections = Array.isArray(content.sections) ? content.sections : [];
    sections.forEach((section) => {
        if (section.heading) lines.push(`Section: ${section.heading}`);
        if (section.summary) lines.push(`Summary: ${section.summary}`);
        const items = Array.isArray(section.items) ? section.items : [];
        items.forEach((item) => lines.push(`- ${item}`));
    });

    const announcements = Array.isArray(content.announcements) ? content.announcements : [];
    announcements.forEach((entry) => {
        if (entry?.label && entry?.value) lines.push(`${entry.label}: ${entry.value}`);
    });

    const contacts = Array.isArray(content.contacts) ? content.contacts : [];
    contacts.forEach((entry) => {
        if (entry?.label && entry?.value) lines.push(`${entry.label}: ${entry.value}`);
    });

    const sourceUrls = Array.isArray(crawler.sourceUrls) ? crawler.sourceUrls : [];
    if (sourceUrls.length > 0) {
        lines.push('Canonical Source URLs:');
        sourceUrls.forEach((url) => lines.push(`- ${url}`));
    }
    if (crawler.notes) lines.push(`Crawler Notes: ${crawler.notes}`);

    const fieldSet = new Set();
    const collectLabel = (value) => {
        const text = String(value || '').trim();
        if (!text) return;
        if (text.includes(':')) {
            const [label] = text.split(':');
            if (label && label.length > 2) fieldSet.add(label.trim());
        }
    };

    sections.forEach((section) => {
        const items = Array.isArray(section.items) ? section.items : [];
        items.forEach(collectLabel);
    });
    announcements.forEach((entry) => {
        if (entry?.label) fieldSet.add(String(entry.label).trim());
    });
    contacts.forEach((entry) => {
        if (entry?.label) fieldSet.add(String(entry.label).trim());
    });

    return {
        extractedText: lines.join('\n'),
        derivedFields: Array.from(fieldSet).filter(Boolean),
        metadata: {
            source: snapshot?.source || 'json_payload',
            generatedAt: snapshot?.generatedAt || null,
            slug: normalized.slug || null,
            title: normalized.title || null,
            version: normalized.version || null,
            lastReviewedAt: normalized.lastReviewedAt || null
        }
    };
}

function normalizeEntityValue(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/\b(dr|mr|mrs|ms|prof)\.?\b/g, ' ')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function classifyDifference(canonicalValue, foundValue) {
    const canonicalNorm = normalizeEntityValue(canonicalValue);
    const foundNorm = normalizeEntityValue(foundValue);

    if (!canonicalNorm || !foundNorm) {
        return { type: 'mismatch', severity: 'high', confidence: 0.5 };
    }

    if (canonicalNorm === foundNorm) {
        return { type: 'exact_match', severity: 'low', confidence: 0.99 };
    }

    const similarity = stringSimilarity.compareTwoStrings(canonicalNorm, foundNorm);
    const prefixVariant = canonicalNorm.startsWith(foundNorm) || foundNorm.startsWith(canonicalNorm);
    const likelyMinorVariant = similarity >= 0.82 || prefixVariant;

    if (likelyMinorVariant) {
        return { type: 'fuzzy_match', severity: 'low', confidence: Math.max(similarity, 0.65) };
    }

    return { type: 'mismatch', severity: 'high', confidence: Math.max(similarity, 0.2) };
}

function normalizeAiResults(rawResults) {
    const normalizedResults = {};
    const entries = Object.entries(rawResults || {});

    entries.forEach(([fieldKey, fieldData]) => {
        if (!fieldData || typeof fieldData !== 'object') return;

        const canonical = fieldData.canonical || fieldData.canonical_value || '';
        const fieldType = fieldData.type || 'entity';
        const rawConflicts = Array.isArray(fieldData.conflicts) ? fieldData.conflicts : (Array.isArray(fieldData.target) ? fieldData.target : []);
        const conflicts = [];
        let fieldSeverity = 'low';

        rawConflicts.forEach((conflict) => {
            const url = conflict.url || conflict.source_url || conflict.source || '';
            const found = conflict.found || conflict.value || conflict.source || '';
            const snippet = conflict.snippet || '';
            const explicitType = conflict.type === 'fuzzy_match' || conflict.type === 'mismatch' ? conflict.type : null;
            const classified = classifyDifference(canonical, found);
            if (classified.type === 'exact_match') return;
            const type = explicitType || classified.type;

            const severity = type === 'fuzzy_match' ? 'low' : 'high';
            const confidence = typeof conflict.confidence === 'number' ? conflict.confidence : classified.confidence;

            if (severity === 'high') fieldSeverity = 'high';

            conflicts.push({
                url,
                found,
                type,
                severity,
                snippet,
                confidence
            });
        });

        if (conflicts.length === 0) return;

        normalizedResults[fieldKey] = {
            canonical,
            type: fieldType,
            severity: fieldSeverity,
            conflicts
        };
    });

    return normalizedResults;
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

        const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
        const payload = response.data;
        const looksLikeJson = contentType.includes('application/json') || typeof payload === 'object';

        if (looksLikeJson) {
            const snapshot = typeof payload === 'string' ? JSON.parse(payload) : payload;
            const flattened = flattenCanonicalSnapshot(snapshot);
            return {
                url,
                extracted_text: flattened.extractedText.substring(0, 15000),
                chunksArray: flattened.extractedText.split('\n').filter(Boolean),
                chunks: flattened.extractedText.length ? flattened.extractedText.split('\n').filter(Boolean).length : 0,
                derived_fields: flattened.derivedFields,
                canonical_meta: flattened.metadata,
                success: true
            };
        }

        const $ = cheerio.load(String(payload));

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
            extractedText = $('body').text().replace(/\s+/g, ' ').trim();
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
            severity: "low",
            type: field.toLowerCase().includes('year') ? 'date' : field.toLowerCase().includes('phone') ? 'contact' : 'entity',
            conflicts: []
        };

        // Check Targets against Canonical
        targetsData.forEach(target => {
            const targetMatch = extractHeuristic(target.chunksArray, field);
            if (!targetMatch) return; // Not found on this page

            const classified = classifyDifference(canonicalMatch.value, targetMatch.value);
            if (classified.type === 'exact_match') return;

            const matchType = classified.type;
            const severity = classified.severity;
            if (severity === 'high') fieldResult.severity = 'high';

            fieldResult.conflicts.push({
                url: target.url,
                found: targetMatch.value,
                type: matchType,
                severity,
                snippet: targetMatch.snippet,
                confidence: classified.confidence
            });
        });

        if (fieldResult.conflicts.length > 0) {
            results[toFieldKey(field)] = fieldResult;
        }
    });

    return results;
}

function buildFieldMatrix(canonicalData, targetsData, fields, conflictResults = {}) {
    const matrix = {};
    const resultsEntries = Object.entries(conflictResults || {});

    const findAiField = (field) => {
        const key = toFieldKey(field);
        if (conflictResults[key]) return conflictResults[key];
        if (conflictResults[field]) return conflictResults[field];

        let best = null;
        let bestScore = 0;
        resultsEntries.forEach(([candidateKey, candidateValue]) => {
            const score = stringSimilarity.compareTwoStrings(
                key.replace(/_/g, ' '),
                String(candidateKey || '').replace(/_/g, ' ')
            );
            if (score > bestScore) {
                bestScore = score;
                best = candidateValue;
            }
        });
        return bestScore >= 0.74 ? best : null;
    };

    fields.forEach((field) => {
        const fieldKey = toFieldKey(field);
        const aiField = findAiField(field);
        const canonicalMatch = extractHeuristic(canonicalData.chunksArray, field);
        const canonical = aiField?.canonical || canonicalMatch?.value || '';
        const fieldType = aiField?.type || inferFieldType(field);
        let fieldSeverity = aiField?.severity || 'low';

        const conflictsByUrl = new Map(
            (aiField?.conflicts || []).map((conflict) => [conflict.url, conflict])
        );

        const comparisons = targetsData.map((target) => {
            const aiConflict = conflictsByUrl.get(target.url);
            const targetMatch = extractHeuristic(target.chunksArray, field);

            if (aiConflict) {
                const aiFound = aiConflict.found || '';
                const canonicalForCheck = canonical || aiField?.canonical || '';
                const exactCheck = classifyDifference(canonicalForCheck, aiFound);
                if (exactCheck.type === 'exact_match') {
                    return {
                        url: target.url,
                        found: aiFound,
                        type: 'exact_match',
                        severity: 'low',
                        snippet: aiConflict.snippet || targetMatch?.snippet || '',
                        confidence: typeof aiConflict.confidence === 'number' ? aiConflict.confidence : exactCheck.confidence
                    };
                }

                return {
                    url: target.url,
                    found: aiFound,
                    type: aiConflict.type || 'mismatch',
                    severity: aiConflict.severity || 'high',
                    snippet: aiConflict.snippet || targetMatch?.snippet || '',
                    confidence: typeof aiConflict.confidence === 'number' ? aiConflict.confidence : undefined
                };
            }

            if (!targetMatch) {
                if (fieldSeverity !== 'high') fieldSeverity = 'medium';
                return {
                    url: target.url,
                    found: '',
                    type: 'not_found',
                    severity: 'medium',
                    snippet: '',
                    confidence: undefined
                };
            }

            if (!canonical) {
                if (fieldSeverity !== 'high') fieldSeverity = 'medium';
                return {
                    url: target.url,
                    found: targetMatch.value,
                    type: 'not_found',
                    severity: 'medium',
                    snippet: targetMatch.snippet,
                    confidence: undefined
                };
            }

            const classified = classifyDifference(canonical, targetMatch.value);
            if (classified.severity === 'high') {
                fieldSeverity = 'high';
            } else if (fieldSeverity !== 'high' && classified.type === 'fuzzy_match') {
                fieldSeverity = 'low';
            }

            return {
                url: target.url,
                found: targetMatch.value,
                type: classified.type,
                severity: classified.type === 'exact_match' ? 'low' : classified.severity,
                snippet: targetMatch.snippet,
                confidence: classified.confidence
            };
        });

        matrix[fieldKey] = {
            label: field,
            canonical,
            type: fieldType,
            severity: fieldSeverity,
            comparisons
        };
    });

    return matrix;
}
// ----------------------------------------------------


app.post('/api/scan', async (req, res) => {
    const { canonicalUrl, targetUrls, fields } = req.body;

    try {
        const normalizedTargetUrls = Array.isArray(targetUrls)
            ? targetUrls.map((url) => String(url || '').trim()).filter(Boolean)
            : [];
        const requestedFields = Array.isArray(fields)
            ? fields.map((field) => String(field || '').trim()).filter(Boolean)
            : [];

        if (!canonicalUrl || normalizedTargetUrls.length === 0) {
            return res.status(400).json({ error: 'canonicalUrl and at least one target URL are required.' });
        }

        const allUrls = [String(canonicalUrl).trim(), ...normalizedTargetUrls];

        // Step 1: Aggressive Text Extraction with Rate Limiting (DDoS Protection)
        console.log(`Crawling ${allUrls.length} URLs (Batching concurrency: 2)...`);

        // Use p-limit to prevent slamming the server with concurrent requests
        const limit = pLimit(2);
        const crawlPromises = allUrls.map((url, index) => limit(async () => {
            // Add a polite delay between starting requests if not the first one
            if (index > 0) {
                await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second "politeness" delay
            }
            return crawlUrl(url);
        }));

        const crawlResults = await Promise.all(crawlPromises);

        const canonicalData = crawlResults[0];
        const targetsData = crawlResults.slice(1);
        const fallbackFields = Array.isArray(canonicalData?.derived_fields) ? canonicalData.derived_fields : [];
        const effectiveFields = requestedFields.length > 0 ? requestedFields : fallbackFields;

        let structuredResults = {};
        const anthropicEnabled = isAnthropicEnabled();
        const ollamaEnabled = isOllamaEnabled();
        const promptText = buildPrompt(canonicalUrl, canonicalData, targetsData, effectiveFields);
        let engineUsed = "Local_Regex_Heuristic";

        if (anthropicEnabled) {
            // --- USE FULL CLAUDE AI LLM ---
            console.log("Valid Key detected. Analyzing with Anthropic Claude LLM...");
            const aiResponse = await anthropic.messages.create({
                model: ANTHROPIC_MODEL,
                max_tokens: 4096,
                temperature: 0,
                messages: [{ role: "user", content: promptText }]
            });

            const llmOutput = aiResponse.content[0].text;
            try {
                structuredResults = normalizeAiResults(parseResultsFromModelOutput(llmOutput));
                engineUsed = "Anthropic_Claude";
            } catch (e) {
                console.error("Failed to parse LLM JSON", e);
                return res.status(500).json({ error: "Failed to parse AI structure. Raw text: " + llmOutput });
            }
        } else if (ollamaEnabled) {
            // --- USE LOCAL OLLAMA AI LLM ---
            console.log(`Ollama enabled. Analyzing with local model: ${OLLAMA_MODEL}`);
            const ollamaResponse = await axios.post(`${OLLAMA_BASE_URL}/api/generate`, {
                model: OLLAMA_MODEL,
                prompt: promptText,
                stream: false,
                options: {
                    temperature: 0
                }
            }, {
                timeout: OLLAMA_TIMEOUT_MS
            });

            const llmOutput = ollamaResponse?.data?.response || '';
            try {
                structuredResults = normalizeAiResults(parseResultsFromModelOutput(llmOutput));
                engineUsed = `Ollama_${OLLAMA_MODEL}`;
            } catch (e) {
                console.error("Failed to parse Ollama JSON", e);
                return res.status(500).json({ error: "Failed to parse Ollama structure. Raw text: " + llmOutput });
            }
        } else {
            // --- USE FREE LOCAL HEURISTIC FALLBACK ---
            console.log("No valid API Key. Falling back to Local Heuristic NLP Engine...");
            structuredResults = runLocalEngine(canonicalData, targetsData, effectiveFields);
        }

        const discoveredFields = Object.keys(structuredResults || {}).map((key) =>
            key.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
        );
        const finalFields = effectiveFields.length > 0 ? effectiveFields : discoveredFields;
        const fieldMatrix = buildFieldMatrix(canonicalData, targetsData, finalFields, structuredResults);
        const canonicalMeta = {
            url: canonicalData?.url || String(canonicalUrl || ''),
            source: canonicalData?.canonical_meta?.source || 'web_page',
            generatedAt: canonicalData?.canonical_meta?.generatedAt || null,
            slug: canonicalData?.canonical_meta?.slug || null,
            title: canonicalData?.canonical_meta?.title || null,
            version: canonicalData?.canonical_meta?.version || null,
            lastReviewedAt: canonicalData?.canonical_meta?.lastReviewedAt || null
        };

        res.json({
            raw_data: crawlResults,
            results: structuredResults,
            field_matrix: fieldMatrix,
            watched_fields: finalFields,
            canonical_meta: canonicalMeta,
            engine_used: engineUsed
        });
        lastEngineUsed = engineUsed;

    } catch (error) {
        console.error(error);
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
