# Walmart Company Enrichment Desktop App

A minimal, classy company data enrichment tool built with **Electron**, **HTML/CSS/JS**, and **Tailwind CSS**. Designed for Walmart-style workflows, it generates company profiles from just a company name by combining agentic web search with **OpenRouter + DeepSeek V4 Flash** LLM synthesis.

---

## Features

- 🧊 **Clean, minimal enterprise UI** with white/gray palette, subtle borders, and soft shadows
- 🔍 **Live search** across enriched companies
- ➕ **Add & enhance** companies with one click
- 🤖 **Agentic web search** across free sources (Wikipedia, official website, DuckDuckGo, SEC EDGAR)
- 🧠 **LLM synthesis** via OpenRouter using `deepseek/deepseek-v4-flash`
- ⚙️ **Settings page** to enter and test your OpenRouter API key
- 🗂️ **Detail sidebar** with:
  - Headquarters, employee count, founded year
  - Key stakeholders with roles and emails
  - Latest published revenue
  - Funding history
  - Key products / services, description, website
- 💾 **Local JSON persistence** via secure IPC (renderer never touches Node.js or the filesystem)
- 🗑️ **Delete** companies from the dashboard and detail panel
- 🌙 **Empty & loading states** with live agent progress

---

## Tech Stack

- Electron (main + renderer + preload)
- Vanilla HTML / CSS / JavaScript
- Tailwind CSS v3
- Node.js / npm
- OpenRouter API for LLM inference
- Local JSON persistence through `ipcMain` / `ipcRenderer`

---

## Project Structure

```
walmart_desktop_app/
├── main.js                          # Electron main process
├── preload.js                       # Secure contextBridge preload
├── package.json                     # Dependencies & scripts
├── tailwind.config.js               # Tailwind content paths
├── README.md                        # This file
├── dist/
│   └── styles.css                   # Generated Tailwind CSS (gitignored)
└── src/
    ├── index.html                   # Dashboard + settings UI
    ├── styles.css                   # Tailwind directives + brutalist theme utilities
    ├── renderer.js                  # Frontend logic
    ├── store.js                     # Persistence wrapper over IPC (companies)
    └── main/
        ├── enrichment.js            # Agentic web search + LLM synthesis orchestrator
        ├── llm.js                   # OpenRouter / DeepSeek V4 Flash integration
        └── settings-store.js        # Settings persistence (API key)
```

---

## Getting Started

### 1. Install dependencies

```bash
npm install
```

The `postinstall` script also builds the Tailwind CSS output file.

### 2. Configure OpenRouter (optional but recommended)

1. Create a free account at [openrouter.ai](https://openrouter.ai).
2. Copy your API key from the dashboard.
3. Run the app and open **Settings** from the header gear icon.
4. Paste your API key and click **Test Connection**, then **Save Settings**.

If no API key is configured, the app falls back to local heuristic aggregation of the web-search results.

### 3. Run in development

```bash
npm run dev
```

This command:

1. Builds `dist/styles.css` from `src/styles.css`
2. Launches the Electron app

### 4. Watch Tailwind during development

```bash
npm run watch-css
```

Leave this running in a separate terminal while you edit `src/styles.css` or any Tailwind classes.

---

## Enrichment Flow

1. You enter a company name and click **Enhance**.
2. The coordinator dispatches source agents in parallel:
   - **WikipediaAgent** — fetches the company intro summary
   - **WebsiteAgent** — finds the official site via DuckDuckGo and scrapes homepage + `/about`
   - **EDGARAgent** — checks SEC filings for public US companies
   - **DuckDuckGoAgent** — general web search fallback
3. If an OpenRouter API key is saved, the gathered context is sent to **DeepSeek V4 Flash** to synthesize a structured profile.
4. If the LLM call fails or no key is saved, the app falls back to local heuristic aggregation.
5. The final profile is saved locally and shown in the dashboard.

---

## Build & Package

### Build CSS only

```bash
npm run build-css
```

### Package the app (electron-builder)

```bash
npm run build
```

Packaged artifacts are placed in the `release/` directory.

---

## Persistence

Companies and settings are stored in JSON files inside Electron's `userData` directory:

- **macOS**: `~/Library/Application Support/walmart-company-enrichment/`
- **Windows**: `%APPDATA%/walmart-company-enrichment/`
- **Linux**: `~/.config/walmart-company-enrichment/`

Files:

- `companies.json` — enriched company profiles
- `settings.json` — OpenRouter API key and future preferences

All reads/writes go through the main process via IPC. The renderer never accesses Node.js or the filesystem directly.

---

## Security Notes

- `nodeIntegration` is **disabled**.
- `contextIsolation` is **enabled**.
- Only a small API is exposed through `preload.js` (`loadCompanies`, `saveCompanies`, `loadSettings`, `saveSettings`, `testOpenRouter`, `enrichCompany`, progress events).
- The OpenRouter API key is stored in the local settings JSON file in the app's user data directory and is never sent to the renderer or browser storage.
- A Content Security Policy is set in `src/index.html`.

---

## Limitations

- DuckDuckGo Lite HTML scraping and SEC EDGAR parsing are fragile and may break if those sites change.
- Free-tier OpenRouter models may have rate limits or availability issues.
- The app respects SEC's User-Agent policy; the default placeholder should be updated if you distribute the app.

---

## License

MIT
