/**
 * OpenRouter LLM service (main process only).
 *
 * Uses DeepSeek V4 Flash via OpenRouter to synthesize a structured
 * company profile from web context gathered by the enrichment agents.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const MODEL = 'deepseek/deepseek-v4-flash'
const DEFAULT_TIMEOUT = 30_000

function systemPrompt() {
  return (
    'You are a meticulous company data enrichment assistant. ' +
    'Given a company name and multi-source web context, produce a single valid JSON object with no markdown, no commentary, and no code fences. ' +
    'Use ALL provided context and your general knowledge to fill as many fields as possible with accurate, up-to-date values. ' +
    'If exact data is missing, infer the most likely value from context and explicitly mark inferred values when possible. ' +
    'Respond with exactly this JSON shape:\n' +
    '{\n' +
    '  "name": "company name",\n' +
    '  "description": "a concise 1-2 sentence description",\n' +
    '  "industry": "primary industry",\n' +
    '  "headquarters": "city, state/country or Unknown",\n' +
    '  "keyProducts": ["product or service 1", "product or service 2"],\n' +
    '  "employeeCount": 12345,\n' +
    '  "website": "https://...",\n' +
    '  "foundedYear": 1990,\n' +
    '  "keyStakeholders": [{"name": "Jane Doe", "role": "CEO"}, {"name": "John Smith", "role": "Founder"}],\n' +
    '  "stakeholderEmails": [{"name": "Jane Doe", "email": "jane@example.com"}, {"email": "info@example.com"}],\n' +
    '  "revenue": {"amount": "$100 billion", "year": 2024, "source": "10-K"},\n' +
    '  "funding": {"totalRaised": "$500 million", "rounds": [{"round": "Series C", "amount": "$200 million", "date": "2023"}]}\n' +
    '}\n' +
    'Rules:\n' +
    '- employeeCount and foundedYear must be numbers or null.\n' +
    '- keyProducts, keyStakeholders, and stakeholderEmails must be arrays.\n' +
    '- revenue should be an object with amount, year, and source when you can determine them; otherwise a string or null/Unknown.\n' +
    '- funding should be an object with totalRaised and rounds for venture-backed companies; for public companies with no VC funding, return null or "Public company".\n' +
    '- stakeholderEmails: include discovered emails and, when reasonable, infer likely emails for named stakeholders using the company domain.\n' +
    '- Do not include any text outside the JSON object.'
  )
}

function buildContextPayload(name, agentResults) {
  const wiki = agentResults.Wikipedia?.data || {}
  const web = agentResults.Website?.data || {}
  const edgar = agentResults.EDGAR?.data || {}
  const ddg = agentResults.DuckDuckGo?.data || {}

  const lines = []
  lines.push(`Company name: ${name}`)

  if (wiki.description) {
    lines.push(`Wikipedia title: ${wiki.title || name}`)
    lines.push(`Wikipedia extract: ${wiki.description}`)
    if (wiki.headquarters) lines.push(`Wikipedia HQ: ${wiki.headquarters}`)
    if (wiki.foundedYear) lines.push(`Wikipedia founded year: ${wiki.foundedYear}`)
    if (wiki.employeeCount) lines.push(`Wikipedia employees: ${wiki.employeeCount}`)
    if (wiki.revenue) lines.push(`Wikipedia revenue: ${wiki.revenue}`)
    if (Array.isArray(wiki.keyStakeholders) && wiki.keyStakeholders.length) {
      lines.push(`Wikipedia stakeholders: ${wiki.keyStakeholders.map((p) => `${p.name} (${p.role})`).join(', ')}`)
    }
  }

  if (web.url) {
    lines.push(`Official website: ${web.url}`)
    if (web.title) lines.push(`Website title: ${web.title}`)
    if (web.description) lines.push(`Website description: ${web.description}`)
    if (web.text) lines.push(`Website text: ${web.text}`)
    if (Array.isArray(web.emails) && web.emails.length) lines.push(`Emails found: ${web.emails.join(', ')}`)
    if (Array.isArray(web.keyStakeholders) && web.keyStakeholders.length) {
      lines.push(`Website stakeholders: ${web.keyStakeholders.map((p) => `${p.name} (${p.role})`).join(', ')}`)
    }
  }

  if (edgar.cik) {
    lines.push(`SEC CIK: ${edgar.cik}`)
    if (edgar.entityName) lines.push(`SEC entity name: ${edgar.entityName}`)
    if (edgar.revenue) lines.push(`SEC revenue: ${edgar.revenue}`)
  }

  if (Array.isArray(ddg.results) && ddg.results.length > 0) {
    lines.push('DuckDuckGo search results:')
    ddg.results.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.title || ''} - ${r.snippet || ''}`)
    })
  }

  return lines.join('\n')
}

function buildUserPrompt(name, agentResults) {
  return (
    `Synthesize a complete company profile for "${name}" using the following web context. ` +
    'Return ONLY a valid JSON object matching the requested schema. ' +
    'If exact data is unavailable, infer from context or use "Unknown" / null.\n\n' +
    buildContextPayload(name, agentResults)
  )
}

async function fetchWithTimeout(url, options, timeout = DEFAULT_TIMEOUT) {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    clearTimeout(id)
    return response
  } catch (err) {
    clearTimeout(id)
    throw err
  }
}

function extractJson(text) {
  if (!text) return null
  text = text.trim()

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) {
    text = fenceMatch[1].trim()
  }

  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    return null
  }

  try {
    return JSON.parse(text.slice(firstBrace, lastBrace + 1))
  } catch {
    return null
  }
}

function normalizeProfile(name, raw) {
  const normalizeStakeholders = (list) => {
    if (!Array.isArray(list)) return []
    return list
      .map((p) => (typeof p === 'string' ? { name: p, role: '' } : p))
      .filter((p) => p && typeof p.name === 'string' && p.name.trim())
      .map((p) => ({ name: p.name.trim(), role: (p.role || '').trim() }))
      .slice(0, 8)
  }

  const normalizeEmails = (list) => {
    if (!Array.isArray(list)) return []
    return list
      .map((e) => (typeof e === 'string' ? { email: e } : e))
      .filter((e) => e && typeof e.email === 'string' && e.email.includes('@'))
      .map((e) => ({ email: e.email.trim(), name: e.name || null }))
      .slice(0, 10)
  }

  return {
    name: String(raw.name || name).trim(),
    description: String(raw.description || '').trim() || `${name} is a company.`,
    industry: String(raw.industry || 'Unknown').trim(),
    headquarters: String(raw.headquarters || 'Unknown').trim(),
    keyProducts: Array.isArray(raw.keyProducts)
      ? raw.keyProducts.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim())
      : [],
    employeeCount: typeof raw.employeeCount === 'number' ? raw.employeeCount : null,
    website: typeof raw.website === 'string' ? raw.website.trim() : '',
    foundedYear: typeof raw.foundedYear === 'number' ? raw.foundedYear : null,
    keyStakeholders: normalizeStakeholders(raw.keyStakeholders),
    stakeholderEmails: normalizeEmails(raw.stakeholderEmails),
    revenue: raw.revenue || 'Unknown',
    funding: raw.funding || 'Unknown'
  }
}

async function callOpenRouter(apiKey, messages, maxTokens = 1200) {
  const response = await fetchWithTimeout(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/walmart-company-enrichment',
      'X-Title': 'Walmart Company Enrichment'
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.1,
      max_tokens: maxTokens
    })
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`OpenRouter returned ${response.status}: ${body}`)
  }

  return response.json()
}

/**
 * Send a minimal request to OpenRouter to verify the API key works.
 * @param {string} apiKey
 * @returns {Promise<{ok: boolean, message: string}>}
 */
