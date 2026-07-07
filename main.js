const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
const path = require('path')
const fs = require('fs').promises
const { existsSync } = require('fs')
const { enrichCompany } = require('./src/main/enrichment')
const { loadSettings, saveSettings, DEFAULT_SETTINGS } = require('./src/main/settings-store')
const { testApiKey } = require('./src/main/llm')
const { parseExcel, findCompanyNameColumn, exportExcel } = require('./src/main/excel')
const { loadBulkJob, saveBulkJob, clearBulkJob } = require('./src/main/bulk-store')
const { performAgenticSearch } = require('./src/main/agentic-search')

// Path to the local JSON store inside the app's user data directory.
const STORE_FILE = path.join(app.getPath('userData'), 'companies.json')

async function ensureStore() {
  if (!existsSync(STORE_FILE)) {
    await fs.writeFile(STORE_FILE, JSON.stringify([], null, 2), 'utf8')
  }
}

async function loadCompanies() {
  try {
    await ensureStore()
    const raw = await fs.readFile(STORE_FILE, 'utf8')
    return JSON.parse(raw)
  } catch (err) {
    console.error('Failed to load companies:', err)
    return []
  }
}

async function saveCompanies(companies) {
  try {
    await fs.writeFile(STORE_FILE, JSON.stringify(companies, null, 2), 'utf8')
    return { success: true }
  } catch (err) {
    console.error('Failed to save companies:', err)
    return { success: false, error: err.message }
  }
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false // Required so preload can use ipcRenderer only (no Node).
    }
  })

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'))

  // Open external links in the user's default browser instead of a new Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

}

app.whenReady().then(() => {
  ipcMain.handle('load-companies', loadCompanies)
  ipcMain.handle('save-companies', (_event, companies) => saveCompanies(companies))
  ipcMain.handle('load-settings', () => loadSettings())
  ipcMain.handle('save-settings', (_event, settings) => saveSettings(settings))
  ipcMain.handle('test-openrouter', (_event, apiKey) => testApiKey(apiKey))
  ipcMain.handle('enrich-company', async (event, name) => {
    try {
      const profile = await enrichCompany(name, (progress) => {
        event.sender.send('enrich-progress', progress)
      })
      return { success: true, profile }
    } catch (err) {
      console.error('Enrichment failed:', err)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('parse-excel', async (_event, filePath) => {
    try {
      const rows = await parseExcel(filePath)
      const companyColumn = findCompanyNameColumn(rows)
      return { success: true, rows, companyColumn }
    } catch (err) {
      console.error('parse-excel failed:', err)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('export-excel', async (_event, rows, destinationPath) => {
    try {
      return await exportExcel(rows, destinationPath)
    } catch (err) {
      console.error('export-excel failed:', err)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('show-save-dialog', async (_event, options) => {
    try {
      const result = await dialog.showSaveDialog(options)
      return { canceled: result.canceled, filePath: result.filePath }
    } catch (err) {
      console.error('show-save-dialog failed:', err)
      return { canceled: true, error: err.message }
    }
  })

  ipcMain.handle('load-profile', async () => {
    try {
      const settings = await loadSettings()
      return {
        success: true,
        profile: settings.profile || DEFAULT_SETTINGS.profile,
        exportPreferences: settings.exportPreferences || DEFAULT_SETTINGS.exportPreferences
      }
    } catch (err) {
      console.error('load-profile failed:', err)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('save-profile', async (_event, { profile, exportPreferences }) => {
    try {
      return await saveSettings({ profile, exportPreferences })
    } catch (err) {
      console.error('save-profile failed:', err)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('load-bulk-job', () => loadBulkJob())
  ipcMain.handle('save-bulk-job', (_event, job) => saveBulkJob(job))
  ipcMain.handle('clear-bulk-job', () => clearBulkJob())

  ipcMain.handle('agentic-search', async (event, query) => {
    try {
      const settings = await loadSettings()
      const result = await performAgenticSearch(query, settings.openrouterApiKey, (progress) => {
        event.sender.send('agentic-search-progress', progress)
      })
      return { success: true, result }
    } catch (err) {
      console.error('Agentic search failed:', err)
      return { success: false, error: err.message }
    }
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
