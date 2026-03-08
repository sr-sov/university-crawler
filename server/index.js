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
    promptText += `Rules:\n1. Normalize semantic variations (e.g. "Dr. Sarah Thompson" is a fuzzy_match to "Sarah Thompson", but "Dan Rivera" is a mismatch).\n2. Output strict JSON with NO Markdown formatting and no extra prose. Start with {"results": ...}\n`;
    return promptText;
}

function parseResultsFromModelOutput(outputText) {
    const jsonStr = outputText.substring(outputText.indexOf('{'), outputText.lastIndexOf('}') + 1);
    return JSON.parse(jsonStr).results || {};
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

    try {
        const allUrls = [canonicalUrl, ...targetUrls];

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

        let structuredResults = {};
        const anthropicEnabled = isAnthropicEnabled();
        const ollamaEnabled = isOllamaEnabled();
        const promptText = buildPrompt(canonicalUrl, canonicalData, targetsData, fields);
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
                structuredResults = parseResultsFromModelOutput(llmOutput);
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
                timeout: 120000
            });

            const llmOutput = ollamaResponse?.data?.response || '';
            try {
                structuredResults = parseResultsFromModelOutput(llmOutput);
                engineUsed = `Ollama_${OLLAMA_MODEL}`;
            } catch (e) {
                console.error("Failed to parse Ollama JSON", e);
                return res.status(500).json({ error: "Failed to parse Ollama structure. Raw text: " + llmOutput });
            }
        } else {
            // --- USE FREE LOCAL HEURISTIC FALLBACK ---
            console.log("No valid API Key. Falling back to Local Heuristic NLP Engine...");
            structuredResults = runLocalEngine(canonicalData, targetsData, fields);
        }

        res.json({
            raw_data: crawlResults,
            results: structuredResults,
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
