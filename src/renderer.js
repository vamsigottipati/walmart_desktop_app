/**
 * Renderer entry point.
 *
 * Handles page routing, dashboard UI, company detail modal, bulk upload with
 * drag-and-drop, progress saving/resume, export column picker, profile, and
 * settings. All persistence and network enrichment go through the Electron
 * preload bridge (`window.electronAPI`).
 */

document.addEventListener('DOMContentLoaded', init)

let companies = []
let currentPage = 'dashboard'
let filterText = ''
let currentSettings = { openrouterApiKey: null }
let currentProfile = { userName: '', teamRole: '' }
let currentExportPrefs = {
  companyNameColumnHeader: 'Company',
  defaultOutputColumns: [
    'name', 'description', 'industry', 'headquarters', 'keyProducts',
    'employeeCount', 'website', 'foundedYear', 'keyStakeholders',
    'stakeholderEmails', 'revenue', 'funding', 'sources'
  ]
}

let uploadRows = []
let uploadResults = []
let uploadCompanyColumn = null
let uploadedFilePath = null
let uploadJobId = null
let pendingBulkJob = null
let selectedExportColumns = []
let isBulkEnriching = false

const ALL_EXPORT_COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'description', label: 'Description' },
  { key: 'industry', label: 'Industry' },
  { key: 'headquarters', label: 'Headquarters' },
  { key: 'keyProducts', label: 'Key Products' },
  { key: 'employeeCount', label: 'Employee Count' },
  { key: 'website', label: 'Website' },
  { key: 'foundedYear', label: 'Founded Year' },
  { key: 'keyStakeholders', label: 'Key Stakeholders' },
  { key: 'stakeholderEmails', label: 'Stakeholder Emails' },
  { key: 'revenue', label: 'Revenue' },
  { key: 'funding', label: 'Funding' },
  { key: 'sources', label: 'Sources' }
]

const elements = {}

async function init() {
  cacheElements()
  bindEvents()
  registerProgressListener()
  await loadSettings()
  await loadProfile()
  await loadPendingBulkJob()
  loadAndRender()
  navigateTo('dashboard')
  Lucide.replaceIcons()
}

function cacheElements() {
  elements.addForm = document.getElementById('add-form')
  elements.companyInput = document.getElementById('company-input')
  elements.searchInput = document.getElementById('search-input')
  elements.resultsGrid = document.getElementById('results-grid')
  elements.emptyState = document.getElementById('empty-state')
  elements.loadingState = document.getElementById('loading-state')
  elements.loadingMessage = document.getElementById('loading-message')
  elements.loadingSteps = document.getElementById('loading-steps')
  elements.enhanceBtn = elements.addForm.querySelector('button[type="submit"]')

  // Navigation
  elements.navItems = document.querySelectorAll('.nav-item')
  elements.pages = document.querySelectorAll('.page')
  elements.navKeyStatus = document.getElementById('nav-key-status')

  // Modal
  elements.modal = document.getElementById('company-modal')
  elements.modalContent = document.getElementById('modal-content')

  // Settings
  elements.apiKeyInput = document.getElementById('api-key-input')
  elements.modelInput = document.getElementById('model-input')
  elements.saveSettingsBtn = document.getElementById('save-settings-btn')
  elements.testConnectionBtn = document.getElementById('test-connection-btn')
  elements.keyStatus = document.getElementById('key-status')
  elements.settingsMessage = document.getElementById('settings-message')
  elements.apiKeyBanner = document.getElementById('api-key-banner')

  // Upload
  elements.uploadDropzone = document.getElementById('upload-dropzone')
  elements.uploadBrowseBtn = document.getElementById('upload-browse-btn')
  elements.uploadFileInput = document.createElement('input')
  elements.uploadFileInput.type = 'file'
  elements.uploadFileInput.accept = '.xlsx,.xls,.csv'
  elements.uploadFileInput.className = 'hidden'
  elements.uploadDropzone.appendChild(elements.uploadFileInput)
  elements.uploadFileName = document.getElementById('upload-file-name')
  elements.uploadColumnInput = document.getElementById('upload-column-input')
  elements.uploadParseBtn = document.getElementById('upload-parse-btn')
  elements.uploadPreviewCard = document.getElementById('upload-preview-card')
  elements.uploadPreviewHead = document.getElementById('upload-preview-head')
  elements.uploadPreviewBody = document.getElementById('upload-preview-body')
  elements.uploadEnrichBtn = document.getElementById('upload-enrich-btn')
  elements.uploadProgressCard = document.getElementById('upload-progress-card')
  elements.uploadProgressList = document.getElementById('upload-progress-list')
  elements.uploadResultsCard = document.getElementById('upload-results-card')
  elements.uploadResultsHead = document.getElementById('upload-results-head')
  elements.uploadResultsBody = document.getElementById('upload-results-body')
  elements.uploadExportBtn = document.getElementById('upload-export-btn')
  elements.uploadColumnsToggle = document.getElementById('upload-columns-toggle')
  elements.uploadColumnsMenu = document.getElementById('upload-columns-menu')
  elements.uploadColumnsList = document.getElementById('upload-columns-list')
  elements.uploadResumeBanner = document.getElementById('upload-resume-banner')
  elements.uploadResumeText = document.getElementById('upload-resume-text')
  elements.uploadResumeBtn = document.getElementById('upload-resume-btn')
  elements.uploadDiscardBtn = document.getElementById('upload-discard-btn')

  // Profile
  elements.profileNameInput = document.getElementById('profile-name-input')
  elements.profileTeamInput = document.getElementById('profile-team-input')
  elements.profileColumnInput = document.getElementById('profile-column-input')
  elements.profileColumnsList = document.getElementById('profile-columns-list')
  elements.saveProfileBtn = document.getElementById('save-profile-btn')
  elements.profileMessage = document.getElementById('profile-message')
}

