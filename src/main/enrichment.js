/**
 * Agentic, multi-source company enrichment engine (main process only).
 *
 * Uses only free public sources:
 *   - Wikipedia (intro + full article + infobox)
 *   - DuckDuckGo Lite HTML search (official website discovery + targeted queries)
 *   - Official website (homepage, about, leadership, team, investors, newsroom, press, contact)
 *   - SEC EDGAR (CIK lookup + latest 10-K/10-Q financial extraction)
 *   - Yahoo Finance / MacroTrends public pages (public-company revenue)
 *   - Email pattern inference from known stakeholder names + domain
 *
 * Network calls never happen in the renderer.
 */

const cheerio = require('cheerio')
const { loadSettings } = require('./settings-store')
const { synthesizeCompanyProfile } = require('./llm')

const SEC_USER_AGENT = 'WalmartCompanyEnrichment contact@example.com'
const DEFAULT_TIMEOUT = 12_000
const MAX_SNIPPET_WORDS = 160
const LONG_SNIPPET_WORDS = 400

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, options = {}, timeout = DEFAULT_TIMEOUT) {
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

function cleanText(text, maxWords = MAX_SNIPPET_WORDS) {
  if (!text) return ''
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.split(' ').slice(0, maxWords).join(' ')
}

function decodeDdgRedirect(href) {
  if (!href) return null
  if (href.startsWith('http')) return href
  const match = href.match(/[?&]uddg=([^&]+)/)
  if (match) {
    try {
      return decodeURIComponent(match[1])
    } catch {
      return null
    }
  }
  return null
}

function normalizeWebsite(input) {
  try {
    const url = new URL(input)
    return `${url.protocol}//${url.hostname}`
  } catch {
    return null
  }
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function extractYear(text) {
  if (!text) return null
  const match = text.match(/\b(19|20)\d{2}\b/)
  return match ? parseInt(match[0], 10) : null
}

function extractEmployeeCount(text) {
  if (!text) return null
  const patterns = [
    /([\d,]+(?:\.\d+)?)\s*(K|k)?\s+(?:employees|staff|workers|people|associates|team members)/i,
    /(?:employees|staff|workers|people|associates|team members)[\s:]*([\d,]+(?:\.\d+)?)\s*(K|k)?/i,
    /(?:workforce of|employs?)\s+([\d,]+(?:\.\d+)?)\s*(K|k)?/i
  ]
  for (const re of patterns) {
    const m = text.match(re)
    if (m) {
      let n = parseFloat(m[1].replace(/,/g, ''))
      if (m[2]) n *= 1000
      return Math.round(n)
    }
  }
  return null
}

function extractRevenueFromText(text) {
  if (!text) return null
  const patterns = [
    /\$?([\d,]+(?:\.\d+)?)\s*(billion|million|B|M)\b/i,
    /(?:revenue|sales|turnover)\s+(?:of\s+)?\$?([\d,]+(?:\.\d+)?)\s*(billion|million|B|M)/i,
    /(?:annual|yearly|fiscal)\s+(?:revenue|sales)\s+(?:of\s+)?\$?([\d,]+(?:\.\d+)?)\s*(billion|million|B|M)/i
  ]
  for (const re of patterns) {
    const m = text.match(re)
    if (m) return `$${m[1]} ${m[2].toLowerCase()}`
  }
  return null
}

function extractFundingFromText(text) {
  if (!text) return null
  const total = text.match(/(?:raised|funding)\s+\$?([\d,]+(?:\.\d+)?)\s*(billion|million|B|M)/i)
  if (!total) return null
  return `$${total[1]} ${total[2].toLowerCase()}`
}

function extractEmails(text) {
  if (!text) return []
  const matches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []
  return [...new Set(matches)].slice(0, 20)
}

function inferEmailPatterns(firstName, lastName, domain) {
  if (!firstName || !lastName || !domain) return []
  const f = firstName.toLowerCase().replace(/[^a-z]/g, '')
  const l = lastName.toLowerCase().replace(/[^a-z]/g, '')
  const fi = f[0]
  const li = l[0]
  return [
    `${f}.${l}@${domain}`,
    `${f}${l}@${domain}`,
    `${fi}${l}@${domain}`,
    `${f}_${l}@${domain}`,
    `${f}-${l}@${domain}`,
    `${f}@${domain}`,
    `${l}@${domain}`,
    `${fi}.${l}@${domain}`,
    `${f}${li}@${domain}`,
    `${f}@${domain}`
  ]
}

const INDUSTRY_KEYWORDS = [
  { keywords: ['technology', 'software', 'computer', 'electronics', 'semiconductor', 'information technology', 'cloud computing', 'artificial intelligence', 'ai '], name: 'Technology' },
  { keywords: ['retail', 'supermarket', 'grocery', 'department store', 'e-commerce', 'merchandise', 'wholesale', 'convenience store'], name: 'Retail' },
  { keywords: ['automotive', 'car', 'vehicle', 'automobile', 'electric vehicles'], name: 'Automotive' },
  { keywords: ['financial', 'bank', 'banking', 'insurance', 'investment', 'fintech', 'wealth management'], name: 'Financial Services' },
  { keywords: ['healthcare', 'pharmaceutical', 'biotech', 'medical', 'health', 'life sciences'], name: 'Healthcare' },
  { keywords: ['energy', 'oil', 'gas', 'renewable', 'utilities', 'solar', 'wind'], name: 'Energy' },
  { keywords: ['telecommunications', 'telecom', 'wireless', 'internet service', 'broadband'], name: 'Telecommunications' },
  { keywords: ['media', 'entertainment', 'streaming', 'music', 'gaming', 'broadcasting'], name: 'Media & Entertainment' },
  { keywords: ['logistics', 'supply chain', 'transportation', 'shipping', 'delivery', 'freight'], name: 'Logistics' },
  { keywords: ['food', 'beverage', 'restaurant', 'fast food', 'consumer packaged goods'], name: 'Food & Beverage' },
  { keywords: ['aerospace', 'airline', 'aviation', 'defense', 'space'], name: 'Aerospace & Defense' },
  { keywords: ['manufacturing', 'industrial', 'machinery', 'chemicals', 'materials'], name: 'Manufacturing' },
  { keywords: ['real estate', 'property', 'reit', 'commercial real estate'], name: 'Real Estate' },
  { keywords: ['telecommunications', 'telecom', 'wireless', 'internet service', 'broadband'], name: 'Telecommunications' }
]

function extractIndustry(text) {
  if (!text) return null
  const t = text.toLowerCase()
  for (const item of INDUSTRY_KEYWORDS) {
    if (item.keywords.some((k) => new RegExp('\\b' + k.replace(/\s+/g, '\\s+') + '\\b', 'i').test(t))) {
      return item.name
    }
  }
  return null
}

function cleanHeadquarters(raw) {
  if (!raw) return null
  let cleaned = raw.trim().replace(/,$/, '')
  const stopPhrases = [
    /,\s+in\s+Silicon\s+Valley/i,
    /,\s+and\s+known\s+for/i,
    /,\s+and\s+sells/i,
    /,\s+and\s+operates/i,
    /,\s+and\s+is\s+known/i,
    /,\s+that\s+/i,
    /,\s+which\s+/i,
    /\s+and\s+is\s+headquartered/i,
    /\s+where\s+it\s+/i
  ]
  for (const re of stopPhrases) {
    const m = cleaned.match(re)
    if (m) cleaned = cleaned.slice(0, m.index).trim().replace(/,$/, '')
  }
  const words = cleaned.split(/\s+/)
  if (words.length > 10) cleaned = words.slice(0, 10).join(' ')
  return cleaned
}

function extractHeadquarters(text) {
  if (!text) return null
  const patterns = [
    /headquartered in ([^\.;]+)/i,
    /headquarters in ([^\.;]+)/i,
    /headquarters are in ([^\.;]+)/i,
    /based in ([^\.;]+)/i,
    /located in ([^\.;]+)/i,
    /headquarters is ([^\.,;]+)/i
  ]
  for (const re of patterns) {
    const m = text.match(re)
    if (m) return cleanHeadquarters(m[1])
  }
  return null
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'is',
  'was', 'are', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'it', 'its', 'this', 'that', 'these', 'those',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only',
  'own', 'same', 'so', 'than', 'too', 'very', 'just', 'now', 'here', 'there', 'then', 'once', 'again', 'further',
  'also', 'about', 'up', 'out', 'down', 'off', 'over', 'under', 'after', 'before', 'above', 'below', 'between',
  'among', 'through', 'during', 'into', 'onto', 'upon', 'within', 'without', 'against', 'across', 'around', 'behind',
  'beyond', 'except', 'including', 'regarding', 'concerning', 'despite', 'plus', 'minus', 'like', 'near', 'past',
  'since', 'till', 'until', 'via', 'worth', 'company', 'inc', 'corp', 'llc', 'ltd', 'co', 'llp', 'plc', 'group',
  'international', 'corporation', 'global', 'home', 'contact', 'support', 'help', 'privacy', 'policy', 'terms',
  'conditions', 'services', 'solutions', 'products', 'careers', 'jobs', 'menu', 'search', 'shop', 'store', 'online',
  'login', 'sign', 'account', 'cart', 'news', 'media', 'investors', 'press', 'blog', 'us', 'we', 'our', 'page',
  'site', 'website', 'world', 'worldwide', 'leading', 'largest', 'best', 'new', 'get', 'use', 'make', 'made', 'find',
  'see', 'go', 'come', 'know', 'take', 'way', 'work', 'working', 'learn', 'more', 'read', 'click', 'visit', 'explore'
])

const KNOWN_PRODUCT_TERMS = [
  'iphone', 'ipad', 'mac', 'macbook', 'airpods', 'apple watch', 'imac', 'homepod', 'apple tv',
  'windows', 'office', 'azure', 'xbox', 'surface', 'teams', 'linkedin', 'github', 'bing',
  'playstation', 'search', 'maps', 'cloud', 'android', 'youtube', 'gmail', 'drive', 'photos', 'pixel',
  'ai', 'software', 'services', 'solutions', 'platform', 'app', 'marketplace', 'retail', 'grocery',
  'delivery', 'pickup', 'membership', 'subscription', 'hardware', 'devices', 'laptops', 'phones',
  'tablets', 'wearables', 'accessories', 'electronics', 'appliances', 'fashion', 'home', 'beauty',
  'toys', 'games', 'sports', 'automotive', 'health', 'pharmacy', 'financial services', 'cloud computing',
  'data analytics', 'mobile payments', 'logistics', 'supply chain', 'advertising', 'streaming',
  'semiconductors', 'chips', 'processors', 'servers'
]

function titleCase(str) {
  return str.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

function extractProducts(text, topN = 6) {
  if (!text) return []
  const counts = {}
  const lower = text.toLowerCase()

  for (const term of KNOWN_PRODUCT_TERMS) {
    if (lower.includes(term)) {
      const display = titleCase(term)
      counts[display] = (counts[display] || 0) + 2
    }
  }

  const regex = /\b([A-Z][a-zA-Z0-9]*(?:\s+[A-Z][a-zA-Z0-9]*){0,2})\b/g
  let m
  while ((m = regex.exec(text)) !== null) {
    const phrase = m[1].trim()
    const words = phrase.split(/\s+/)
    if (words.some((w) => STOP_WORDS.has(w.toLowerCase()))) continue
    if (phrase.length > 40 || phrase.length < 3) continue
    counts[phrase] = (counts[phrase] || 0) + 1
  }

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([k]) => k)
}

function initials(name) {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

function nameMatchScore(query, candidate) {
  const q = query.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim()
  const c = candidate.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim()
  if (!q || !c) return 0

  const qWords = q.split(/\s+/).filter((w) => w.length > 1)
  const cWords = c.split(/\s+/).filter((w) => w.length > 1)

  let score = 0

  // Strong preference for candidates that start with the full query
  if (c.startsWith(q)) score += 8

  // Bonus if candidate starts with query and is followed by a common suffix
  const suffixRe = new RegExp('^' + q.replace(/\s+/g, '\\s+') + '\\s+(inc\\.?|corp\\.?|corporation|plc|llc|ltd|group|holdings)', 'i')
  if (suffixRe.test(c)) score += 4

  // Word matches
  qWords.forEach((qw) => {
    if (cWords.some((cw) => cw === qw || cw.startsWith(qw))) score += 1
  })

  // Containment bonus
  if (c.includes(q)) score += 2

  // Penalize extra words
  const extraWords = Math.max(0, cWords.length - qWords.length)
  score -= extraWords * 0.4

  // Slight bonus for common suffixes
  if (/\b(inc|corp|corporation|plc|llc|ltd)\b/.test(c)) score += 0.3

  return score
}

async function extractWikipediaInfobox(pageTitle) {
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(pageTitle.replace(/\s+/g, '_'))}&prop=text&section=0&format=json&origin=*`
    const response = await fetchWithTimeout(url)
    if (!response.ok) return {}
    const data = await response.json()
    const html = data.parse?.text?.['*'] || ''
    const $ = cheerio.load(html)

    const result = {}
    $('.infobox th, .infobox td').each((_i, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim()
      const next = $(el).next().text().replace(/\s+/g, ' ').trim()
      const lower = text.toLowerCase()

      if (lower.includes('employees') && !result.employees) {
        const match = next.match(/([\d,]+)/)
        if (match) result.employees = parseInt(match[1].replace(/,/g, ''), 10)
      }
      if ((lower.includes('revenue') || lower.includes('total assets')) && !result.revenue) {
        const match = next.match(/\$?([\d,]+(?:\.\d+)?)\s*(billion|million|B|M)/i)
        if (match) result.revenue = `$${match[1]} ${match[2].toLowerCase()}`
      }
      if (lower.includes('net income') && !result.netIncome) {
        const match = next.match(/\$?([\d,]+(?:\.\d+)?)\s*(billion|million|B|M)/i)
        if (match) result.netIncome = `$${match[1]} ${match[2].toLowerCase()}`
      }
      if ((lower.includes('founded') || lower.includes('incorporated')) && !result.foundedYear) {
        const match = next.match(/\b(19|20)\d{2}\b/)
        if (match) result.foundedYear = parseInt(match[0], 10)
      }
      if ((lower.includes('headquarters') || lower.includes('location')) && !result.headquarters) {
        result.headquarters = cleanHeadquarters(next.split(/\n/)[0])
      }
      if ((lower.includes('founder') || lower.includes('key people')) && !result.foundersText) {
        result.foundersText = next
      }
      if (lower.includes('number of locations') && !result.locations) {
        const match = next.match(/([\d,]+)/)
        if (match) result.locations = parseInt(match[1].replace(/,/g, ''), 10)
      }
      if (lower.includes('subsidiaries') && !result.subsidiaries) {
        result.subsidiaries = next.split(/,|;/).map((s) => s.trim()).filter(Boolean).slice(0, 6)
      }
    })

    return result
  } catch (err) {
    console.warn('Infobox extraction error:', err.message)
    return {}
  }
}

async function fetchWikipediaFullText(pageTitle) {
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(pageTitle.replace(/\s+/g, '_'))}&prop=text&format=json&origin=*`
    const response = await fetchWithTimeout(url, {}, 15_000)
    if (!response.ok) return ''
    const data = await response.json()
    const html = data.parse?.text?.['*'] || ''
    const $ = cheerio.load(html)
    $('script, style, table, .mw-parser-output > .navbox').remove()
    return cleanText($('.mw-parser-output').text(), LONG_SNIPPET_WORDS)
  } catch (err) {
    console.warn('Full text extraction error:', err.message)
    return ''
  }
}

