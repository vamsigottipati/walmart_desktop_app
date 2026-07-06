/**
 * Bulk enrichment job persistence (main process only).
 *
 * Saves the state of an in-progress bulk upload so it can be resumed
 * after the app is closed or restarted. Stored as JSON in userData.
 */

const { app } = require('electron')
const path = require('path')
const fs = require('fs').promises
const { existsSync } = require('fs')

const JOB_FILE = path.join(app.getPath('userData'), 'bulk-job.json')

async function loadBulkJob() {
  try {
    if (!existsSync(JOB_FILE)) return { success: true, job: null }
    const raw = await fs.readFile(JOB_FILE, 'utf8')
    const job = JSON.parse(raw)
    return { success: true, job }
  } catch (err) {
    console.error('Failed to load bulk job:', err)
    return { success: true, job: null }
  }
}

async function saveBulkJob(job) {
  try {
    await fs.writeFile(JOB_FILE, JSON.stringify(job, null, 2), 'utf8')
    return { success: true }
  } catch (err) {
    console.error('Failed to save bulk job:', err)
    return { success: false, error: err.message }
  }
}

async function clearBulkJob() {
  try {
    if (existsSync(JOB_FILE)) await fs.unlink(JOB_FILE)
    return { success: true }
  } catch (err) {
    console.error('Failed to clear bulk job:', err)
    return { success: false, error: err.message }
  }
}

module.exports = { loadBulkJob, saveBulkJob, clearBulkJob }