function bindEvents() {
  elements.addForm.addEventListener('submit', handleAdd)
  elements.searchInput.addEventListener('input', (event) => {
    filterText = event.target.value.trim().toLowerCase()
    renderGrid()
  })

  elements.navItems.forEach((btn) => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.page))
  })

  elements.modal.addEventListener('click', (event) => {
    if (event.target === elements.modal) closeModal()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !elements.modal.classList.contains('hidden')) {
      closeModal()
    }
  })

  // Settings
  elements.saveSettingsBtn.addEventListener('click', handleSaveSettings)
  elements.testConnectionBtn.addEventListener('click', handleTestConnection)

  // Upload
  elements.uploadBrowseBtn.addEventListener('click', () => elements.uploadFileInput.click())
  elements.uploadFileInput.addEventListener('change', handleFileSelect)
  elements.uploadParseBtn.addEventListener('click', handleParseUpload)
  elements.uploadEnrichBtn.addEventListener('click', handleEnrichUpload)
  elements.uploadExportBtn.addEventListener('click', handleExportUpload)
  elements.uploadColumnsToggle.addEventListener('click', () => {
    elements.uploadColumnsMenu.classList.toggle('hidden')
  })
  document.addEventListener('click', (event) => {
    if (!elements.uploadColumnsToggle.contains(event.target) && !elements.uploadColumnsMenu.contains(event.target)) {
      elements.uploadColumnsMenu.classList.add('hidden')
    }
  })
  elements.uploadResumeBtn.addEventListener('click', resumeBulkJob)
  elements.uploadDiscardBtn.addEventListener('click', discardBulkJob)

  // Drag and drop
  ;['dragenter', 'dragover', 'dragleave', 'drop'].forEach((eventName) => {
    elements.uploadDropzone.addEventListener(eventName, preventDefaults, false)
    document.body.addEventListener(eventName, preventDefaults, false)
  })
  ;['dragenter', 'dragover'].forEach((eventName) => {
    elements.uploadDropzone.addEventListener(eventName, () => elements.uploadDropzone.classList.add('drag-over'), false)
  })
  ;['dragleave', 'drop'].forEach((eventName) => {
    elements.uploadDropzone.addEventListener(eventName, () => elements.uploadDropzone.classList.remove('drag-over'), false)
  })
  elements.uploadDropzone.addEventListener('drop', handleFileDrop, false)

  // Profile
  elements.saveProfileBtn.addEventListener('click', handleSaveProfile)
}

function preventDefaults(event) {
  event.preventDefault()
  event.stopPropagation()
}

function registerProgressListener() {
  if (!window.electronAPI || !window.electronAPI.onEnrichProgress) return
  window.electronAPI.onEnrichProgress((progress) => updateLoadingProgress(progress))
}

function navigateTo(page) {
  currentPage = page

  elements.navItems.forEach((btn) => {
    const active = btn.dataset.page === page
    btn.classList.toggle('active', active)
    btn.classList.toggle('bg-enterprise-100', active)
    btn.classList.toggle('text-enterprise-900', active)
    btn.classList.toggle('text-enterprise-700', !active)
  })

  elements.pages.forEach((p) => {
    const isTarget = p.id === `${page}-page`
    p.classList.toggle('hidden', !isTarget)
    p.classList.toggle('flex', isTarget)
  })

  if (page === 'settings') {
    elements.apiKeyInput.value = currentSettings.openrouterApiKey || ''
  }
  if (page === 'profile') {
    renderProfileColumns()
  }
  if (page === 'upload') {
    showResumeBannerIfNeeded()
  }
}

async function loadSettings() {
  try {
    if (!window.electronAPI || !window.electronAPI.loadSettings) {
      throw new Error('Electron IPC bridge is not available')
    }
    currentSettings = await window.electronAPI.loadSettings()
    updateSettingsUI(currentSettings)
  } catch (err) {
    console.error('Failed to load settings:', err)
    currentSettings = { openrouterApiKey: null }
  }
}

async function loadProfile() {
  try {
    if (!window.electronAPI || !window.electronAPI.loadProfile) return
    const result = await window.electronAPI.loadProfile()
    if (result.success) {
      currentProfile = result.profile || currentProfile
      currentExportPrefs = result.exportPreferences || currentExportPrefs
      updateProfileUI()
    }
  } catch (err) {
    console.error('Failed to load profile:', err)
  }
}

async function loadPendingBulkJob() {
  try {
    if (!window.electronAPI || !window.electronAPI.loadBulkJob) return
    const result = await window.electronAPI.loadBulkJob()
    pendingBulkJob = result.job
  } catch (err) {
    console.error('Failed to load bulk job:', err)
  }
}

function updateProfileUI() {
  elements.profileNameInput.value = currentProfile.userName || ''
  elements.profileTeamInput.value = currentProfile.teamRole || ''
  elements.profileColumnInput.value = currentExportPrefs.companyNameColumnHeader || 'Company'
  renderProfileColumns()
}

function renderProfileColumns() {
  elements.profileColumnsList.innerHTML = ''
  ALL_EXPORT_COLUMNS.forEach((col) => {
    const label = document.createElement('label')
    label.className = 'flex cursor-pointer items-center gap-2 rounded-md border border-enterprise-200 bg-white px-3 py-2 text-sm text-enterprise-700 transition hover:border-enterprise-300'
    const checked = currentExportPrefs.defaultOutputColumns.includes(col.key)
    label.innerHTML = `
      <input type="checkbox" value="${col.key}" ${checked ? 'checked' : ''} class="h-4 w-4 rounded border-enterprise-300 text-accent-600 focus:ring-accent-500">
      <span>${escapeHtml(col.label)}</span>
    `
    elements.profileColumnsList.appendChild(label)
  })
}

function updateSettingsUI(settings) {
  const hasKey = settings.openrouterApiKey && settings.openrouterApiKey.trim().length > 0

  if (hasKey) {
    const key = settings.openrouterApiKey
    const masked = '•'.repeat(Math.max(4, key.length - 4)) + key.slice(-4)
    elements.keyStatus.textContent = `Key saved (${masked})`
    elements.keyStatus.className = 'mt-1.5 text-xs font-medium text-green-700'
    elements.apiKeyBanner.classList.add('hidden')
    elements.navKeyStatus.textContent = `Key saved (${masked})`
    elements.navKeyStatus.className = 'mt-1 text-xs font-medium text-green-700'
  } else {
    elements.keyStatus.textContent = 'No key saved.'
    elements.keyStatus.className = 'mt-1.5 text-xs text-enterprise-500'
    elements.apiKeyBanner.classList.remove('hidden')
    elements.navKeyStatus.textContent = 'No key saved'
    elements.navKeyStatus.className = 'mt-1 text-xs text-enterprise-500'
  }
}

function setSettingsMessage(text, type = 'neutral') {
  elements.settingsMessage.textContent = text
  const colorClass = type === 'success' ? 'text-green-700' : type === 'error' ? 'text-red-700' : 'text-enterprise-600'
  elements.settingsMessage.className = `min-h-[1.25rem] text-sm font-medium ${colorClass}`
}

async function handleSaveSettings() {
  const raw = elements.apiKeyInput.value.trim()
  const apiKey = raw || null

  setSettingsMessage('Saving...', 'neutral')
  try {
    const result = await window.electronAPI.saveSettings({ openrouterApiKey: apiKey })
    if (!result.success) throw new Error(result.error || 'Save failed')
    currentSettings.openrouterApiKey = apiKey
    updateSettingsUI(currentSettings)
    setSettingsMessage('Settings saved.', 'success')
  } catch (err) {
    setSettingsMessage(`Error: ${err.message}`, 'error')
  }
}

async function handleTestConnection() {
  const apiKey = elements.apiKeyInput.value.trim()
  if (!apiKey) {
    setSettingsMessage('Enter an API key before testing.', 'error')
    return
  }

  setSettingsMessage('Testing connection...', 'neutral')
  elements.testConnectionBtn.disabled = true

  try {
    const result = await window.electronAPI.testOpenRouter(apiKey)
    setSettingsMessage(result.message, result.ok ? 'success' : 'error')
  } catch (err) {
    setSettingsMessage(`Error: ${err.message}`, 'error')
  } finally {
    elements.testConnectionBtn.disabled = false
  }
}

