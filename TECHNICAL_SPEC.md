# Technical Specification: Company Enrichment Desktop Application

> **Audience:** Product owners, developers, and AI coding assistants rebuilding or modernizing the application.  
> **Purpose:** Provide a complete, provider-agnostic technical blueprint for a stable, maintainable rewrite.  
> **Scope:** Architecture, data models, modules, integrations, security, and build/deployment guidance.  
> **Exclusions:** API keys, credentials, proprietary prompts, and vendor-specific pricing.

---

## 1. Executive Summary

The application is a desktop tool for **company data enrichment**. A user enters or uploads a list of company names; the application gathers publicly available information from the web and synthesizes a structured profile for each company.

### Primary Enriched Fields

| Field | Description | Typical Sources |
|-------|-------------|-----------------|
| Headquarters | City, state/region, country | Company website, Wikipedia, public registries |
| Employee Count | Number of employees | Wikipedia infobox, company website, business directories |
| Year Established | Founding year | Wikipedia, company website |
| Latest Published Revenue | Most recent annual revenue with year | SEC filings, finance sites, company reports |
| Net Income | Most recent net income (public companies) | SEC filings, finance sites |
| Funding Received | Total known funding (private companies) | Business directories, press releases |
| Key Stakeholders | Executives, leaders, founders | Company website leadership pages, Wikipedia |
| Stakeholder Emails | Inferred or discovered emails | Pattern inference from company domain |
| LinkedIn Presence | Search links or resolved profiles for stakeholders | Web search, pattern matching |
| Industry | Industry classification | Wikipedia, company website |
| Official Website | Primary domain | Search engine results, domain inference |

The application also includes an **agentic deep-research capability** for individual companies: an iterative web-research loop that searches, evaluates source sufficiency, follows discovered URLs, and synthesizes a cited answer.

---

## 2. Core Requirements

### Functional Requirements

1. **Single-company enrichment** — Type a company name, run enrichment, view a structured profile.
2. **Bulk enrichment via Excel** — Upload an `.xlsx` file, auto-detect the company-name column, preview rows, enrich all rows with progress tracking, and export results.
3. **Job resume** — Bulk enrichment state is persisted after each row so the job can resume after app restart.
4. **Company management** — View all enriched companies in a searchable grid, open a detail modal, re-fetch, run deep research, or delete.
5. **Settings** — Configure external service credentials (e.g., LLM API keys) and persistence location.
6. **User profile** — Save user's name, team/role, default company column header, and default export columns.
7. **Source transparency** — A "What happened behind the scenes" panel shows raw or summarized data from each agent/source.

### Non-Functional Requirements

1. **Desktop-only** — Runs as a native desktop application (originally Electron).
2. **Security-first renderer** — Renderer process has no direct network or filesystem access; all I/O goes through a secure IPC bridge.
3. **No hard-coded credentials** — API keys and secrets are entered via UI and stored locally.
4. **Provider-agnostic LLM layer** — The LLM client must be swappable across providers (OpenAI-compatible, Anthropic, local models, etc.).
5. **Offline resilience** — Graceful degradation when external services fail or are unconfigured.
6. **Minimal, enterprise UI** — Light/neutral palette, clean typography, no unnecessary effects.

---

## 3. Architecture

### 3.1 High-Level Pattern

