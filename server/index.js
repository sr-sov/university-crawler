require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const stringSimilarity = require('string-similarity');
const pLimit = require('p-limit');
const { Anthropic } = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY || 'fake_key',
});

async function crawlUrl(url) {
    try {
        const response = await axios.get(`https://r.jina.ai/${url}`, {
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 30000
        });

        let extractedText = "";

        if (response.data && response.data.data && response.data.data.content) {
            extractedText = response.data.data.content;
        }

        const chunks = extractedText.split(/\n\s*\n/).map(chunk => chunk.replace(/\s+/g, ' ').trim()).filter(chunk => chunk.length > 10);

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

        const IS_KEY_VALID = process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.includes('your_api_key');

        let structuredResults = {};

        if (IS_KEY_VALID) {
            // --- USE FULL CLAUDE AI LLM ---
            console.log("Valid Key detected. Analyzing with Anthropic Claude LLM...");
            const fieldsDescription = fields.join(', ');
            let promptText = `You are an automated data consistency verifier. Your job is to extract facts from unstructured web raw text dumps, and compare secondary domains against the primary canonical truth.\n\n`;
            promptText += `AUTHORITATIVE SOURCE (CANONICAL): URL: ${canonicalUrl}\n---\n${canonicalData.extracted_text}\n---\n\n`;
            promptText += `TARGET SOURCES TO VERIFY:\n`;
            targetsData.forEach((target, i) => {
                promptText += `Source ${i + 1}: URL: ${target.url}\n---\n${target.extracted_text}\n---\n\n`;
            });
            promptText += `Please analyze the target sources against the canonical source. Look specifically to verify consistency regarding these conceptual fields: ${fieldsDescription}.\n\n`;
            promptText += `Rules:\n1. Normalize semantic variations (e.g. "Dr. Sarah Thompson" is a fuzzy_match to "Sarah Thompson", but "Dan Rivera" is a mismatch).\n2. Output strict JSON with NO Markdown formatting whatsoever, just the JSON string starting with {"results": ...}\n`;

            const aiResponse = await anthropic.messages.create({
                model: "claude-3-5-sonnet-20241022",
                max_tokens: 4096,
                temperature: 0,
                messages: [{ role: "user", content: promptText }]
            });

            const llmOutput = aiResponse.content[0].text;
            try {
                const jsonStr = llmOutput.substring(llmOutput.indexOf('{'), llmOutput.lastIndexOf('}') + 1);
                structuredResults = JSON.parse(jsonStr).results || {};
            } catch (e) {
                console.error("Failed to parse LLM JSON", e);
                return res.status(500).json({ error: "Failed to parse AI structure. Raw text: " + llmOutput });
            }
        } else {
            // --- USE FREE LOCAL HEURISTIC FALLBACK ---
            console.log("No valid API Key. Falling back to Local Heuristic NLP Engine...");
            structuredResults = runLocalEngine(canonicalData, targetsData, fields);
        }

        res.json({
            raw_data: crawlResults,
            results: structuredResults,
            engine_used: IS_KEY_VALID ? "Anthropic_Claude" : "Local_Regex_Heuristic"
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Universiy Recon Crawler Backend running on port ${PORT}`);
});