async function handleSaveProfile() {
  const profile = {
    userName: elements.profileNameInput.value.trim(),
    teamRole: elements.profileTeamInput.value.trim()
  }
  const exportPreferences = {
    companyNameColumnHeader: elements.profileColumnInput.value.trim() || 'Company',
    defaultOutputColumns: Array.from(elements.profileColumnsList.querySelectorAll('input:checked')).map((cb) => cb.value)
  }

  elements.profileMessage.textContent = 'Saving...'
  elements.profileMessage.className = 'min-h-[1.25rem] text-sm font-medium text-enterprise-600'

  try {
    const result = await window.electronAPI.saveProfile({ profile, exportPreferences })
    if (!result.success) throw new Error(result.error || 'Save failed')
    currentProfile = profile
    currentExportPrefs = exportPreferences
    elements.profileMessage.textContent = 'Profile saved.'
    elements.profileMessage.className = 'min-h-[1.25rem] text-sm font-medium text-green-700'
  } catch (err) {
    elements.profileMessage.textContent = `Error: ${err.message}`
    elements.profileMessage.className = 'min-h-[1.25rem] text-sm font-medium text-red-700'
  }
}

async function loadAndRender() {
  try {
    companies = await CompanyStore.loadCompanies()
  } catch (err) {
    console.error('Failed to load companies:', err)
    companies = []
  }
  renderGrid()
}

function setLoading(isLoading) {
  elements.loadingState.classList.toggle('hidden', !isLoading)
  elements.emptyState.classList.add('hidden')
  elements.resultsGrid.classList.toggle('hidden', isLoading)
  elements.enhanceBtn.disabled = isLoading
  elements.enhanceBtn.innerHTML = isLoading
    ? `${Lucide.icon('loader', 16)} <span>Enhancing...</span>`
    : `${Lucide.icon('plus', 16)} <span>Enhance</span>`

  if (isLoading) {
    elements.loadingMessage.textContent = 'Initializing enrichment...'
    elements.loadingSteps.innerHTML = ''
  }
}

function updateLoadingProgress(progress) {
  if (elements.loadingState.classList.contains('hidden')) return

  elements.loadingMessage.textContent = progress.message

  const stepId = `progress-step-${progress.source}`
  let step = document.getElementById(stepId)
  if (!step) {
    step = document.createElement('div')
    step.id = stepId
    step.className = 'flex items-center gap-2 rounded-md border border-enterprise-200 bg-white px-3 py-2'
    elements.loadingSteps.appendChild(step)
  }

  const isDone = progress.status === 'done'
  const icon = isDone ? Lucide.icon('check', 16, 'text-green-600') : '<span class="h-2 w-2 rounded-full bg-accent-500 animate-pulse"></span>'
  const textClass = isDone ? 'text-enterprise-600' : 'text-enterprise-800'

  step.innerHTML = `${icon}<span class="${textClass}">${escapeHtml(progress.message)}</span>`
}

async function handleAdd(event) {
  event.preventDefault()
  const name = elements.companyInput.value.trim()
  if (!name) return

  setLoading(true)

  try {
    const response = await window.electronAPI.enrichCompany(name)
    if (!response.success) throw new Error(response.error || 'Enrichment failed')
    const enriched = response.profile

    companies.unshift(enriched)
    await CompanyStore.saveCompanies(companies)

    elements.companyInput.value = ''
    filterText = ''
    elements.searchInput.value = ''

    renderGrid()
    openModal(enriched)
  } catch (err) {
    alert('Failed to enhance company: ' + err.message)
  } finally {
    setLoading(false)
  }
}

function renderGrid() {
  const filtered = companies.filter(
    (c) =>
      c.name.toLowerCase().includes(filterText) ||
      (c.industry || '').toLowerCase().includes(filterText)
  )

  elements.resultsGrid.innerHTML = ''

  if (filtered.length === 0) {
    elements.emptyState.classList.remove('hidden')
    elements.resultsGrid.classList.add('hidden')
    return
  }

  elements.emptyState.classList.add('hidden')
  elements.resultsGrid.classList.remove('hidden')

  filtered.forEach((company) => {
    const card = document.createElement('article')
    card.className = 'glass-card p-5 cursor-pointer group'
    card.setAttribute('role', 'button')
    card.setAttribute('tabindex', '0')
    card.setAttribute('aria-label', `View details for ${company.name}`)

    card.innerHTML = `
      <div class="flex items-start justify-between">
        <div class="flex items-center gap-3">
          <div class="w-12 h-12 rounded-md bg-enterprise-900 flex items-center justify-center text-white font-semibold text-lg shadow-soft">
            ${escapeHtml(company.initials)}
          </div>
          <div class="min-w-0">
            <h3 class="font-semibold text-enterprise-900 leading-tight truncate">${escapeHtml(company.name)}</h3>
            <p class="text-xs text-enterprise-500 mt-0.5">${escapeHtml(company.industry || 'Unknown industry')}</p>
          </div>
        </div>
        <div class="flex items-center gap-1">
          <button
            class="card-delete-btn rounded-md p-1.5 text-enterprise-400 opacity-0 transition hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 focus:opacity-100"
            aria-label="Delete ${escapeHtml(company.name)}"
            title="Delete"
          >
            ${Lucide.icon('trash-2', 16)}
          </button>
          ${Lucide.icon('chevron-right', 20, 'text-enterprise-300 opacity-0 group-hover:opacity-100 transition')}
        </div>
      </div>
      <p class="mt-4 text-sm text-enterprise-600 line-clamp-2">${escapeHtml(company.description || '')}</p>
      <div class="mt-4 flex items-center justify-between text-xs text-enterprise-500">
        <span class="flex items-center gap-1">
          ${Lucide.icon('map-pin', 12)}
          ${escapeHtml(company.headquarters || 'Unknown HQ')}
        </span>
        <span class="flex items-center gap-1">
          ${Lucide.icon('users', 12)}
          ${formatNumber(company.employeeCount)}
        </span>
      </div>
    `

    card.querySelector('.card-delete-btn').addEventListener('click', (event) => {
      event.stopPropagation()
      deleteCompany(company.id)
    })

    card.addEventListener('click', () => openModal(company))
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        openModal(company)
      }
    })

    elements.resultsGrid.appendChild(card)
  })
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