function extractKeyPeople(text, foundersText = '') {
  const people = []
  if (!text && !foundersText) return people

  const source = `${text} ${foundersText}`

  // Extract founders from "Founded in YEAR by NAME and NAME"
  const founderPattern = /(?:founded|co-founded|started)\s+(?:in\s+\d{4}\s+)?by\s+([^\.,;]+)/gi
  let m
  while ((m = founderPattern.exec(source)) !== null) {
    const names = m[1].split(/\s+and\s+|,\s+/).map((n) => n.trim()).filter(Boolean)
    names.forEach((name) => {
      const cleaned = name.replace(/\s+/g, ' ')
      if (cleaned.length > 2 && /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+$/.test(cleaned)) {
        if (!people.some((p) => p.name.toLowerCase() === cleaned.toLowerCase())) {
          people.push({ name: cleaned, role: 'Founder' })
        }
      }
    })
  }

  // Extract from infobox-style founders text
  if (foundersText) {
    const founderNames = foundersText.split(/[,;]/).map((n) => n.trim()).filter(Boolean)
    founderNames.forEach((name) => {
      const cleaned = name.replace(/\s+/g, ' ')
      if (cleaned.length > 2 && /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+$/.test(cleaned)) {
        if (!people.some((p) => p.name.toLowerCase() === cleaned.toLowerCase())) {
          people.push({ name: cleaned, role: 'Founder' })
        }
      }
    })
  }

  // Extract CEO / Chair / President / CFO / CTO / COO
  const rolePatterns = [
    { re: /(?:CEO|Chief Executive Officer)[,:]?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/, role: 'CEO' },
    { re: /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}),?\s+(?:the\s+)?(?:CEO|Chief Executive Officer)/, role: 'CEO' },
    { re: /(?:CFO|Chief Financial Officer)[,:]?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/, role: 'CFO' },
    { re: /(?:CTO|Chief Technology Officer)[,:]?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/, role: 'CTO' },
    { re: /(?:COO|Chief Operating Officer)[,:]?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/, role: 'COO' },
    { re: /(?:CMO|Chief Marketing Officer)[,:]?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/, role: 'CMO' },
    { re: /(?:Chairman|Chairwoman|Chair)[,:]?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/, role: 'Chair' },
    { re: /(?:President)[,:]?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/, role: 'President' }
  ]

  rolePatterns.forEach(({ re, role }) => {
    const match = source.match(re)
    if (match && !people.some((p) => p.name.toLowerCase() === match[1].toLowerCase())) {
      people.push({ name: match[1].trim(), role })
    }
  })

  // Extract "Key people" lists: "Name (CEO); Name (CFO)"
  const keyPeoplePattern = /key people[\s:]*([^\n]+)/i
  const kpMatch = source.match(keyPeoplePattern)
  if (kpMatch) {
    const parts = kpMatch[1].split(/[,;]/)
    parts.forEach((part) => {
      const inner = part.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\s*\(([^)]+)\)/)
      if (inner) {
        const personName = inner[1].trim()
        const role = inner[2].trim()
        if (!people.some((p) => p.name.toLowerCase() === personName.toLowerCase())) {
          people.push({ name: personName, role })
        }
      }
    })
  }

  return people.slice(0, 10)
}