```
┌─────────────────────────────────────────────────────────────┐
│                        Electron App                          │
│  ┌──────────────────────┐      ┌─────────────────────────┐  │
│  │   Renderer Process   │      │     Main Process        │  │
│  │  (UI: HTML/CSS/JS)   │◄────►│  (I/O, network, LLM)    │  │
│  │   contextIsolation   │ IPC  │  nodeIntegration: false │  │
│  └──────────────────────┘      └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Process Responsibilities

#### Renderer Process

- Render the UI.
- Capture user input.
- Invoke main-process capabilities through a narrow, allow-listed IPC bridge.
- Display progress, results, and errors.
- **Must not** call `fetch`, `fs`, or any Node.js/Electron APIs directly.

#### Main Process

- All HTTP requests.
- File system operations (settings, company store, bulk job state, Excel I/O).
- LLM API calls.
- External service orchestration (search engines, SEC EDGAR, etc.).
- Structured data extraction and synthesis.

### 3.3 IPC Design

Use a single, explicit allow-list of invokable channels. Each channel follows a consistent response shape:

```ts
interface IpcResponse<T> {
  success: boolean
  data?: T
  error?: string
}
```

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `load-companies` | main → renderer | Load saved company profiles |
| `save-companies` | renderer → main | Persist company profiles |
| `load-settings` | main → renderer | Load app settings |
| `save-settings` | renderer → main | Persist settings |
| `test-llm` | renderer → main | Validate configured LLM credentials |
| `enrich-company` | renderer → main | Enrich a single company |
| `deep-research-company` | renderer → main | Run agentic deep research |
| `parse-excel` | renderer → main | Parse uploaded Excel file |
| `export-excel` | renderer → main | Write enriched rows to Excel |
| `show-save-dialog` | renderer → main | Native save dialog |
| `load-profile` / `save-profile` | bidirectional | User profile & export defaults |
| `load-bulk-job` / `save-bulk-job` / `clear-bulk-job` | bidirectional | Bulk job persistence |

Progress events use a separate publish channel (e.g., `enrich-progress`) that the renderer subscribes to.

---

## 4. Technology Stack

### Core

| Layer | Technology | Notes |
|-------|------------|-------|
| Desktop shell | Electron | Latest stable LTS |
| Frontend | Vanilla HTML, CSS, JavaScript | No React; keep bundle tiny |
| Styling | Tailwind CSS | Utility-first; custom enterprise palette |
| Build pipeline | npm scripts | CSS build, dev launch, packaging |

### Main-Process Libraries

| Purpose | Library Type | Notes |
|---------|--------------|-------|
| HTML parsing | Cheerio or similar | Lightweight server-side jQuery API |
| Excel I/O | SheetJS (`xlsx`) | Parse and write `.xlsx` in main process only |
| HTTP client | Native `fetch` | Use timeout wrappers and signal aborts |

### External Services (Free/Public)

| Service | Purpose | Notes |
|---------|---------|-------|
| DuckDuckGo HTML search | Web discovery | Parse result pages; respect rate limits |
| SEC EDGAR | Public company financials | Use `companyfacts` XBRL API; provide a compliant User-Agent |
| Wikipedia API | General company data | REST or action API for summaries + infobox |
| Company websites | HQ, leadership, about | Crawl homepage + standard paths |
| Generic web pages | Deep research sources | Fetch and extract article/main content |

### LLM Provider Abstraction

The application uses a pluggable LLM client. The client must support:

- Chat/completion interface.
- Configurable base URL.
- Configurable model name.
- API key authentication.
- JSON-mode or manual JSON extraction fallback.
- Streaming optional but recommended for future UX improvements.

Examples of providers to design for:
- OpenAI-compatible endpoints.
- Anthropic Messages API.
- Local/self-hosted models (Ollama, vLLM, etc.).
- Any provider exposing a standard HTTP chat completion endpoint.

---

## 5. Project Structure

```
project-root/
├── main.js                     # Electron main entry; IPC registration; window creation
├── preload.js                  # Secure renderer API bridge
├── package.json
├── tailwind.config.js
├── src/
│   ├── index.html              # Application shell + pages + modal markup
│   ├── renderer.js             # All renderer logic
│   ├── styles.css              # Tailwind directives + custom utilities
│   ├── icons.js                # Inline SVG icon system
│   └── main/
│       ├── enrichment.js       # Core enrichment agents + aggregator
│       ├── agentic-search.js   # Iterative web research + structured extraction
│       ├── llm.js              # Pluggable LLM client
│       ├── settings-store.js   # Settings persistence
│       ├── company-store.js    # (Optional) Company JSON persistence helper
│       ├── excel.js            # Excel parse/export
│       └── bulk-store.js       # Bulk enrichment job persistence
```

---

## 6. Data Models

### 6.1 Company Profile

```ts
interface CompanyProfile {
  id: string                    // UUID or stable hash
  name: string                  // Normalized company name
  initials: string              // 1-2 letter initials for avatars
  description?: string
  website?: string
  industry?: string
  headquarters?: string
  employeeCount?: number
  foundedYear?: number
  revenue?: RevenueInfo
  netIncome?: RevenueInfo
  funding?: FundingInfo
  keyStakeholders?: Stakeholder[]
  emails?: string[]             // Discovered/inferred emails
  sources?: Source[]            // Citation list
  enrichedAt: string            // ISO 8601 timestamp
  _agentDetails?: AgentDetails  // Raw/summarized per-agent results
}