function openModal(company) {
  elements.modalContent.innerHTML = renderModalContent(company)
  elements.modal.classList.remove('hidden')
  elements.modal.classList.add('flex')

  document.getElementById('modal-close').addEventListener('click', closeModal)
  document.getElementById('modal-delete').addEventListener('click', () => deleteCompany(company.id))
  document.getElementById('modal-refetch').addEventListener('click', () => refetchCompany(company.id))
  document.getElementById('modal-deep-research').addEventListener('click', () => deepResearchCompany(company.id))

  const showSourcesBtn = document.getElementById('modal-show-sources')
  if (showSourcesBtn) {
    showSourcesBtn.addEventListener('click', () => {
      const panel = document.getElementById('modal-sources-panel')
      const icon = showSourcesBtn.querySelector('svg')
      panel.classList.toggle('hidden')
      icon.classList.toggle('rotate-90')
    })
  }

  document.querySelectorAll('.agent-detail-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const content = btn.nextElementSibling
      const icon = btn.querySelector('svg:last-child')
      content.classList.toggle('hidden')
      icon.classList.toggle('rotate-90')
    })
  })
}

function closeModal() {
  elements.modal.classList.add('hidden')
  elements.modal.classList.remove('flex')
  elements.modalContent.innerHTML = ''
}

function renderModalContent(company) {
  const productsHtml = (company.keyProducts || [])
    .map((product) => `
      <li class="flex items-start gap-2">
        <span class="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent-500"></span>
        <span class="text-sm text-enterprise-700">${escapeHtml(product)}</span>
      </li>
    `)
    .join('')

  const websiteLink = company.website
    ? `<a href="${escapeHtml(company.website)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 break-all text-sm font-medium text-accent-600 hover:text-accent-700 hover:underline">${escapeHtml(company.website)} ${Lucide.icon('external-link', 12)}</a>`
    : '<span class="text-sm text-enterprise-400">Not discovered</span>'

  return `
    <div class="mb-6 flex items-start justify-between">
      <div class="flex items-center gap-4">
        <div class="flex h-16 w-16 items-center justify-center rounded-lg bg-enterprise-900 text-3xl font-semibold text-white shadow-soft">
          ${escapeHtml(company.initials)}
        </div>
        <div class="min-w-0">
          <h2 class="text-2xl font-semibold leading-tight text-enterprise-900">${escapeHtml(company.name)}</h2>
          <p class="text-sm text-enterprise-500">${escapeHtml(company.industry || 'Unknown industry')}</p>
        </div>
      </div>
      <button id="modal-close" class="glass-btn-secondary p-2" aria-label="Close details">
        ${Lucide.icon('x', 16)}
      </button>
    </div>

    <div class="space-y-5">
      <section class="glass-card cursor-default p-5">
        <div class="mb-2 flex items-center gap-2">
          ${Lucide.icon('briefcase', 16, 'text-enterprise-400')}
          <h3 class="text-xs font-semibold uppercase tracking-wider text-enterprise-500">Description</h3>
        </div>
        <p class="text-sm leading-relaxed text-enterprise-800">${escapeHtml(company.description || 'No description available.')}</p>
        ${renderSourcesBadges(company.sources)}
      </section>

      <section class="grid grid-cols-2 gap-3">
        <div class="glass-card cursor-default p-4">
          <div class="mb-1 flex items-center gap-1.5 text-enterprise-400">
            ${Lucide.icon('map-pin', 14)}
            <h3 class="text-xs font-semibold uppercase tracking-wider">Headquarters</h3>
          </div>
          <p class="text-sm font-semibold text-enterprise-900">${escapeHtml(company.headquarters || 'Unknown')}</p>
        </div>
        <div class="glass-card cursor-default p-4">
          <div class="mb-1 flex items-center gap-1.5 text-enterprise-400">
            ${Lucide.icon('users', 14)}
            <h3 class="text-xs font-semibold uppercase tracking-wider">Employees</h3>
          </div>
          <p class="text-sm font-semibold text-enterprise-900">${formatNumber(company.employeeCount)}</p>
        </div>
        <div class="glass-card cursor-default p-4">
          <div class="mb-1 flex items-center gap-1.5 text-enterprise-400">
            ${Lucide.icon('calendar', 14)}
            <h3 class="text-xs font-semibold uppercase tracking-wider">Founded</h3>
          </div>
          <p class="text-sm font-semibold text-enterprise-900">${company.foundedYear || 'Unknown'}</p>
        </div>
        <div class="glass-card cursor-default p-4">
          <div class="mb-1 flex items-center gap-1.5 text-enterprise-400">
            ${Lucide.icon('external-link', 14)}
            <h3 class="text-xs font-semibold uppercase tracking-wider">Website</h3>
          </div>
          ${websiteLink}
        </div>
      </section>

      <section class="glass-card cursor-default p-5">
        <div class="mb-3 flex items-center gap-2">
          ${Lucide.icon('package', 16, 'text-enterprise-400')}
          <h3 class="text-xs font-semibold uppercase tracking-wider text-enterprise-500">Key Products / Services</h3>
        </div>
        ${productsHtml || '<p class="text-sm text-enterprise-500">No products identified.</p>'}
      </section>

      <section class="glass-card cursor-default p-5">
        <div class="mb-3 flex items-center gap-2">
          ${Lucide.icon('user', 16, 'text-enterprise-400')}
          <h3 class="text-xs font-semibold uppercase tracking-wider text-enterprise-500">Key Stakeholders</h3>
        </div>
        ${renderStakeholders(company.keyStakeholders)}
      </section>

      <section class="glass-card cursor-default p-5">
        <div class="mb-3 flex items-center gap-2">
          ${Lucide.icon('banknote', 16, 'text-enterprise-400')}
          <h3 class="text-xs font-semibold uppercase tracking-wider text-enterprise-500">Financials</h3>
        </div>
        <div class="space-y-3">
          <div>
            <p class="text-xs font-semibold uppercase tracking-wider text-enterprise-400">Latest Revenue</p>
            ${renderRevenue(company.revenue)}
          </div>
          <div>
            <p class="text-xs font-semibold uppercase tracking-wider text-enterprise-400">Funding</p>
            ${renderFunding(company.funding)}
          </div>
        </div>
      </section>

      <div class="grid grid-cols-3 gap-3 pt-2">
        <button id="modal-refetch" class="glass-btn-secondary flex items-center justify-center gap-2">
          ${Lucide.icon('rotate-ccw', 16)}
          <span>Re-fetch</span>
        </button>
        <button id="modal-deep-research" class="glass-btn-secondary flex items-center justify-center gap-2">
          ${Lucide.icon('search', 16)}
          <span>Deep research</span>
        </button>
        <button id="modal-delete" class="glass-btn-danger flex items-center justify-center gap-2">
          ${Lucide.icon('trash-2', 16)}
          <span>Delete</span>
        </button>
      </div>

      <div class="border-t border-enterprise-200 pt-4">
        <button id="modal-show-sources" class="flex w-full items-center justify-between text-left">
          <span class="text-sm font-semibold text-enterprise-700">What happened behind the scenes</span>
          ${Lucide.icon('chevron-right', 18, 'transition-transform')}
        </button>
        <div id="modal-sources-panel" class="hidden mt-3 space-y-3">
          ${renderAgentDetails(company._agentDetails)}
        </div>
      </div>

      <p class="text-center text-xs text-enterprise-400">
        Enriched ${new Date(company.enrichedAt).toLocaleString()}
      </p>
    </div>
  `
}