async function testApiKey(apiKey) {
  if (!apiKey || !apiKey.trim()) {
    return { ok: false, message: 'API key is empty.' }
  }

  try {
    const data = await callOpenRouter(
      apiKey,
      [{ role: 'user', content: 'Say ok.' }],
      5
    )
    const reply = data.choices?.[0]?.message?.content
    if (!reply) {
      return { ok: false, message: 'OpenRouter returned an empty reply.' }
    }
    return { ok: true, message: 'Connection successful.' }
  } catch (err) {
    return { ok: false, message: err.message || 'Connection failed.' }
  }
}

/**
 * Synthesize a company profile from agent results using DeepSeek V4 Flash.
 * @param {string} name
 * @param {object} agentResults
 * @param {string} apiKey
 * @returns {Promise<object>} normalized profile
 */
async function synthesizeCompanyProfile(name, agentResults, apiKey) {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('OpenRouter API key is not configured')
  }

  const data = await callOpenRouter(apiKey, [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: buildUserPrompt(name, agentResults) }
  ])

  const content = data.choices?.[0]?.message?.content
  const parsed = extractJson(content)
  if (!parsed) {
    throw new Error('LLM response did not contain valid JSON')
  }

  return normalizeProfile(name, parsed)
}

module.exports = {
  MODEL,
  testApiKey,
  synthesizeCompanyProfile
}