interface RevenueInfo {
  amount: string                // e.g., "$416.2 billion"
  year?: number
  source?: string               // Human-readable source
}

interface FundingInfo {
  amount: string                // e.g., "$100 million"
  source?: string
}

interface Stakeholder {
  name: string
  role?: string
  email?: string
  emailInferred?: boolean       // true if email was pattern-inferred
  linkedIn?: string             // Resolved or search URL
}

interface Source {
  title?: string
  url: string
  description?: string
}

interface AgentDetails {
  Wikipedia?: AgentResult
  Website?: AgentResult
  EDGAR?: AgentResult
  Finance?: AgentResult
  DuckDuckGo?: AgentResult
  deepResearch?: AgentResult
}

interface AgentResult {
  source: string
  found: boolean
  data: any
}
```

### 6.2 Settings

```ts
interface AppSettings {
  llmProvider?: string          // e.g., "openai-compatible", "anthropic", "ollama"
  llmBaseUrl?: string           // Optional custom endpoint
  llmModel?: string             // Model identifier
  llmApiKey?: string            // Stored encrypted or in OS keychain (recommended)
  userDataPath?: string         // Optional override
}
```

### 6.3 User Profile

```ts
interface UserProfile {
  name?: string
  team?: string
  role?: string
  defaultCompanyColumn?: string // Default Excel column header for company names
  defaultExportColumns?: string[]
}
```

### 6.4 Bulk Enrichment Job

```ts
interface BulkJob {
  fileName: string
  companyColumn: string
  rows: BulkRow[]
  inProgress: boolean
  currentIndex: number
  results: BulkRow[]
}

interface BulkRow {
  [column: string]: any
  _enriched?: CompanyProfile
  _status?: 'pending' | 'enriching' | 'done' | 'error'
  _error?: string
}
```

---

## 7. Module Specifications

### 7.1 IPC Bridge (`preload.js`)

- Define an allow-list array of channel names.
- Expose only explicitly needed methods on `window.electronAPI`.
- Use `ipcRenderer.invoke` for request/response channels.
- Use `ipcRenderer.on` for progress subscriptions.
- Never expose `ipcRenderer` directly.

### 7.2 Settings Store

- Persist settings to a JSON file in the app's `userData` directory.
- Provide `loadSettings()` and `saveSettings(settings)`.
- Return sensible defaults when the file does not exist.
- **Security note:** Store API keys in the OS keychain/credential store in a production rewrite; plain JSON is acceptable only for local prototypes.

### 7.3 Company Store

- Persist the enriched company array to a local JSON file.
- Provide load/save methods.
- Handle corrupted files gracefully (reset to empty array and log).

### 7.4 Excel Module

- `parseExcel(filePath): Row[]` — Read the first sheet and return an array of row objects.
- `findCompanyNameColumn(rows): string` — Heuristic detection of the column most likely to contain company names. Check common headers such as `company`, `company name`, `name`, `organization`, `employer`.
- `exportExcel(rows, destinationPath)` — Write rows to `.xlsx` with the user's selected export columns.

### 7.5 LLM Client (`llm.js`)

Design a provider-agnostic client with the following interface:

```ts
interface LLMClient {
  chat(messages: Message[], options?: ChatOptions): Promise<ChatResponse>
  test(): Promise<{ ok: boolean; message: string }>
  extractJson(text: string): any
}

interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ChatOptions {
  maxTokens?: number
  temperature?: number
  jsonMode?: boolean
}
```

Implementation guidance:
- Accept provider configuration from settings.
- Normalize request/response formats per provider.
- Provide a robust JSON extractor that handles Markdown code fences and trailing text.
- Implement a `test()` method that sends a minimal completion and validates the response.

### 7.6 Enrichment Engine (`enrichment.js`)

The enrichment engine coordinates multiple independent agents and aggregates their outputs.

#### Agent Pattern

Each agent implements:

```ts
interface EnrichmentAgent {
  source: string
  run(companyName: string, onProgress: (p: ProgressEvent) => void): Promise<AgentResult>
}
```

#### Core Agents

1. **WikipediaAgent**
   - Search Wikipedia for the company.
   - Fetch the page (intro + full article + infobox).
   - Extract: title, headquarters, employee count, founded year, revenue, net income, key stakeholders, industry.

2. **WebsiteAgent**
   - Discover the official website.
     - Try direct domain guesses from the company name.
     - Score search-engine results by name match.
     - Filter out app stores, marketplaces, and aggregator sites.
   - Crawl priority paths: `/about`, `/about-us`, `/company`, `/leadership`, `/team`, `/investors`, `/newsroom`, `/press`, `/media`, `/contact`, `/investor-relations`, `/executives`.
   - Extract: headquarters, employees, founded year, revenue, funding, stakeholders, emails, industry.
   - Infer stakeholder emails from the company domain and discovered patterns.
   - Generate LinkedIn search links for stakeholders; optionally resolve direct profile URLs for top stakeholders via web search.

3. **EdgarAgent**
   - Look up the CIK via SEC EDGAR search/lookup.
   - Fetch `companyfacts` JSON.
   - Extract latest 10-K revenue and net income from XBRL tags (`Revenues`, `SalesRevenueNet`, etc.).
   - Provide CIK, entity name, and filing links.

4. **FinanceAgent**
   - For public companies, fetch public finance pages.
   - Extract revenue, market cap, employee count.
   - Use as fallback when SEC data is unavailable.

5. **DuckDuckGo Fallback Agent**
   - Run targeted queries for missing fields.
   - Return top snippets and URLs.

#### Aggregation Logic

- Combine all agent results into a single profile.
- Define precedence rules per field, e.g.:
  - Revenue: SEC EDGAR > Wikipedia infobox > FinanceAgent > website text.
  - Headquarters: Website > Wikipedia.
  - Employees: Wikipedia infobox > Website > FinanceAgent.
  - Stakeholders: Website leadership pages > Wikipedia.
- Normalize values (remove extra whitespace, parse numbers, format currency consistently).
- Attach source citations to each field where possible.

### 7.7 Agentic Search / Deep Research (`agentic-search.js`)

#### Purpose

Performs iterative, LLM-directed web research for a single company and extracts a structured profile.

#### Algorithm

1. **Plan** — LLM breaks the query into sub-questions and initial web-search queries.
2. **Iterate** (up to a configurable maximum, e.g., 10):
   - Execute the next queued action: either a DuckDuckGo search or a specific URL visit.
   - Fetch pages, extract text and discovered links.
   - Skip challenge pages (CAPTCHA, Cloudflare, etc.).
   - If no queued actions remain, evaluate coverage.
3. **Evaluate** — LLM reviews gathered sources against sub-questions and decides:
   - Whether information is sufficient.
   - What details are missing.
   - Next actions: new search queries or specific URLs discovered on previous pages.
4. **Extract** — After sufficiency or max iterations, LLM extracts a structured profile from all sources.
5. **Synthesize** — Produce a final cited Markdown answer.

#### Deep Research for a Company

When invoked from the company modal:
- Build a targeted query containing all desired fields.
- Run the agentic loop.
- Extract structured data matching the `CompanyProfile` schema.
- Merge results into the existing company profile, preserving previously enriched data.

### 7.8 Bulk Enrichment

1. Parse Excel; detect company-name column.
2. Display preview rows.
3. On start:
   - Initialize or resume a `BulkJob`.
   - Loop through rows starting at `currentIndex`.
   - For each row: enrich, store result, save job state.
   - Update progress UI via IPC events.
4. On completion or pause: allow export with column picker.
5. Provide resume/discard actions for incomplete jobs.

---

## 8. UI/UX Specifications

### 8.1 Navigation

Left sidebar with pages:
- **Dashboard** — searchable grid of enriched companies.
- **Upload Data** — Excel upload, preview, bulk enrichment, export.
- **Profile** — user details and default export preferences.
- **Settings** — LLM provider configuration and connection test.

### 8.2 Dashboard

- Search input filters companies by name and industry.
- Company cards display: initials, name, industry, short description, HQ, employee count.
- Card actions (on hover/focus):
  - Open detail modal (default click).
  - Delete company.

### 8.3 Company Detail Modal

Sections:
- Header: name, industry, website link.
- Summary/description.
- Key facts: HQ, employees, founded year.
- Key stakeholders with email and LinkedIn buttons/links.
- Financials: revenue, net income, funding.
- Actions: Re-fetch, Deep Research, Delete.
- Collapsible "What happened behind the scenes" panel showing per-agent results.

### 8.4 Upload Data Page

- Drag-and-drop zone for `.xlsx` files.
- Company-name column auto-detection with manual override.
- Row preview table.
- Bulk enrich button with live progress.
- Per-job export column picker.
- Download enriched `.xlsx`.

### 8.5 Design System

- Neutral enterprise palette: white, light gray backgrounds, near-black text, subtle borders, soft shadows.
- Tailwind custom colors recommended: `enterprise-50` through `enterprise-900`, plus an accent color for links and primary actions.
- Inline SVG icon system (no external icon fonts due to CSP).

---

## 9. Security & Privacy

1. **Renderer isolation**
   - `contextIsolation: true`
   - `nodeIntegration: false`
   - `sandbox: true` if feasible.

2. **CSP**
   - Restrictive Content Security Policy:
     - `default-src 'self'`
     - `script-src 'self'`
     - `style-src 'self' 'unsafe-inline'` (required for Tailwind runtime if not pre-built)
     - `img-src 'self' data:`
     - No remote scripts, styles, or fonts.

3. **Credential storage**
   - API keys entered via Settings.
   - For prototypes: store in local JSON.
   - For production: store in OS credential store/keychain (e.g., `keytar` or Electron `safeStorage`).

4. **Network**
   - All HTTP requests in the main process.
   - Set reasonable timeouts and abort controllers.
   - Rotate/identify User-Agent strings where required by external services.

5. **Data handling**
   - Local JSON files in `userData`.
   - No telemetry or external logging unless explicitly configured.

---

## 10. Provider Integration Guide

### 10.1 Adding a New LLM Provider

1. Create a provider class implementing `LLMClient`.
2. Add provider key to settings schema (e.g., `llmProvider`).
3. In `llm.js`, route to the correct provider based on settings.
4. Implement request normalization:
   - Anthropic: Messages API format.
   - OpenAI-compatible: `/chat/completions` format.
   - Local models: same as OpenAI-compatible with custom base URL.
5. Implement `test()` to validate connectivity.
6. Update Settings UI to expose provider-specific fields (base URL, model, key).

### 10.2 Adding a New Search/Data Source

1. Create a new agent module or function.
2. Implement `run(companyName, onProgress)` returning `AgentResult`.
3. Register the agent in the enrichment aggregator.
4. Add precedence logic if the source affects existing fields.
5. Add a section in `renderAgentDetails` if source transparency is required.

### 10.3 Changing the Primary Search Engine

The agentic search module currently uses DuckDuckGo HTML search. To swap:
1. Replace `searchDuckDuckGo(query)` with an equivalent function returning `{ title, snippet, url }[]`.
2. Handle any redirect decoding or rate-limiting specific to the new engine.
3. Update result parsing (e.g., SerpAPI, Bing, Google custom search, Brave, etc.).

---

## 11. Build & Development

### 11.1 Scripts

```json
{
  "build-css": "tailwindcss -i ./src/styles.css -o ./dist/styles.css --minify",
  "dev": "npm run build-css && electron .",
  "start": "electron .",
  "package": "electron-builder"
}
```

### 11.2 Development Workflow

1. Run `npm install`.
2. Run `npm run dev` to build CSS and launch Electron.
3. Make renderer changes → refresh or relaunch.
4. Make main-process changes → relaunch Electron.

### 11.3 Tailwind Configuration

- Content paths: `src/index.html`, `src/renderer.js`.
- Custom theme extension for enterprise colors.
- Build output: `dist/styles.css`.

---

## 12. Testing Strategy

1. **Unit tests** for pure functions:
   - Column detection heuristics.
   - HTML text extraction.
   - Currency/number normalization.
   - JSON extraction from LLM output.
   - Source deduplication.

2. **Integration tests** for agents:
   - Mock external HTTP responses.
   - Verify each agent returns expected schema.
   - Verify aggregation precedence.

3. **End-to-end tests** (optional, with Playwright or Spectron successor):
   - Add a company, verify profile appears.
   - Upload Excel, run bulk enrichment, export.
   - Configure settings and test LLM connection.

4. **Manual test cases**
   - Public company (e.g., Apple, Microsoft): verify SEC revenue and net income.
   - Private company (e.g., Podean): verify graceful unknowns for revenue/funding.
   - Re-fetch: verify existing data is preserved and new data is merged.
   - Deep research: verify iterative search and source citations.

---

## 13. Deployment

### Packaging

- Use `electron-builder` or `electron-forge`.
- Target platforms: macOS, Windows, Linux.
- Exclude devDependencies and test files from the packaged app.

### Distribution

- Code-sign installers for macOS and Windows.
- Auto-updater optional but recommended for production.

---

## 14. Known Limitations & Improvement Areas

1. **External dependency fragility**
   - Web scraping is sensitive to HTML changes and bot protection.
   - Consider fallback search engines and caching.

2. **LLM cost and reliability**
   - Deep research can consume many tokens.
   - Add token budgets, retry logic, and timeout guards.

3. **Credential storage**
   - Move from JSON file to OS keychain in production.

4. **Scalability**
   - Bulk enrichment is sequential; consider concurrency limits if parallelized.

5. **Data accuracy**
   - Free sources often conflict; surface confidence scores and multiple values.

6. **Testing coverage**
   - Add automated tests for agents and aggregation logic.

7. **TypeScript migration**
   - Strongly recommended for a stable rewrite to enforce data contracts.

---

## 15. Recommended Roadmap

If building from this spec, consider the following order:

1. **Scaffold** Electron + Tailwind + secure preload bridge.
2. **Implement settings store** with provider-agnostic LLM config.
3. **Implement LLM client abstraction** with at least one provider.
4. **Implement company store** and dashboard grid.
5. **Build enrichment engine** one agent at a time (Wikipedia → Website → SEC → Finance → DuckDuckGo).
6. **Add company detail modal** with re-fetch, delete, and behind-the-scenes panel.
7. **Add Excel parse/export** and bulk enrichment with job persistence.
8. **Add agentic deep research** and integrate into the modal.
9. **Polish UI** and add responsive/keyboard-accessible interactions.
10. **Add tests**, migrate to TypeScript, harden credential storage, and package.

---

## 16. Appendix: Prompt Engineering Notes (Provider-Agnostic)

All LLM prompts should:
- Be explicit about the desired output format (JSON schema or Markdown).
- Include source context truncated to fit within model context limits.
- Instruct the model not to hallucinate facts not present in sources.
- Include a fallback parser that extracts JSON even if the model wraps it in Markdown fences or adds explanatory text.
- Add strict gaurdrails to make sure the extracted data is currect and true to the context. 

For a production developmen, centralize prompt templates in a dedicated module and version them alongside the code.

---

*End of technical specification.*