function renderAgentDetails(agentDetails = {}) {
  const agents = [
    { key: 'Wikipedia', label: 'Wikipedia', icon: 'file-spreadsheet' },
    { key: 'Website', label: 'Website', icon: 'external-link' },
    { key: 'EDGAR', label: 'SEC EDGAR', icon: 'briefcase' },
    { key: 'Finance', label: 'Finance lookup', icon: 'banknote' },
    { key: 'DuckDuckGo', label: 'DuckDuckGo', icon: 'search' },
    { key: 'deepResearch', label: 'Deep Research', icon: 'search' }
  ]

  return agents.map((agent) => {
    const result = agentDetails[agent.key]
    if (!result || !result.found) {
      return `
        <div class="rounded-md border border-enterprise-200 bg-enterprise-50 p-3">
          <div class="flex items-center gap-2 text-sm font-medium text-enterprise-600">
            ${Lucide.icon(agent.icon, 16)}
            <span>${escapeHtml(agent.label)}</span>
          </div>
          <p class="mt-1 text-xs text-enterprise-500">No data found.</p>
        </div>
      `
    }

    const summary = summarizeAgentData(agent.key, result.data)
    return `
      <div class="rounded-md border border-enterprise-200 bg-white p-3 shadow-soft">
        <button class="agent-detail-toggle flex w-full items-center justify-between text-left" data-agent="${agent.key}">
          <div class="flex items-center gap-2 text-sm font-medium text-enterprise-800">
            ${Lucide.icon(agent.icon, 16)}
            <span>${escapeHtml(agent.label)}</span>
            ${Lucide.icon('check', 14, 'text-green-600')}
          </div>
          ${Lucide.icon('chevron-right', 16, 'text-enterprise-400 transition-transform')}
        </button>
        <div class="agent-detail-content hidden mt-2">
          ${summary}
        </div>
      </div>
    `
  }).join('')
}

