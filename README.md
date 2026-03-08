# 🎓 University Data Recon Engine

A comprehensive web-scraping and data reconciliation tool built to find inconsistencies across large, unstructured academic web ecosystems. 

Unlike traditional web scrapers that rely on fragile CSS selectors, this engine **extracts raw visible text** from target subdomains and uses **Semantic Intelligence** to cross-examine facts against a defined authoritative "Canonical Truth".

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

## 🔮 Future Improvements Roadmap

The architecture is built to easily support the following future upgrades:

1. **Self-Hosted Open Source LLM Support (On-Premises AI)**
   Instead of using Anthropic's cloud APIs, the backend can easily be adapted to query local models running on your own hardware via **Ollama** or **vLLM**. 
   - *Why do this?* It gives you 100% data privacy and 0 API costs. 
   - *Models to use:* `Llama-3-8B-Instruct` or `Mistral-7B` are highly capable of the JSON fact-extraction required by this app, and can run natively on a standard Macbook or PC with a decent GPU. We would just change the Axios request in `server/index.js` to point to `http://localhost:11434/api/generate`.

2. **Puppeteer / Playwright Integration**
   - The current backend uses `axios` and `cheerio`. This is incredibly fast but cannot render Single Page Applications (SPAs) built with modern frameworks. Upgrading the crawler to spawn headless browsers would allow extraction from Javascript-heavy university portals.

3. **Vector Database Caching**
   - Hooking up a database like Pinecone or a local SQLite instance to store the vector embeddings of text chunks *after* they are scraped. This prevents needing to re-crawl static pages when comparing facts in the future.