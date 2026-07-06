/**
 * Settings persistence layer (main process only).
 *
 * Stores user preferences such as the OpenRouter API key in a JSON file
 * inside Electron's userData directory. The renderer never accesses this
 * file directly; it goes through the IPC bridge.
 */

const { app } = require('electron')
const path = require('path')
const fs = require('fs').promises
const { existsSync } = require('fs')

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json')

const DEFAULT_SETTINGS = {
  openrouterApiKey: null,
  profile: {
    userName: '',
    teamRole: ''
  },
  exportPreferences: {
    companyNameColumnHeader: 'Company',
    defaultOutputColumns: [
      'name',
      'description',
      'industry',
      'headquarters',
      'keyProducts',
      'employeeCount',
      'website',
      'foundedYear',
      'keyStakeholders',
      'stakeholderEmails',
      'revenue',
      'funding',
      'sources'
    ]
  }
}

async function ensureSettings() {
  if (!existsSync(SETTINGS_FILE)) {
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2), 'utf8')
  }
}

async function loadSettings() {
  try {
    await ensureSettings()
    const raw = await fs.readFile(SETTINGS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return { ...DEFAULT_SETTINGS, ...parsed }
  } catch (err) {
    console.error('Failed to load settings:', err)
    return { ...DEFAULT_SETTINGS }
  }
}

async function saveSettings(settings) {
  try {
    const current = await loadSettings()
    const next = { ...current, ...settings }
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8')
    return { success: true }
  } catch (err) {
    console.error('Failed to save settings:', err)
    return { success: false, error: err.message }
  }
}

module.exports = {
  loadSettings,
  saveSettings,
  DEFAULT_SETTINGS
}