function summarizeAgentData(source, data) {
  if (!data) return '<p class="text-xs text-enterprise-500">No details.</p>'

  const rows = []

  if (source === 'Wikipedia') {
    if (data.title) rows.push(['Title', data.title])
    if (data.headquarters) rows.push(['HQ', data.headquarters])
    if (data.employeeCount) rows.push(['Employees', formatNumber(data.employeeCount)])
    if (data.foundedYear) rows.push(['Founded', data.foundedYear])
    if (data.revenue) rows.push(['Revenue', typeof data.revenue === 'string' ? data.revenue : data.revenue.amount])
    if (Array.isArray(data.keyStakeholders) && data.keyStakeholders.length) {
      rows.push(['Stakeholders', data.keyStakeholders.map((s) => `${s.name} (${s.role})`).join(', ')])
    }
    if (data.url) rows.push(['URL', `<a href="${escapeHtml(data.url)}" target="_blank" rel="noopener" class="text-accent-600 hover:underline">${escapeHtml(data.url)}</a>`])
  }

  if (source === 'Website') {
    if (data.url) rows.push(['URL', `<a href="${escapeHtml(data.url)}" target="_blank" rel="noopener" class="text-accent-600 hover:underline">${escapeHtml(data.url)}</a>`])
    if (data.headquarters) rows.push(['HQ', data.headquarters])
    if (data.employeeCount) rows.push(['Employees', formatNumber(data.employeeCount)])
    if (Array.isArray(data.keyStakeholders) && data.keyStakeholders.length) {
      rows.push(['Stakeholders', data.keyStakeholders.map((s) => `${s.name} (${s.role})`).join(', ')])
    }
    if (Array.isArray(data.emails) && data.emails.length) rows.push(['Emails', data.emails.join(', ')])
  }

  if (source === 'EDGAR') {
    if (data.cik) rows.push(['CIK', data.cik])
    if (data.entityName) rows.push(['Entity', data.entityName])
    if (data.revenue) rows.push(['Revenue', typeof data.revenue === 'string' ? data.revenue : data.revenue.amount])
    if (data.netIncome) rows.push(['Net income', data.netIncome])
    if (data.latest10k) rows.push(['Latest 10-K', `<a href="${escapeHtml(data.latest10k.url)}" target="_blank" rel="noopener" class="text-accent-600 hover:underline">${escapeHtml(data.latest10k.date || 'Open')}</a>`])
  }

  if (source === 'Finance') {
    if (data.revenue) rows.push(['Revenue', data.revenue])
    if (data.marketCap) rows.push(['Market cap', data.marketCap])
    if (data.employeeCount) rows.push(['Employees', formatNumber(data.employeeCount)])
  }

  if (source === 'DuckDuckGo') {
    if (Array.isArray(data.results) && data.results.length) {
      return `<ul class="space-y-1 text-xs text-enterprise-700">${data.results.slice(0, 5).map((r) => `<li><span class="font-medium">${escapeHtml(r.title || '')}</span> — ${escapeHtml(r.snippet || '')}</li>`).join('')}</ul>`
    }
  }

  if (source === 'deepResearch') {
    if (data.answer) rows.push(['Answer', escapeHtml(data.answer)])
    if (Array.isArray(data.citations) && data.citations.length) {
      rows.push(['Sources', data.citations.slice(0, 5).map((c) => `<a href="${escapeHtml(c.url)}" target="_blank" rel="noopener" class="text-accent-600 hover:underline">[${c.number}] ${escapeHtml(c.title || c.url)}</a>`).join('<br>')])
    }
  }

  if (!rows.length) return '<p class="text-xs text-enterprise-500">Raw data available but no summary fields.</p>'

  return `
    <table class="w-full text-xs">
      <tbody class="divide-y divide-enterprise-100">
        ${rows.map(([label, value]) => `
          <tr>
            <td class="py-1.5 pr-3 font-medium text-enterprise-500 whitespace-nowrap">${escapeHtml(label)}</td>
            <td class="py-1.5 text-enterprise-800">${value}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `
}

function renderSourcesBadges(sources = []) {
  if (!sources.length) return ''
  const badges = sources
    .map(
      (source) =>
        `<span class="inline-flex items-center rounded-md bg-enterprise-100 border border-enterprise-200 px-2.5 py-0.5 text-xs font-medium text-enterprise-700">${escapeHtml(source)}</span>`
    )
    .join('')
  return `
    <div class="mt-4 flex flex-wrap items-center gap-2">
      <span class="text-xs font-semibold uppercase tracking-wider text-enterprise-400">Sources</span>
      ${badges}
    </div>
  `
}

function renderStakeholders(stakeholders = []) {
  if (!stakeholders.length) return '<p class="text-sm text-enterprise-500">No stakeholders identified.</p>'
  return `
    <ul class="space-y-3">
      ${stakeholders.map((s) => `
        <li class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-sm font-medium text-enterprise-900">${escapeHtml(s.name || 'Unknown')}</p>
            <p class="text-xs text-enterprise-500">${escapeHtml(s.role || '')}</p>
          </div>
          <div class="flex flex-shrink-0 items-center gap-2">
            ${s.linkedIn ? `<a href="${escapeHtml(s.linkedIn)}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 rounded-md border border-enterprise-200 bg-white px-2 py-1 text-xs font-medium text-[#0A66C2] shadow-soft hover:bg-enterprise-50" title="View on LinkedIn">${Lucide.icon('linkedin', 12)} LinkedIn</a>` : ''}
            ${s.email ? `<a href="mailto:${escapeHtml(s.email)}" class="inline-flex items-center gap-1 rounded-md border border-enterprise-200 bg-white px-2 py-1 text-xs font-medium text-accent-600 shadow-soft hover:bg-enterprise-50" title="${s.emailInferred ? 'Email inferred from domain' : ''}">${Lucide.icon('mail', 12)} ${escapeHtml(s.email)}</a>` : ''}
          </div>
        </li>
      `).join('')}
    </ul>
  `
}

function renderFunding(funding) {
  if (!funding || funding === 'Unknown' || (!funding.totalRaised && !funding.rounds?.length)) {
    return '<p class="text-sm text-enterprise-500">No funding data available.</p>'
  }
  const total = funding.totalRaised ? `<p class="text-sm font-medium text-enterprise-900">Total raised: ${escapeHtml(funding.totalRaised)}</p>` : ''
  const rounds = Array.isArray(funding.rounds) && funding.rounds.length
    ? `<ul class="mt-2 space-y-1">${funding.rounds.map((r) => `
        <li class="text-xs text-enterprise-600">
          ${escapeHtml(r.round || 'Round')} — ${escapeHtml(r.amount || 'Unknown amount')} ${r.date ? `(${escapeHtml(r.date)})` : ''}
        </li>
      `).join('')}</ul>`
    : ''
  return total + rounds
}

function renderRevenue(revenue) {
  if (!revenue || revenue === 'Unknown') return '<p class="text-sm text-enterprise-500">No revenue data available.</p>'
  if (typeof revenue === 'string') return `<p class="text-sm font-medium text-enterprise-900">${escapeHtml(revenue)}</p>`
  const amount = revenue.amount ? `<p class="text-sm font-medium text-enterprise-900">${escapeHtml(revenue.amount)}</p>` : ''
  const year = revenue.year ? `<p class="text-xs text-enterprise-500">Fiscal year: ${escapeHtml(String(revenue.year))}</p>` : ''
  const source = revenue.source ? `<p class="text-xs text-enterprise-400">Source: ${escapeHtml(revenue.source)}</p>` : ''
  return amount + year + source
}

function isNonEmpty(value) {
  if (value === null || value === undefined) return false
  if (typeof value === 'string' && value.trim() === '') return false
  if (Array.isArray(value) && value.length === 0) return false
  if (typeof value === 'object' && Object.keys(value).length === 0) return false
  return true
}

function mergeStakeholders(existing = [], incoming = []) {
  const map = new Map()
  for (const s of existing) {
    if (s && s.name) map.set(s.name.toLowerCase().trim(), { ...s })
  }
  for (const s of incoming) {
    if (!s || !s.name) continue
    const key = s.name.toLowerCase().trim()
    const current = map.get(key) || {}
    map.set(key, { ...current, ...s })
  }
  return Array.from(map.values())
}

function mergeAgentContext(existing = {}, incoming = {}) {
  const merged = {}
  const allKeys = new Set([...Object.keys(existing), ...Object.keys(incoming)])
  for (const key of allKeys) {
    const oldVal = existing[key]
    const newVal = incoming[key]
    if (isNonEmpty(newVal)) {
      merged[key] = newVal
    } else {
      merged[key] = oldVal
    }
  }
  return merged
}

function mergeCompanyProfile(existing, incoming) {
  const merged = { ...existing }

  for (const key of Object.keys(incoming)) {
    const newVal = incoming[key]

    if (key === 'stakeholders') {
      merged[key] = mergeStakeholders(existing.stakeholders, newVal)
      continue
    }

    if (key === 'agentContext') {
      merged[key] = mergeAgentContext(existing.agentContext, newVal)
      continue
    }

    if (key === '_agentDetails') {
      const oldDetails = existing._agentDetails || {}
      const newDetails = newVal || {}
      merged[key] = { ...oldDetails, ...newDetails }
      continue
    }

    if (key === 'sources') {
      const oldSources = Array.isArray(existing.sources) ? existing.sources : []
      const newSources = Array.isArray(newVal) ? newVal : []
      const seen = new Set(oldSources.map((s) => s?.url).filter(Boolean))
      merged[key] = [...oldSources]
      for (const s of newSources) {
        if (s && s.url && !seen.has(s.url)) {
          merged[key].push(s)
          seen.add(s.url)
        }
      }
      continue
    }

    if (isNonEmpty(newVal)) {
      merged[key] = newVal
    }
  }

  merged.enrichedAt = new Date().toISOString()
  return merged
}

async function refetchCompany(id) {
  const company = companies.find((c) => c.id === id)
  if (!company) return

  const refetchBtn = document.getElementById('modal-refetch')
  if (refetchBtn) {
    refetchBtn.disabled = true
    refetchBtn.innerHTML = `${Lucide.icon('loader', 16, 'animate-spin')} <span>Re-fetching...</span>`
  }

  try {
    const response = await window.electronAPI.enrichCompany(company.name)
    if (!response.success) throw new Error(response.error || 'Re-fetch failed')

    const refreshed = mergeCompanyProfile(company, response.profile)
    refreshed.id = company.id

    const index = companies.findIndex((c) => c.id === id)
    if (index !== -1) companies[index] = refreshed

    await CompanyStore.saveCompanies(companies)
    renderGrid()
    openModal(refreshed)
  } catch (err) {
    alert('Failed to re-fetch company: ' + err.message)
    if (refetchBtn) {
      refetchBtn.disabled = false
      refetchBtn.innerHTML = `${Lucide.icon('rotate-ccw', 16)} <span>Re-fetch</span>`
    }
  }
}

async function deleteCompany(id) {
  if (!confirm('Are you sure you want to remove this enriched company?')) return

  companies = companies.filter((c) => c.id !== id)
  closeModal()

  await CompanyStore.saveCompanies(companies)
  renderGrid()
}

// ---------------------------------------------------------------------------
// Upload data
// ---------------------------------------------------------------------------

function handleFileDrop(event) {
  const files = event.dataTransfer.files
  if (files.length > 0) {
    selectFile(files[0])
  }
}

function handleFileSelect(event) {
  const file = event.target.files[0]
  if (file) selectFile(file)
}

function selectFile(file) {
  if (!file) {
    uploadedFilePath = null
    elements.uploadFileName.innerHTML = `${Lucide.icon('file-spreadsheet', 16, 'text-enterprise-400')} <span>No file selected</span>`
    return
  }
  uploadedFilePath = file.path
  elements.uploadFileName.innerHTML = `${Lucide.icon('file-spreadsheet', 16, 'text-enterprise-400')} <span class="truncate">${escapeHtml(file.name)}</span>`
  elements.uploadFileInput.value = ''
}

async function handleParseUpload() {
  if (!uploadedFilePath) {
    alert('Please select or drop an Excel file first.')
    return
  }

  setParseLoading(true)

  try {
    const preferred = elements.uploadColumnInput.value.trim() || currentExportPrefs.companyNameColumnHeader
    const result = await window.electronAPI.parseExcel(uploadedFilePath)
    if (!result.success) throw new Error(result.error || 'Parse failed')

    uploadRows = result.rows || []
    uploadCompanyColumn = result.companyColumn || preferred

    if (!uploadCompanyColumn && uploadRows.length > 0) {
      uploadCompanyColumn = Object.keys(uploadRows[0])[0]
    }

    if (!uploadCompanyColumn) {
      throw new Error('Could not identify a company-name column.')
    }

    uploadResults = []
    uploadJobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    selectedExportColumns = [...currentExportPrefs.defaultOutputColumns]

    elements.uploadColumnInput.value = uploadCompanyColumn
    renderUploadPreview()
    elements.uploadPreviewCard.classList.remove('hidden')
    elements.uploadProgressCard.classList.add('hidden')
    elements.uploadResultsCard.classList.add('hidden')
  } catch (err) {
    alert('Failed to parse file: ' + err.message)
  } finally {
    setParseLoading(false)
  }
}

function setParseLoading(isLoading) {
  elements.uploadParseBtn.disabled = isLoading
  elements.uploadParseBtn.innerHTML = isLoading
    ? `${Lucide.icon('loader', 16)} <span>Parsing...</span>`
    : `${Lucide.icon('search', 16)} <span>Preview Rows</span>`
}

function renderUploadPreview() {
  if (!uploadRows.length) return
  const headers = Object.keys(uploadRows[0])
  elements.uploadPreviewHead.innerHTML = headers.map((h) => `<th class="px-4 py-2 font-medium whitespace-nowrap">${escapeHtml(h)}</th>`).join('')
  elements.uploadPreviewBody.innerHTML = uploadRows.slice(0, 5).map((row) => `
    <tr>${headers.map((h) => `<td class="px-4 py-2 text-enterprise-700">${escapeHtml(String(row[h] ?? ''))}</td>`).join('')}</tr>
  `).join('')
}

async function handleEnrichUpload() {
  if (!uploadRows.length || !uploadCompanyColumn) return

  isBulkEnriching = true
  elements.uploadProgressCard.classList.remove('hidden')
  elements.uploadResultsCard.classList.add('hidden')
  elements.uploadProgressList.innerHTML = ''
  elements.uploadEnrichBtn.disabled = true

  if (!uploadResults.length) {
    uploadResults = uploadRows.map((row) => ({ ...row, _enrichmentStatus: 'pending' }))
  }

  let startIndex = uploadResults.findIndex((r) => r._enrichmentStatus === 'pending')
  if (startIndex === -1) startIndex = 0

  for (let i = startIndex; i < uploadRows.length; i++) {
    if (!isBulkEnriching) break

    const row = uploadRows[i]
    const name = String(row[uploadCompanyColumn] || '').trim()

    if (!name) {
      uploadResults[i]._enrichmentStatus = 'skipped'
      uploadResults[i]._enrichmentError = 'Empty company name'
      continue
    }

    const step = document.createElement('div')
    step.id = `upload-step-${i}`
    step.className = 'flex items-center gap-2 rounded-md border border-enterprise-200 bg-white px-3 py-2 text-sm'
    step.innerHTML = `${Lucide.icon('loader', 16, 'text-accent-600 animate-spin')}<span class="text-enterprise-800">Enriching ${escapeHtml(name)}...</span>`
    elements.uploadProgressList.appendChild(step)

    try {
      const response = await window.electronAPI.enrichCompany(name)
      const profile = response.success ? response.profile : null
      const result = { ...row, _enrichmentStatus: profile ? 'success' : 'failed', _enrichmentError: response.error || '' }

      if (profile) {
        ALL_EXPORT_COLUMNS.forEach((col) => {
          if (col.key === 'keyStakeholders' || col.key === 'stakeholderEmails') {
            result[col.key] = stringifyList(profile[col.key])
          } else if (col.key === 'keyProducts' || col.key === 'sources') {
            result[col.key] = Array.isArray(profile[col.key]) ? profile[col.key].join(', ') : profile[col.key]
          } else {
            result[col.key] = profile[col.key] ?? ''
          }
        })
      }

      uploadResults[i] = result

      step.innerHTML = `${Lucide.icon(profile ? 'check' : 'x', 16, profile ? 'text-green-600' : 'text-red-600')}<span class="${profile ? 'text-enterprise-600' : 'text-red-600'}">${escapeHtml(name)} — ${profile ? 'done' : 'failed'}</span>`
    } catch (err) {
      uploadResults[i] = { ...row, _enrichmentStatus: 'failed', _enrichmentError: err.message }
      step.innerHTML = `${Lucide.icon('x', 16, 'text-red-600')}<span class="text-red-600">${escapeHtml(name)} — ${escapeHtml(err.message)}</span>`
    }

    await saveBulkJobState()
  }

  isBulkEnriching = false
  elements.uploadEnrichBtn.disabled = false
  renderUploadResults()
  renderExportColumnPicker()
  elements.uploadResultsCard.classList.remove('hidden')
  await clearBulkJobIfDone()
}

async function saveBulkJobState() {
  if (!window.electronAPI || !window.electronAPI.saveBulkJob) return
  const job = {
    id: uploadJobId,
    filePath: uploadedFilePath,
    fileName: elements.uploadFileName.textContent.trim(),
    companyColumn: uploadCompanyColumn,
    rows: uploadRows,
    results: uploadResults,
    updatedAt: new Date().toISOString()
  }
  await window.electronAPI.saveBulkJob(job)
}

async function clearBulkJobIfDone() {
  const hasPending = uploadResults.some((r) => r._enrichmentStatus === 'pending')
  if (!hasPending) {
    pendingBulkJob = null
    elements.uploadResumeBanner.classList.add('hidden')
    if (window.electronAPI && window.electronAPI.clearBulkJob) {
      await window.electronAPI.clearBulkJob()
    }
  }
}

function showResumeBannerIfNeeded() {
  if (!pendingBulkJob || pendingBulkJob.id === uploadJobId) {
    elements.uploadResumeBanner.classList.add('hidden')
    return
  }

  const total = pendingBulkJob.results?.length || pendingBulkJob.rows?.length || 0
  const done = pendingBulkJob.results?.filter((r) => r._enrichmentStatus !== 'pending').length || 0
  elements.uploadResumeText.textContent = `${done} of ${total} companies enriched from ${pendingBulkJob.fileName || 'previous upload'}. Resume where you left off?`
  elements.uploadResumeBanner.classList.remove('hidden')
}

async function resumeBulkJob() {
  if (!pendingBulkJob) return

  uploadJobId = pendingBulkJob.id
  uploadedFilePath = pendingBulkJob.filePath
  uploadCompanyColumn = pendingBulkJob.companyColumn
  uploadRows = pendingBulkJob.rows || []
  uploadResults = pendingBulkJob.results || []
  selectedExportColumns = [...currentExportPrefs.defaultOutputColumns]

  elements.uploadFileName.innerHTML = `${Lucide.icon('file-spreadsheet', 16, 'text-enterprise-400')} <span class="truncate">${escapeHtml(pendingBulkJob.fileName || 'resumed file')}</span>`
  elements.uploadColumnInput.value = uploadCompanyColumn

  elements.uploadResumeBanner.classList.add('hidden')
  elements.uploadPreviewCard.classList.add('hidden')
  elements.uploadProgressCard.classList.remove('hidden')
  elements.uploadResultsCard.classList.add('hidden')
  elements.uploadProgressList.innerHTML = ''

  // Replay completed steps
  uploadResults.forEach((result, i) => {
    if (result._enrichmentStatus === 'pending') return
    const name = String(uploadRows[i][uploadCompanyColumn] || '')
    const step = document.createElement('div')
    step.id = `upload-step-${i}`
    step.className = 'flex items-center gap-2 rounded-md border border-enterprise-200 bg-white px-3 py-2 text-sm'
    const icon = result._enrichmentStatus === 'success' ? Lucide.icon('check', 16, 'text-green-600') : Lucide.icon('x', 16, 'text-red-600')
    const textClass = result._enrichmentStatus === 'success' ? 'text-enterprise-600' : 'text-red-600'
    const label = result._enrichmentStatus === 'success' ? 'done' : 'failed'
    step.innerHTML = `${icon}<span class="${textClass}">${escapeHtml(name)} — ${label}</span>`
    elements.uploadProgressList.appendChild(step)
  })

  await handleEnrichUpload()
}

async function discardBulkJob() {
  pendingBulkJob = null
  elements.uploadResumeBanner.classList.add('hidden')
  if (window.electronAPI && window.electronAPI.clearBulkJob) {
    await window.electronAPI.clearBulkJob()
  }
}

function stringifyList(list) {
  if (!Array.isArray(list)) return ''
  return list.map((item) => {
    if (typeof item === 'string') return item
    if (item.name && item.email) return `${item.name} <${item.email}>`
    if (item.name && item.role) return `${item.name} (${item.role})`
    if (item.email) return item.email
    return String(item)
  }).join(', ')
}

function renderUploadResults() {
  if (!uploadResults.length) return
  const headers = Object.keys(uploadResults[0])
  elements.uploadResultsHead.innerHTML = headers.map((h) => `<th class="px-4 py-2 font-medium whitespace-nowrap">${escapeHtml(h)}</th>`).join('')
  elements.uploadResultsBody.innerHTML = uploadResults.slice(0, 20).map((row) => `
    <tr>${headers.map((h) => `<td class="px-4 py-2 text-enterprise-700">${escapeHtml(String(row[h] ?? ''))}</td>`).join('')}</tr>
  `).join('')
}

function renderExportColumnPicker() {
  elements.uploadColumnsList.innerHTML = ''
  const headers = uploadResults.length ? Object.keys(uploadResults[0]) : []
  if (!headers.length) return

  headers.forEach((header) => {
    const label = ALL_EXPORT_COLUMNS.find((c) => c.key === header)?.label || header
    const checked = selectedExportColumns.includes(header)
    const item = document.createElement('label')
    item.className = 'flex cursor-pointer items-center gap-2 text-sm text-enterprise-700'
    item.innerHTML = `
      <input type="checkbox" value="${escapeHtml(header)}" ${checked ? 'checked' : ''} class="h-4 w-4 rounded border-enterprise-300 text-accent-600 focus:ring-accent-500">
      <span>${escapeHtml(label)}</span>
    `
    item.querySelector('input').addEventListener('change', (event) => {
      if (event.target.checked) {
        if (!selectedExportColumns.includes(header)) selectedExportColumns.push(header)
      } else {
        selectedExportColumns = selectedExportColumns.filter((c) => c !== header)
      }
    })
    elements.uploadColumnsList.appendChild(item)
  })
}

async function handleExportUpload() {
  if (!uploadResults.length) return

  const result = await window.electronAPI.showSaveDialog({
    defaultPath: 'enriched-companies.xlsx',
    filters: [{ name: 'Excel', extensions: ['xlsx'] }]
  })

  if (result.canceled || !result.filePath) return

  try {
    const exportRows = uploadResults.map((row) => {
      const filtered = {}
      selectedExportColumns.forEach((col) => {
        filtered[col] = row[col]
      })
      return filtered
    })
    const exportResult = await window.electronAPI.exportExcel(exportRows, result.filePath)
    if (!exportResult.success) throw new Error(exportResult.error || 'Export failed')
    alert('Exported to ' + result.filePath)
  } catch (err) {
    alert('Export failed: ' + err.message)
  }
}

// ---------------------------------------------------------------------------
// Deep Research (agentic search per company)
// ---------------------------------------------------------------------------

let deepResearchActive = false

async function deepResearchCompany(id) {
  const company = companies.find((c) => c.id === id)
  if (!company) return

  if (!window.electronAPI || !window.electronAPI.deepResearchCompany) {
    alert('Deep research is not available.')
    return
  }

  const deepBtn = document.getElementById('modal-deep-research')
  if (deepBtn) {
    deepResearchActive = true
    deepBtn.disabled = true
    deepBtn.innerHTML = `${Lucide.icon('loader', 16, 'animate-spin')} <span>Deep research...</span>`
  }

  try {
    const response = await window.electronAPI.deepResearchCompany(company.name)
    if (!response.success) throw new Error(response.error || 'Deep research failed')

    const updated = mergeCompanyProfile(company, response.profile)
    updated.id = company.id

    const index = companies.findIndex((c) => c.id === id)
    if (index !== -1) companies[index] = updated

    await CompanyStore.saveCompanies(companies)
    renderGrid()
    openModal(updated)
  } catch (err) {
    alert('Deep research failed: ' + err.message)
  } finally {
    deepResearchActive = false
    const btn = document.getElementById('modal-deep-research')
    if (btn) {
      btn.disabled = false
      btn.innerHTML = `${Lucide.icon('search', 16)} <span>Deep research</span>`
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  if (value == null) return ''
  return String(value).replace(/[&<>"']/g, (char) => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
    return map[char]
  })
}

function formatNumber(value) {
  if (value == null || value === '') return 'Unknown'
  return Number(value).toLocaleString()
}
