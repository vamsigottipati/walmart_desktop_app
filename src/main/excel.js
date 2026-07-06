/**
 * Excel parsing and export helpers (main process only).
 *
 * Uses the `xlsx` library to read row data from .xlsx files and write
 * enriched results back to .xlsx. The renderer never touches the file
 * system directly; it calls these functions through the IPC bridge.
 */

const XLSX = require('xlsx')

/**
 * Read the first worksheet of an .xlsx file and return an array of row objects.
 * @param {string} filePath
 * @returns {Promise<Array<object>>}
 */
async function parseExcel(filePath) {
  const workbook = XLSX.readFile(filePath, { type: 'file' })
  const sheetName = workbook.SheetNames[0]
  const worksheet = workbook.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json(worksheet, { defval: '' })
  return rows
}

/**
 * Identify the column header that most likely contains company names.
 * @param {Array<object>} rows
 * @param {string} [preferredHeader]
 * @returns {string | null}
 */
function findCompanyNameColumn(rows, preferredHeader) {
  if (!rows.length) return null
  const headers = Object.keys(rows[0])

  if (preferredHeader) {
    const exact = headers.find((h) => h.toLowerCase() === preferredHeader.toLowerCase())
    if (exact) return exact
  }

  const candidates = ['company', 'company name', 'company_name', 'name']
  for (const candidate of candidates) {
    const match = headers.find((h) => h.toLowerCase().trim() === candidate)
    if (match) return match
  }

  // Fuzzy contains match.
  for (const candidate of candidates) {
    const match = headers.find((h) => h.toLowerCase().includes(candidate))
    if (match) return match
  }

  return headers[0] || null
}

/**
 * Write an array of objects to an .xlsx file.
 * @param {Array<object>} rows
 * @param {string} destinationPath
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function exportExcel(rows, destinationPath) {
  const worksheet = XLSX.utils.json_to_sheet(rows)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Enriched')
  XLSX.writeFile(workbook, destinationPath)
  return { success: true }
}

module.exports = {
  parseExcel,
  findCompanyNameColumn,
  exportExcel
}