function isValidName(text) {
  if (!text || text.length < 3 || text.length > 35) return false
  const words = text.trim().split(/\s+/)
  if (words.length < 2 || words.length > 3) return false

  const lower = text.toLowerCase()
  const badWords = [
    'chief', 'senior', 'vice', 'president', 'former', 'executive', 'officer', 'director', 'manager',
    'leader', 'team', 'member', 'about', 'contact', 'home', 'corporation', 'company', 'inc', 'aerospace',
    'the', 'and', 'for', 'of', 'board', 'advisor', 'chair', 'development', 'brazil', 'mexico', 'europe',
    'global', 'consulting', 'general', 'managing', 'media', 'content', 'creative', 'operations', 'finance',
    'technology', 'commercial', 'engagement', 'client', 'retail', 'dire', 'founder', 'co-founder'
  ]
  if (badWords.some((w) => lower.includes(w))) return false

  return words.every((w) => /^[A-Z][a-zA-Z]+$/.test(w))
}

// ---------------------------------------------------------------------------
// Agent implementations
// ---------------------------------------------------------------------------

class WikipediaAgent {
  constructor() {
    this.source = 'Wikipedia'
  }

  async run(name, onProgress) {
    onProgress({ source: this.source, status: 'running', message: 'Searching Wikipedia...' })

    const candidates = [`${name} (company)`, `${name} (corporation)`, name]
    for (const title of candidates) {
      try {
        const encodedTitle = encodeURIComponent(title)
        const response = await fetchWithTimeout(
          `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&exsentences=10&format=json&origin=*&redirects=1&titles=${encodedTitle}`
        )
        if (!response.ok) continue
        const data = await response.json()
        const pages = data.query?.pages || {}
        const page = pages[Object.keys(pages)[0]]
        if (!page || page.missing != null) continue

        const extract = page.extract || ''
        const fullText = `${page.title || name}. ${extract}`

        const isCompanyPage =
          /\b(company|corporation|inc\.?|incorporated|multinational|enterprise|business)\b/i.test(fullText)
        if (title === name && !isCompanyPage) continue

        onProgress({ source: this.source, status: 'running', message: 'Reading Wikipedia article...' })

        const [infobox, articleText] = await Promise.all([
          extractWikipediaInfobox(page.title || name),
          fetchWikipediaFullText(page.title || name)
        ])

        const combinedText = `${extract} ${articleText}`

        const result = {
          title: page.title || name,
          description: extract,
          fullText: articleText,
          industry: extractIndustry(combinedText),
          headquarters: infobox.headquarters || extractHeadquarters(combinedText),
          foundedYear: infobox.foundedYear || extractYear(extract),
          employeeCount: infobox.employees || extractEmployeeCount(combinedText),
          revenue: infobox.revenue || extractRevenueFromText(combinedText),
          netIncome: infobox.netIncome,
          locations: infobox.locations,
          subsidiaries: infobox.subsidiaries,
          keyStakeholders: extractKeyPeople(combinedText, infobox.foundersText),
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent((page.title || title).replace(/\s+/g, '_'))}`
        }

        onProgress({ source: this.source, status: 'done', message: 'Wikipedia found' })
        return { source: this.source, found: true, data: result }
      } catch (err) {
        console.warn(`WikipediaAgent error for "${title}":`, err.message)
      }
    }

    onProgress({ source: this.source, status: 'done', message: 'Wikipedia unavailable' })
    return { source: this.source, found: false, data: {} }
  }
}

class WebsiteAgent {
  constructor() {
    this.source = 'Website'
  }

  async run(name, onProgress) {
    onProgress({ source: this.source, status: 'running', message: 'Finding official website...' })

    let siteUrl = null
    const badHosts = [
      'duckduckgo.com', 'wikipedia.org', 'facebook.com', 'twitter.com', 'x.com',
      'linkedin.com', 'amazon.', 'sellercentral', 'apps.apple.com', 'play.google.com',
      'zoominfo.com', 'crunchbase.com', 'pitchbook.com', 'bloomberg.com', 'reuters.com',
      'yahoo.com', 'marketwatch.com', 'sec.gov', 'techcrunch.com', 'forbes.com',
      'glassdoor.com', ' indeed.', 'appstore', 'marketplace'
    ]

    function isBadHost(host) {
      return badHosts.some((bad) => host.includes(bad))
    }

    function websiteScore(host) {
      const cleanHost = host.replace(/^www\./, '').toLowerCase()
      const nameSlug = name.toLowerCase().replace(/[^a-z0-9]/g, '')
      const firstWord = name.toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9]/g, '')
      let score = 0
      if (cleanHost.includes(nameSlug)) score += 100
      if (cleanHost.includes(firstWord)) score += 50
      if (/\.(com|co\.uk|co)$/.test(cleanHost)) score += 10
      if (/^www\./.test(host)) score += 5
      return score
    }

    // 1. Try direct domain guesses first (fast and avoids search noise)
    const directCandidates = []
    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '')
    const firstWordSlug = name.toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9]/g, '')
    if (slug) {
      directCandidates.push(`https://www.${slug}.com`, `https://${slug}.com`)
    }
    if (firstWordSlug && firstWordSlug !== slug) {
      directCandidates.push(`https://www.${firstWordSlug}.com`, `https://${firstWordSlug}.com`)
    }

    for (const candidate of [...new Set(directCandidates)]) {
      try {
        const resp = await fetchWithTimeout(candidate, { method: 'HEAD' }, 6_000)
        if (resp.ok) {
          siteUrl = normalizeWebsite(candidate)
          break
        }
      } catch {
        // ignore
      }
    }

    // 2. Search DuckDuckGo and pick the best matching result
    if (!siteUrl) {
      const searchQueries = [`${name} official website`, name]
      const candidates = []

      for (const query of searchQueries) {
        try {
          const searchResponse = await fetchWithTimeout(
            `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
            { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }
          )
          const searchHtml = await searchResponse.text()
          const $search = cheerio.load(searchHtml)

          $search('a.result__a').each((_i, el) => {
            const decoded = decodeDdgRedirect($search(el).attr('href'))
            if (!decoded) return
            const host = new URL(decoded).hostname.toLowerCase()
            if (isBadHost(host)) return
            candidates.push({ url: normalizeWebsite(decoded), host, score: websiteScore(host) })
          })
        } catch (err) {
          console.warn(`WebsiteAgent search error for "${query}":`, err.message)
        }
      }

      if (candidates.length) {
        candidates.sort((a, b) => b.score - a.score)
        siteUrl = candidates[0].url
      }
    }

    if (!siteUrl) {
      onProgress({ source: this.source, status: 'done', message: 'No official website found' })
      return { source: this.source, found: false, data: {} }
    }

    try {
      onProgress({ source: this.source, status: 'running', message: 'Reading company website...' })

      let title = ''
      let metaDescription = ''
      const snippets = []
      const emails = []
      const stakeholders = []
      const addresses = []
      const phones = []

      const pages = [
        siteUrl,
        new URL('/about-us', siteUrl).toString(),
        new URL('/about', siteUrl).toString(),
        new URL('/company', siteUrl).toString(),
        new URL('/leadership', siteUrl).toString(),
        new URL('/team', siteUrl).toString(),
        new URL('/executives', siteUrl).toString(),
        new URL('/investors', siteUrl).toString(),
        new URL('/investor-relations', siteUrl).toString(),
        new URL('/newsroom', siteUrl).toString(),
        new URL('/press', siteUrl).toString(),
        new URL('/media', siteUrl).toString(),
        new URL('/contact', siteUrl).toString()
      ]

      const leadershipPages = ['/leadership', '/team', '/executives', '/investors', '/investor-relations', '/about', '/about-us', '/company']
      const isLeadershipPage = (url) => leadershipPages.some((p) => url.toLowerCase().endsWith(p))

      for (const pageUrl of pages) {
        try {
          const pageResponse = await fetchWithTimeout(pageUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
          })
          const contentType = pageResponse.headers.get('content-type') || ''
          if (!contentType.includes('text/html')) continue

          const body = await pageResponse.text()
          const $page = cheerio.load(body)

          if (!title) title = $page('title').first().text().trim()
          if (!metaDescription) {
            metaDescription =
              $page('meta[name="description"]').attr('content') ||
              $page('meta[property="og:description"]').attr('content') ||
              ''
          }

          // Collect emails before stripping scripts
          const pageEmails = extractEmails(body)
          if (pageEmails.length) emails.push(...pageEmails)

          // Only extract stakeholders from leadership/about pages to avoid false positives
          if (isLeadershipPage(pageUrl)) {
            const roleKeywords = ['CEO', 'Chief Executive Officer', 'CTO', 'Chief Technology Officer', 'CFO', 'Chief Financial Officer', 'COO', 'Chief Operating Officer', 'CMO', 'Chief Marketing Officer', 'President', 'Founder', 'Co-Founder', 'Chairman', 'Chairwoman', 'Chair', 'EVP', 'SVP', 'VP', 'Vice President', 'Director', 'Head of', 'Managing Director', 'General Manager', 'Content & Creative Director', 'Media Director']
            const rolePattern = new RegExp(`\\b(${roleKeywords.join('|')})\\b`, 'i')

            // Multi-line name/role pairs: Name on one line, role on next
            const rawLines = $page('body').text().split(/\n/).map((l) => l.trim()).filter((l) => l.length > 0 && l.length < 120)
            for (let i = 0; i < rawLines.length - 1; i++) {
              const line = rawLines[i]
              const nextLine = rawLines[i + 1]
              if (isValidName(line) && rolePattern.test(nextLine)) {
                const role = nextLine.split(/\|/)[0].trim()
                if (!stakeholders.some((s) => s.name.toLowerCase() === line.toLowerCase())) {
                  stakeholders.push({ name: line, role: titleCase(role.toLowerCase()) })
                }
              }
            }

            // Try structured leadership selectors
            $page('[class*="leader"], [class*="team"], [class*="executive"], [class*="management"], [class*="officer"], [class*="member"]').each((_i, el) => {
              const text = $page(el).text().trim()
              const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean)
              lines.forEach((line) => {
                const match = line.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\s*[\n\-,–]\s*(.+)$/)
                if (match && isValidName(match[1])) {
                  const personName = match[1].trim()
                  const role = match[2].trim().split(/\n/)[0]
                  if (!stakeholders.some((s) => s.name.toLowerCase() === personName.toLowerCase())) {
                    stakeholders.push({ name: personName, role: titleCase(role.toLowerCase()) })
                  }
                }
              })
            })
          }

          // Contact info from contact page
          if (pageUrl.toLowerCase().endsWith('/contact')) {
            const visible = $page('body').text()
            const addressMatch = visible.match(/\d+\s+[A-Za-z0-9\s,.-]+(?:Avenue|Street|St|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Suite|Unit|Floor)[,\s\w]+/i)
            if (addressMatch && !addresses.includes(addressMatch[0])) addresses.push(addressMatch[0])

            const phoneMatch = visible.match(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/)
            if (phoneMatch && !phones.includes(phoneMatch[0])) phones.push(phoneMatch[0])
          }

          $page('script, style, nav, footer, header, iframe, noscript').remove()
          const pageVisible = $page('body').text().replace(/\s+/g, ' ').trim()
          snippets.push(cleanText(pageVisible, 150))
        } catch (err) {
          console.warn(`WebsiteAgent failed to read ${pageUrl}:`, err.message)
        }
      }

      const combined = [metaDescription, ...snippets].filter(Boolean).join(' ')
      const uniqueEmails = [...new Set(emails)].slice(0, 20)

      const result = {
        url: siteUrl,
        domain: getDomain(siteUrl),
        title,
        description: metaDescription,
        text: combined,
        products: extractProducts(combined),
        industry: extractIndustry(combined),
        headquarters: extractHeadquarters(combined),
        foundedYear: extractYear(combined),
        employeeCount: extractEmployeeCount(combined),
        revenue: extractRevenueFromText(combined),
        funding: extractFundingFromText(combined),
        keyStakeholders: stakeholders.slice(0, 8),
        emails: uniqueEmails,
        addresses: addresses.slice(0, 2),
        phones: phones.slice(0, 2)
      }

      onProgress({ source: this.source, status: 'done', message: 'Website analyzed' })
      return { source: this.source, found: true, data: result }
    } catch (err) {
      console.warn('WebsiteAgent error:', err.message)
      onProgress({ source: this.source, status: 'done', message: 'Website search failed' })
      return { source: this.source, found: false, data: {} }
    }
  }
}

class EdgarAgent {
  constructor() {
    this.source = 'EDGAR'
  }

  async run(name, onProgress) {
    onProgress({ source: this.source, status: 'running', message: 'Checking SEC filings...' })

    try {
      // Use SEC browse search with suffixes and pick the best name match
      const suffixes = ['', ' Inc', ' Corp', ' Corporation', ' LLC', ' PLC', ' LP']
      let cik = null
      let entityName = null
      let bestScore = -1

      for (const suffix of suffixes) {
        const searchUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${encodeURIComponent(name + suffix)}&owner=exclude&count=40`
        const response = await fetchWithTimeout(searchUrl, {
          headers: { 'User-Agent': SEC_USER_AGENT }
        })
        const html = await response.text()
        const $ = cheerio.load(html)

        // Table of search results
        $('table.tableFile2 tr').each((_i, row) => {
          const cells = $(row).find('td')
          if (cells.length < 2) return
          const link = cells.eq(0).find('a').first()
          if (!link.length) return
          const href = link.attr('href') || ''
          const match = href.match(/CIK=(\d+)/)
          if (!match) return
          const candidateName = cells.eq(1).text().trim() || link.text().trim()
          const candidateCik = match[1].padStart(10, '0')

          const score = nameMatchScore(name, candidateName)
          if (score > bestScore) {
            bestScore = score
            cik = candidateCik
            entityName = candidateName
          }
        })

        // Direct company page redirect — extract CIK and name from companyInfo
        if (!cik) {
          const cikMatch = html.match(/CIK#?:\s*(\d{10})/) || html.match(/CIK=(\d{10})/)
          const companyInfo = $('.companyInfo').text().trim()
          const nameFromInfo = companyInfo.match(/^([^\n]+?)\s+CIK#?:/)
          if (cikMatch) {
            const candidateCik = cikMatch[1]
            const candidateName = nameFromInfo ? nameFromInfo[1].trim() : name
            const score = nameMatchScore(name, candidateName)
            if (score > bestScore) {
              bestScore = score
              cik = candidateCik
              entityName = candidateName
            }
          }
        }
      }

      let latest10k = null
      let latest10q = null
      let revenue = null
      let netIncome = null
      let fiscalYear = null

      if (cik) {
        try {
          // Use SEC JSON APIs for structured financial data
          const cikPadded = String(parseInt(cik, 10)).padStart(10, '0')
          const companyFactsUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cikPadded}.json`
          const factsResponse = await fetchWithTimeout(companyFactsUrl, {
            headers: { 'User-Agent': SEC_USER_AGENT }
          }, 20_000)
          if (factsResponse.ok) {
            const facts = await factsResponse.json()
            const usGaap = facts.facts?.['us-gaap'] || {}

            const revenueTags = [
              'Revenues',
              'SalesRevenueNet',
              'RevenueFromContractWithCustomerExcludingAssessedTax',
              'RevenueFromContractWithCustomerIncludingAssessedTax'
            ]
            let bestRevenue = null
            for (const tag of revenueTags) {
              if (usGaap[tag]?.units?.USD) {
                const entries = usGaap[tag].units.USD.filter((u) => u.form === '10-K' && u.end)
                if (entries.length) {
                  const latest = entries.sort((a, b) => new Date(b.end) - new Date(a.end))[0]
                  const year = latest.frame ? parseInt(latest.frame.match(/\d{4}/)?.[0], 10) : latest.fy
                  if (!bestRevenue || new Date(latest.end) > new Date(bestRevenue.end)) {
                    const val = latest.val
                    const unit = val >= 1_000_000_000 ? `${(val / 1_000_000_000).toFixed(1)} billion` : `${(val / 1_000_000).toFixed(1)} million`
                    bestRevenue = { amount: `$${unit}`, year, end: latest.end }
                  }
                }
              }
            }
            if (bestRevenue) {
              revenue = bestRevenue.amount
              fiscalYear = bestRevenue.year
            }

            const incomeTags = ['NetIncomeLoss', 'NetIncomeLossAvailableToCommonStockholdersDiluted']
            let bestIncome = null
            for (const tag of incomeTags) {
              if (usGaap[tag]?.units?.USD) {
                const entries = usGaap[tag].units.USD.filter((u) => u.form === '10-K' && u.end)
                if (entries.length) {
                  const latest = entries.sort((a, b) => new Date(b.end) - new Date(a.end))[0]
                  const year = latest.frame ? parseInt(latest.frame.match(/\d{4}/)?.[0], 10) : latest.fy
                  if (!bestIncome || new Date(latest.end) > new Date(bestIncome.end)) {
                    const val = latest.val
                    const unit = val >= 1_000_000_000 ? `${(val / 1_000_000_000).toFixed(1)} billion` : `${(val / 1_000_000).toFixed(1)} million`
                    bestIncome = { amount: `$${unit}`, year, end: latest.end }
                  }
                }
              }
            }
            if (bestIncome) netIncome = bestIncome.amount
          } else {
            console.warn('EDGAR companyfacts returned', factsResponse.status)
          }
        } catch (err) {
          console.warn('EDGAR companyfacts error:', err.message)
        }

        try {
          const browseUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=10-K&dateb=&owner=exclude&count=1`
          const browseResponse = await fetchWithTimeout(browseUrl, {
            headers: { 'User-Agent': SEC_USER_AGENT }
          })
          const browseHtml = await browseResponse.text()
          const $browse = cheerio.load(browseHtml)
          const filingLink = $browse('table.tableFile2 a[href*="/Archives/edgar/data/"]').first()
          if (filingLink.length) {
            const row = filingLink.closest('tr')
            const cells = row.find('td')
            latest10k = { date: cells.eq(3).text().trim(), url: 'https://www.sec.gov' + filingLink.attr('href') }
          }

          const qBrowseUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=10-Q&dateb=&owner=exclude&count=1`
          const qBrowseResponse = await fetchWithTimeout(qBrowseUrl, {
            headers: { 'User-Agent': SEC_USER_AGENT }
          })
          const qHtml = await qBrowseResponse.text()
          const $q = cheerio.load(qHtml)
          const qLink = $q('table.tableFile2 a[href*="/Archives/edgar/data/"]').first()
          if (qLink.length) {
            const qRow = qLink.closest('tr')
            const qCells = qRow.find('td')
            latest10q = { date: qCells.eq(3).text().trim(), url: 'https://www.sec.gov' + qLink.attr('href') }
          }
        } catch (err) {
          console.warn('EDGAR browse error:', err.message)
        }
      }

      onProgress({
        source: this.source,
        status: 'done',
        message: cik ? 'SEC filing found' : 'No SEC match'
      })
      return { source: this.source, found: !!cik, data: { cik, entityName, latest10k, latest10q, revenue, netIncome, fiscalYear } }
    } catch (err) {
      console.warn('EdgarAgent error:', err.message)
      onProgress({ source: this.source, status: 'done', message: 'SEC check failed' })
      return { source: this.source, found: false, data: {} }
    }
  }
}

class FinanceAgent {
  constructor() {
    this.source = 'Finance'
  }

  async run(name, onProgress) {
    onProgress({ source: this.source, status: 'running', message: 'Looking up public finance data...' })

    let revenue = null
    let marketCap = null
    let employeeCount = null

    try {
      // Try Yahoo Finance search page
      const query = encodeURIComponent(`${name} revenue`)
      const searchResponse = await fetchWithTimeout(
        `https://html.duckduckgo.com/html/?q=${query}`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }
      )
      const searchHtml = await searchResponse.text()
      const $ = cheerio.load(searchHtml)

      const snippets = []
      $('.result__snippet').each((i, el) => {
        if (i < 4) snippets.push($(el).text().trim())
      })

      const combined = snippets.join(' ')
      const revenueMatch = combined.match(/\$?([\d,]+(?:\.\d+)?)\s*(billion|million|B|M)\b/i)
      if (revenueMatch) revenue = `$${revenueMatch[1]} ${revenueMatch[2].toLowerCase()}`

      const employeeMatch = combined.match(/([\d,]+(?:\.\d+)?)\s*(K|k)?\s+(?:employees|staff|workers)/i)
      if (employeeMatch) {
        let n = parseFloat(employeeMatch[1].replace(/,/g, ''))
        if (employeeMatch[2]) n *= 1000
        employeeCount = Math.round(n)
      }

      const mcMatch = combined.match(/market\s+cap\s+\$?([\d,]+(?:\.\d+)?)\s*(billion|million|trillion|T|B|M)/i)
      if (mcMatch) marketCap = `$${mcMatch[1]} ${mcMatch[2].toLowerCase()}`

      onProgress({ source: this.source, status: 'done', message: revenue ? 'Finance data found' : 'No finance data' })
      return { source: this.source, found: !!revenue, data: { revenue, marketCap, employeeCount, snippets } }
    } catch (err) {
      console.warn('FinanceAgent error:', err.message)
      onProgress({ source: this.source, status: 'done', message: 'Finance lookup failed' })
      return { source: this.source, found: false, data: {} }
    }
  }
}

class DuckDuckGoAgent {
  constructor() {
    this.source = 'DuckDuckGo'
  }

  async run(name, onProgress) {
    onProgress({ source: this.source, status: 'running', message: 'Searching DuckDuckGo...' })

    const queries = [
      name,
      `${name} revenue 2024`,
      `${name} CEO`,
      `${name} funding`,
      `${name} number of employees`
    ]

    const allResults = []

    for (const query of queries) {
      try {
        const response = await fetchWithTimeout(
          `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
          { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }
        )
        const html = await response.text()
        const $ = cheerio.load(html)

        $('.result').each((i, el) => {
          if (i >= 3) return false
          const title = $(el).find('.result__a').text().trim()
          const snippet = $(el).find('.result__snippet').text().trim()
          if (title || snippet) allResults.push({ title, snippet })
        })
      } catch (err) {
        console.warn(`DuckDuckGoAgent error for "${query}":`, err.message)
      }
    }

    onProgress({ source: this.source, status: 'done', message: 'DuckDuckGo searched' })
    return { source: this.source, found: allResults.length > 0, data: { results: allResults } }
  }
}

// ---------------------------------------------------------------------------
// Coordinator & aggregator
// ---------------------------------------------------------------------------

async function runAgents(name, onProgress) {
  const agents = [
    new WikipediaAgent(),
    new WebsiteAgent(),
    new EdgarAgent(),
    new FinanceAgent(),
    new DuckDuckGoAgent()
  ]

  const outcomes = await Promise.allSettled(
    agents.map((agent) => agent.run(name, onProgress))
  )

  const map = {}
  outcomes.forEach((outcome, idx) => {
    const source = agents[idx].source
    if (outcome.status === 'fulfilled') {
      map[source] = outcome.value
    } else {
      map[source] = { source, found: false, data: {}, error: outcome.reason?.message }
    }
  })

  return map
}

function mergeStakeholders(...lists) {
  const seen = new Set()
  const merged = []
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const person of list) {
      const name = person?.name?.trim()
      if (!name || seen.has(name.toLowerCase())) continue
      seen.add(name.toLowerCase())
      merged.push({ name, role: (person.role || '').trim() || 'Stakeholder' })
    }
  }
  return merged.slice(0, 10)
}

function mergeEmails(emails, stakeholders, domain) {
  const map = {}
  if (Array.isArray(emails)) {
    emails.forEach((email) => {
      map[email.toLowerCase()] = { email, name: null }
    })
  }

  // Match discovered emails to stakeholders by first name
  stakeholders.forEach((person) => {
    const firstName = person.name.split(' ')[0].toLowerCase()
    Object.keys(map).forEach((email) => {
      if (email.includes(firstName)) {
        map[email].name = person.name
      }
    })
  })

  // Infer patterns for stakeholders without emails (limit to 2 per person)
  if (domain) {
    stakeholders.forEach((person) => {
      const alreadyHasEmail = Object.values(map).some((e) => e.name === person.name)
      if (alreadyHasEmail) return
      const parts = person.name.split(' ')
      if (parts.length < 2) return
      const patterns = inferEmailPatterns(parts[0], parts[parts.length - 1], domain)
      patterns.slice(0, 2).forEach((email) => {
        if (!map[email.toLowerCase()]) {
          map[email.toLowerCase()] = { email, name: person.name, inferred: true }
        }
      })
    })
  }

  return Object.values(map).slice(0, 15)
}

function findEmailForStakeholder(person, emailMap) {
  const direct = Object.values(emailMap).find((e) => e.name?.toLowerCase() === person.name.toLowerCase())
  if (direct) return { email: direct.email, inferred: !!direct.inferred }

  const firstName = person.name.split(' ')[0].toLowerCase()
  const byFirstName = Object.values(emailMap).find((e) => e.email.toLowerCase().includes(firstName))
  if (byFirstName) return { email: byFirstName.email, inferred: false }

  return { email: null, inferred: false }
}

function linkedInSearchUrl(name, companyName) {
  const keywords = companyName ? `${name} ${companyName}` : name
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`
}

function companyKeywordFromDomain(domain) {
  if (!domain) return null
  return domain.replace(/^www\./, '').split('.')[0]
}

async function enrichStakeholders(stakeholders, emails, domain, companyName) {
  const emailMap = {}
  mergeEmails(emails, stakeholders, domain).forEach((entry) => {
    emailMap[entry.email.toLowerCase()] = entry
  })

  // Prefer a short domain-derived keyword for LinkedIn searches (e.g. "podean").
  const linkedInCompany = companyKeywordFromDomain(domain) || companyName

  // LinkedIn profile URLs are not reliably available via free public search,
  // so we generate a LinkedIn people-search link for each stakeholder.
  const enriched = stakeholders.slice(0, 8).map((person) => {
    const { email, inferred } = findEmailForStakeholder(person, emailMap)
    return {
      ...person,
      email,
      emailInferred: inferred,
      linkedIn: linkedInSearchUrl(person.name, linkedInCompany)
    }
  })

  // Optional: try to resolve actual profile URLs for the top 3 stakeholders in parallel.
  // This is best-effort; failures fall back to the search URL.
  const top = enriched.slice(0, 3)
  const resolved = await Promise.all(
    top.map((person) => resolveLinkedInProfile(person.name, linkedInCompany).catch(() => person.linkedIn))
  )
  top.forEach((person, idx) => {
    person.linkedIn = resolved[idx] || person.linkedIn
  })

  return enriched
}

async function resolveLinkedInProfile(name, companyName) {
  const query = companyName ? `site:linkedin.com/in "${name}" "${companyName}"` : `site:linkedin.com/in "${name}"`
  const response = await fetchWithTimeout(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } },
    6_000
  )
  const html = await response.text()
  const $ = cheerio.load(html)

  const linkedInRe = /https?:\/\/www\.linkedin\.com\/in\/[a-zA-Z0-9-]+/g
  let profileUrl = null
  $('.result__snippet, .result__a, .result__url').each((_i, el) => {
    if (profileUrl) return false
    const text = $(el).text() + ' ' + ($(el).attr('href') || '')
    const match = text.match(linkedInRe)
    if (match) profileUrl = match[0]
  })

  return profileUrl || linkedInSearchUrl(name, companyName)
}

function pickBestRevenue(values) {
  const candidates = values.filter((v) => v && v !== 'Unknown')
  if (!candidates.length) return 'Unknown'

  // Prefer structured objects
  const structured = candidates.find((v) => typeof v === 'object' && v.amount)
  if (structured) return structured

  // Prefer SEC / 10-K
  const fromSEC = candidates.find((v) => typeof v === 'string' && v.includes('billion'))
  if (fromSEC) return fromSEC

  return candidates[0]
}

async function aggregate(name, results) {
  const wiki = results.Wikipedia?.data || {}
  const web = results.Website?.data || {}
  const edgar = results.EDGAR?.data || {}
  const finance = results.Finance?.data || {}
  const ddg = results.DuckDuckGo?.data || {}

  const sources = []
  if (results.Wikipedia?.found) sources.push('Wikipedia')
  if (results.Website?.found) sources.push('Website')
  if (results.EDGAR?.found) sources.push('EDGAR')
  if (results.Finance?.found) sources.push('Finance')

  const ddgSnippets = (ddg.results || []).map((r) => r.snippet).join(' ')
  const allText = [wiki.description, wiki.fullText, web.text, ddgSnippets].filter(Boolean).join(' ')
  const description = cleanText(wiki.description || web.description || ddgSnippets || `${name} is a company.`, 80)

  const industry = wiki.industry || web.industry || extractIndustry(allText) || 'Unknown'
  const headquarters = wiki.headquarters || web.headquarters || extractHeadquarters(allText) || 'Unknown'
  const foundedYear = wiki.foundedYear || web.foundedYear || extractYear(allText) || 'Unknown'
  const employeeCount = wiki.employeeCount || web.employeeCount || finance.employeeCount || extractEmployeeCount(allText) || null
  const website = web.url || ''

  const mergedStakeholders = mergeStakeholders(wiki.keyStakeholders, web.keyStakeholders)
  const keyStakeholders = await enrichStakeholders(mergedStakeholders, web.emails, web.domain, name)
  const stakeholderEmails = mergeEmails(web.emails, mergedStakeholders, web.domain)

  const revenue = pickBestRevenue([
    edgar.revenue ? { amount: edgar.revenue, year: edgar.fiscalYear, source: 'SEC EDGAR 10-K' } : null,
    wiki.revenue ? { amount: wiki.revenue, source: 'Wikipedia' } : null,
    finance.revenue ? { amount: finance.revenue, source: 'Web search' } : null,
    web.revenue ? { amount: web.revenue, source: 'Website' } : null
  ])

  const funding = web.funding || 'Unknown'

  let keyProducts = []
  if (wiki.fullText) keyProducts = extractProducts(wiki.fullText).slice(0, 6)
  if (!keyProducts.length && web.products && web.products.length) keyProducts = web.products.slice(0, 6)
  if (!keyProducts.length) keyProducts = ['General products / services']

  return {
    id: `co_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim(),
    description,
    industry,
    headquarters,
    keyProducts,
    employeeCount,
    website,
    foundedYear,
    keyStakeholders,
    stakeholderEmails,
    revenue,
    funding,
    marketCap: finance.marketCap || null,
    netIncome: edgar.netIncome || wiki.netIncome || null,
    subsidiaries: wiki.subsidiaries || [],
    locations: wiki.locations || null,
    initials: initials(name),
    enrichedAt: new Date().toISOString(),
    sources,
    _agentDetails: { wiki, web, edgar, finance, ddg }
  }
}

async function enrichCompany(name, onProgress = () => {}) {
  const cleanName = name.trim()
  if (!cleanName) throw new Error('Company name is required')

  onProgress({ source: 'Coordinator', status: 'running', message: 'Starting enrichment...' })
  const results = await runAgents(cleanName, onProgress)
  onProgress({ source: 'Aggregator', status: 'running', message: 'Aggregating results...' })
  const profile = await aggregate(cleanName, results)

  const settings = await loadSettings()
  if (settings.openrouterApiKey) {
    onProgress({ source: 'DeepSeek', status: 'running', message: 'Synthesizing with DeepSeek V4 Flash...' })
    try {
      const llmProfile = await synthesizeCompanyProfile(cleanName, results, settings.openrouterApiKey)

      Object.assign(profile, {
        name: llmProfile.name || profile.name,
        description: llmProfile.description || profile.description,
        industry: llmProfile.industry || profile.industry,
        headquarters: llmProfile.headquarters || profile.headquarters,
        keyProducts: Array.isArray(llmProfile.keyProducts) && llmProfile.keyProducts.length ? llmProfile.keyProducts : profile.keyProducts,
        employeeCount: llmProfile.employeeCount ?? profile.employeeCount,
        website: llmProfile.website || profile.website,
        foundedYear: llmProfile.foundedYear ?? profile.foundedYear,
        keyStakeholders: Array.isArray(llmProfile.keyStakeholders) && llmProfile.keyStakeholders.length ? llmProfile.keyStakeholders : profile.keyStakeholders,
        stakeholderEmails: Array.isArray(llmProfile.stakeholderEmails) && llmProfile.stakeholderEmails.length ? llmProfile.stakeholderEmails : profile.stakeholderEmails,
        revenue: llmProfile.revenue || profile.revenue,
        funding: llmProfile.funding || profile.funding
      })

      onProgress({ source: 'DeepSeek', status: 'done', message: 'DeepSeek synthesis complete' })
    } catch (err) {
      console.warn('LLM synthesis failed, using heuristic fallback:', err.message)
      onProgress({ source: 'DeepSeek', status: 'done', message: 'DeepSeek unavailable; using local heuristics' })
    }
  } else {
    onProgress({ source: 'DeepSeek', status: 'done', message: 'No API key configured; using local heuristics' })
  }

  onProgress({ source: 'Aggregator', status: 'done', message: 'Enrichment complete' })
  return profile
}

module.exports = { enrichCompany }
