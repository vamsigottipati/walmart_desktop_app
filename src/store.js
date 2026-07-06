/**
 * Persistence layer for enriched companies.
 *
 * This module talks to the Electron main process through the safe preload
 * bridge (`window.electronAPI`). The renderer process never accesses Node.js
 * or the file system directly.
 */

(function () {
  'use strict'

  async function loadCompanies() {
    if (!window.electronAPI || !window.electronAPI.loadCompanies) {
      throw new Error('Electron IPC bridge is not available')
    }
    return await window.electronAPI.loadCompanies()
  }

  async function saveCompanies(companies) {
    if (!window.electronAPI || !window.electronAPI.saveCompanies) {
      throw new Error('Electron IPC bridge is not available')
    }
    return await window.electronAPI.saveCompanies(companies)
  }

  window.CompanyStore = {
    loadCompanies,
    saveCompanies
  }
})()
