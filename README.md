# 🎓 University Data Recon Engine

A comprehensive web-scraping and data reconciliation tool built to find inconsistencies across large, unstructured academic web ecosystems. 

Unlike traditional web scrapers that rely on fragile CSS selectors, this engine **extracts raw visible text** from target subdomains and uses **Semantic Intelligence** to cross-examine facts against a defined authoritative "Canonical Truth".

## 📌 Maintainer Onboarding

For agent/maintainer context on current architecture, matching strategy, and roadmap:

- [`CANON_API.md`](./CANON_API.md) — canonical API contract and field-by-field matching spec
- [`JULES_HANDOFF.md`](./JULES_HANDOFF.md) — implementation status, design intent, and next-step priorities

## 🚀 Two-Tier Content Resolution System

The backend architecture automatically switches between two resolution engines based on your environment:

### Engine 1: Free Local Heuristics (Default)
Out of the box, the tool uses a robust built-in heuristic engine.
- **How it works:** It uses Node.js `cheerio` to strip HTML down to pure chunked text arrays, then applies dynamic Regex patterns linked to context-keywords (e.g. tracking "President", "Locations", "Years").
- **Resolution:** Facts found across subdomains are scored against the Canonical Truth using Levenshtein distance algorithms (via `string-similarity`).
- **Cost:** 100% Free. Runs locally on your machine.
- **Tradeoff:** Regex-based heuristics can occasionally misinterpret complex phrasing or miss highly abstracted references.

### Engine 2: Anthropic Claude 3.5 LLM (Recommended)
For production-grade intelligence, the system utilizes an API key to parse the raw text chunks directly using one of the most powerful LLMs in the world.
- **How it works:** The engine passes the unstructured DOM-removed text blobs to Anthropic. The AI dynamically understands context, formatting differences, and nuance, standardizing semantic variations instantly.
- **Resolution:** The AI maps facts across documents and explicitly highlights mismatches with confidence scores, returning strict JSON directly to the frontend interface.
- **Cost:** Costs fractions of a penny per crawled page via Anthropic's API pricing.

### Engine 3: Ollama Local LLM (Self-Hosted)
When enabled, Ollama uses the same semantic extraction pipeline as Anthropic but runs entirely on your machine.
- **How it works:** The backend sends cleaned text chunks to your local Ollama model through `http://localhost:11434/api/generate`.
- **Resolution:** The model returns structured JSON with canonical values and per-target conflicts.
- **Cost:** $0 API spend after model download (local compute only).

---

## 🎯 Matching & Severity Rules

All engines compare each target page against the canonical source and classify differences with the same intent:

- **Exact Match:** Same normalized value. Not flagged as a conflict.
- **Fuzzy Match (Low Severity):** Minor spelling/title/format variants (for example `Sarah` vs `Sara`, `Sarah` vs `Sarah C`).
- **Mismatch (High Severity):** Clearly different values (for example `Sarah` vs `Dan`).

### Local Heuristic Engine
- Uses Regex extraction plus `string-similarity`.
- Applies normalization before comparison (case/punctuation/title cleanup).
- Emits conflict-level fields: `type`, `severity`, `confidence`, `snippet`.
- Field severity is escalated to `high` if any conflict is a `mismatch`; otherwise it remains `low` for fuzzy-only conflicts.

### Anthropic / Ollama Engines
- Prompt enforces strict JSON output and requires explicit conflict classification.
- Backend post-processes model output to normalize shape and apply fallback classification if type/severity is missing.
- This keeps typo/variant handling consistent with local heuristics and prevents model-format drift from breaking UI interpretation.

---

## 🛡️ Polite Crawling & Safety (DDoS Protection)

University websites often have aggressive rate-limiters and security filters. To ensure you don't inadvertently trigger a DDoS alert or get your IP blacklisted:

- **Concurrency Limit:** The backend is configured to crawl a maximum of **2 URLs simultaneously**.
- **Polite Delays:** The engine waits for **1 second** between starting each new request in a batch.
- **Customizable:** You can adjust these safety thresholds in `server/index.js` by modifying the `pLimit` value and the `setTimeout` delay within the scan route.

---

## 🛠️ Installation & Setup

1. **Install Frontend Dependencies:**
   ```bash
   npm install
   ```

2. **Install Backend Dependencies:**
   ```bash
   cd server
   npm install
   ```

3. **Start the Scraper API Backend:**
   ```bash
   cd server
   node index.js
   # Running on port 3000
   ```

4. **Start the React Frontend Dashbaord:**
   ```bash
   # In the root directory
   npm run dev
   # Running on port 5173
   ```

---

## 🔑 Upgrading to Artificial Intelligence

To unlock the semantic comparison engine and disable the local heuristics fallback:

1. Navigate to the `/server/` directory.
2. Copy `.env.example` to `.env`.
3. Paste your Anthropic API Key inside:
   ```env
   ANTHROPIC_API_KEY=sk-ant-api03...
   ```
4. Restart the node server. The frontend UI will automatically show `Powered by Claude AI` when you run your next Audit!

---

## 🧠 Local AI with Ollama (No API Costs)

You can now run the semantic comparison engine locally through Ollama.

1. **Install Ollama**
   ```bash
   brew install ollama
   ```

2. **Start the Ollama service**
   ```bash
   ollama serve
   ```

3. **Pull a local model (in a new terminal)**
   ```bash
   ollama pull llama3.1:8b-instruct-q4_K_M
   ```

4. **Configure backend env**
   ```bash
   cd server
   cp .env.example .env
   ```
   Then set:
   ```env
   OLLAMA_ENABLED=true
   OLLAMA_BASE_URL=http://localhost:11434
   OLLAMA_MODEL=llama3.1:8b-instruct-q4_K_M
   ```

5. **Restart backend**
   ```bash
   cd server
   node index.js
   ```

When enabled, the API response includes `engine_used` like `Ollama_<model>`.
You can also verify setup health from:
- Backend: `GET http://localhost:3000/api/health`
- Frontend: **AI Model Health & Setup** panel (includes Anthropic configured/used and Ollama connectivity/model status)

---

## 🔮 Future Improvements Roadmap

The architecture is built to easily support the following future upgrades:

1. **vLLM Integration (Alternative Local Inference Runtime)**
   - Add drop-in support for vLLM endpoints as an alternative to Ollama for higher throughput or multi-GPU setups.

2. **Puppeteer / Playwright Integration**
   - The current backend uses `axios` and `cheerio`. This is incredibly fast but cannot render Single Page Applications (SPAs) built with modern frameworks. Upgrading the crawler to spawn headless browsers would allow extraction from Javascript-heavy university portals.

3. **Vector Database Caching**
   - Hooking up a database like Pinecone or a local SQLite instance to store the vector embeddings of text chunks *after* they are scraped. This prevents needing to re-crawl static pages when comparing facts in the future.
