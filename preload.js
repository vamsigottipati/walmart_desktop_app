const { contextBridge, ipcRenderer } = require('electron')

// Allowed channels that the renderer may invoke through the preload bridge.
const INVOKABLE_CHANNELS = [
  'load-companies',
  'save-companies',
  'load-settings',
  'save-settings',
  'test-openrouter',
  'enrich-company',
  'parse-excel',
  'export-excel',
  'show-save-dialog',
  'load-profile',
  'save-profile',
  'load-bulk-job',
  'save-bulk-job',
  'clear-bulk-job',
  'agentic-search'
]

// Expose a small, safe API surface to the renderer process.
contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * Helper to safely invoke an IPC channel that is allowed above.
   * @param {string} channel
   * @param {...any} args
   * @returns {Promise<any>}
   */
  _invoke: (channel, ...args) => {
    if (!INVOKABLE_CHANNELS.includes(channel)) {
      throw new Error(`IPC channel '${channel}' is not exposed to the renderer`)
    }
    return ipcRenderer.invoke(channel, ...args)
  },
  /**
   * Load all enriched companies from the local JSON store.
   * @returns {Promise<Array<object>>}
   */
  loadCompanies: () => ipcRenderer.invoke('load-companies'),

  /**
   * Persist the enriched companies list to the local JSON store.
   * @param {Array<object>} companies
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  saveCompanies: (companies) => ipcRenderer.invoke('save-companies', companies),

  /**
   * Load app settings from the local JSON store.
   * @returns {Promise<object>}
   */
  loadSettings: () => ipcRenderer.invoke('load-settings'),

  /**
   * Persist app settings to the local JSON store.
   * @param {object} settings
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  /**
   * Test an OpenRouter API key with a minimal chat completion.
   * @param {string} apiKey
   * @returns {Promise<{ok: boolean, message: string}>}
   */
  testOpenRouter: (apiKey) => ipcRenderer.invoke('test-openrouter', apiKey),

  /**
   * Run the agentic enrichment flow for a company name.
   * @param {string} name
   * @returns {Promise<{success: boolean, profile?: object, error?: string}>}
   */
  enrichCompany: (name) => ipcRenderer.invoke('enrich-company', name),

  /**
   * Parse an Excel file into row objects and identify the company-name column.
   * @param {string} filePath
   * @returns {Promise<{success: boolean, rows?: Array<object>, companyColumn?: string, error?: string}>}
   */
  parseExcel: (filePath) => ipcRenderer.invoke('parse-excel', filePath),

  /**
   * Write an array of objects to an Excel file.
   * @param {Array<object>} rows
   * @param {string} destinationPath
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  exportExcel: (rows, destinationPath) => ipcRenderer.invoke('export-excel', rows, destinationPath),

  /**
   * Show a native save dialog.
   * @param {object} options
   * @returns {Promise<{canceled: boolean, filePath?: string, error?: string}>}
   */
  showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),

  /**
   * Load the saved bulk enrichment job (if any), for resuming.
   * @returns {Promise<{success: boolean, job?: object|null}>}
   */
  loadBulkJob: () => ipcRenderer.invoke('load-bulk-job'),

  /**
   * Persist a bulk enrichment job.
   * @param {object} job
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  saveBulkJob: (job) => ipcRenderer.invoke('save-bulk-job', job),

  /**
   * Delete the saved bulk job.
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  clearBulkJob: () => ipcRenderer.invoke('clear-bulk-job'),

  /**
   * Load profile and export preferences.
   * @returns {Promise<{success: boolean, profile?: object, exportPreferences?: object, error?: string}>}
   */
  loadProfile: () => ipcRenderer.invoke('load-profile'),

  /**
   * Save profile and export preferences.
   * @param {{profile?: object, exportPreferences?: object}} payload
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  saveProfile: (payload) => ipcRenderer.invoke('save-profile', payload),

  /**
   * Run an agentic web search for a natural-language question.
   * @param {string} query
   * @returns {Promise<{success: boolean, result?: object, error?: string}>}
   */
  agenticSearch: (query) => ipcRenderer.invoke('agentic-search', query),

  /**
   * Subscribe to enrichment progress events from the main process.
   * @param {(progress: {source: string, status: string, message: string}) => void} callback
   */
  onEnrichProgress: (callback) => ipcRenderer.on('enrich-progress', (_event, value) => callback(value)),

  /**
   * Remove an enrichment progress listener.
   * @param {(progress: {source: string, status: string, message: string}) => void} callback
   */
  removeEnrichProgressListener: (callback) => ipcRenderer.removeListener('enrich-progress', callback),

  /**
   * Subscribe to agentic search progress events from the main process.
   * @param {(progress: {type: string, iteration?: number, query?: string, url?: string, message: string}) => void} callback
   */
  onAgenticSearchProgress: (callback) => ipcRenderer.on('agentic-search-progress', (_event, value) => callback(value)),

  /**
   * Remove an agentic search progress listener.
   * @param {(progress: {type: string, iteration?: number, query?: string, url?: string, message: string}) => void} callback
   */
  removeAgenticSearchProgressListener: (callback) => ipcRenderer.removeListener('agentic-search-progress', callback)
})
