/**
 * Agentic web search (Perplexity-style).
 *
 * Main process only. Performs iterative DuckDuckGo searches, fetches pages,
 * decides whether more searches are needed, and synthesizes a cited answer
 * via OpenRouter DeepSeek V4 Flash.
 */

const cheerio = require('cheerio')
const { callOpenRouter, extractJson } = require('./llm')

const MAX_ITERATIONS = 3
const RESULTS_PER_SEARCH = 5
const MAX_SOURCE_TEXT_LENGTH = 6000
const FETCH_TIMEOUT = 10_000
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

async function fetchWithTimeout(url, options = {}, timeout = FETCH_TIMEOUT) {
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

function decodeDdgRedirect(href) {
  if (!href) return null
  try {
    const url = new URL(href, 'https://duckduckgo.com')
    const u = url.searchParams.get('uddg')
    if (u) return decodeURIComponent(u)
    if (!href.includes('duckduckgo.com')) return href
    return null
  } catch {
    return null
  }
}

async function searchDuckDuckGo(query) {
  const results = []
  try {
    const response = await fetchWithTimeout(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { headers: { 'User-Agent': USER_AGENT } },
      15_000
    )
    const html = await response.text()
    const $ = cheerio.load(html)

    $('.result').each((_i, el) => {
      if (results.length >= RESULTS_PER_SEARCH) return false
      const title = $(el).find('.result__a').text().trim()
      const snippet = $(el).find('.result__snippet').text().trim()
      const href = decodeDdgRedirect($(el).find('.result__a').attr('href'))
      if (href && (title || snippet)) {
        results.push({ title, snippet, url: href })
      }
    })
  } catch (err) {
    console.warn('Agentic search DDG error:', err.message)
  }
  return results
}

function isChallengePage(title, text) {
  if (!title || !text) return true
  const t = title.toLowerCase()
  const lower = text.toLowerCase()
  const challengeMarkers = ['just a moment', 'are you human', 'captcha', 'cloudflare', 'access denied', 'please wait', 'enable javascript', 'verify you are human']
  if (challengeMarkers.some((m) => t.includes(m))) return true
  if (text.length < 80) return true
  if (lower.includes('enable cookies') && lower.includes('captcha')) return true
  return false
}

async function fetchPageContent(url, fallbackTitle = '') {
  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html'
      }
    })
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('text/html')) return null

    const html = await response.text()
    const $ = cheerio.load(html)

    $('script, style, nav, footer, header, iframe, noscript, aside, .advertisement').remove()

    let title = $('title').first().text().trim() || fallbackTitle
    let description =
      $('meta[name="description"]').attr('content') ||
      $('meta[property="og:description"]').attr('content') ||
      ''

    let text = $('article, main, .content, #content, body').first().text()
    text = text.replace(/\s+/g, ' ').trim()

    if (isChallengePage(title, text)) {
      return null
    }

    return {
      title,
      description,
      text: text.slice(0, MAX_SOURCE_TEXT_LENGTH)
    }
  } catch (err) {
    console.warn(`Agentic search fetch error for ${url}:`, err.message)
    return null
  }
}

function truncateContext(sources) {
  let total = 0
  const kept = []
  for (const source of sources) {
    const len = (source.text || '').length
    if (total + len > 18000 && kept.length >= 3) break
    kept.push(source)
    total += len
  }
  return kept
}

function buildSourceContext(sources) {
  const kept = truncateContext(sources)
  return kept
    .map((s, i) => {
      return `[${i + 1}] ${s.title || 'Source'}\nURL: ${s.url}\n${s.description ? s.description + '\n' : ''}${s.text || ''}`
    })
    .join('\n\n---\n\n')
}

async function evaluateSufficiency(originalQuery, currentQuery, sources, apiKey) {
  if (!apiKey) return { sufficient: false, followUpQueries: [] }

  const context = buildSourceContext(sources)
  const prompt = `You are a research planner. The user asked: "${originalQuery}"

We have gathered the following web sources while investigating: "${currentQuery}"

${context}

Decide whether the gathered information is sufficient to answer the user's original question accurately. If not, propose up to 2 focused follow-up search queries that would help fill the gaps.

Return ONLY a valid JSON object in this exact shape:
{
  "sufficient": true or false,
  "reason": "short explanation",
  "followUpQueries": ["query 1", "query 2"]
}
Do not include any text outside the JSON object.`

  try {
    const data = await callOpenRouter(apiKey, [{ role: 'user', content: prompt }], 400)
    const content = data.choices?.[0]?.message?.content || ''
    const parsed = extractJson(content)
    if (parsed && typeof parsed.sufficient === 'boolean') {
      return {
        sufficient: parsed.sufficient,
        reason: parsed.reason || '',
        followUpQueries: Array.isArray(parsed.followUpQueries) ? parsed.followUpQueries.slice(0, 2) : []
      }
    }
  } catch (err) {
    console.warn('Agentic sufficiency evaluation error:', err.message)
  }
  return { sufficient: false, followUpQueries: [] }
}

async function synthesizeAnswer(query, sources, apiKey) {
  const context = buildSourceContext(sources)

  if (!apiKey) {
    const snippetSummary = sources
      .slice(0, 5)
      .map((s, i) => `[${i + 1}] ${s.title || 'Source'}: ${s.description || s.text?.slice(0, 200) || ''}`)
      .join('\n')
    return {
      answer: `I searched the web for "${query}" but no OpenRouter API key is configured, so I can only return raw snippets.\n\n${snippetSummary}`,
      citations: sources.slice(0, 5).map((s, i) => ({ number: i + 1, title: s.title || 'Source', url: s.url }))
    }
  }

  const prompt = `You are a precise research assistant. Answer the user's question using only the provided web sources. Cite sources with [1], [2], etc. inline.

User question: "${query}"

Sources:
${context}

Instructions:
- Write a clear, concise answer in Markdown.
- Include inline citations like [1] or [2] whenever you use information from a source.
- If the sources don't fully answer the question, say so and explain what's missing.
- Do not invent facts not supported by the sources.

Return ONLY a valid JSON object with this exact shape:
{
  "answer": "your markdown answer with [1] citations",
  "citations": [
    {"number": 1, "title": "source title", "url": "source url"}
  ]
}
Do not include any text outside the JSON object.`

  try {
    const data = await callOpenRouter(apiKey, [{ role: 'user', content: prompt }], 1200)
    const content = data.choices?.[0]?.message?.content || ''
    const parsed = extractJson(content)
    if (parsed && typeof parsed.answer === 'string') {
      return {
        answer: parsed.answer,
        citations: Array.isArray(parsed.citations) ? parsed.citations : []
      }
    }
  } catch (err) {
    console.warn('Agentic synthesis error:', err.message)
  }

  return {
    answer: 'I searched the web but was unable to synthesize a final answer. Please check the sources below.',
    citations: sources.slice(0, 5).map((s, i) => ({ number: i + 1, title: s.title || 'Source', url: s.url }))
  }
}

async function performAgenticSearch(query, apiKey, onProgress = () => {}) {
  if (!query || !query.trim()) throw new Error('Query is required')

  const state = {
    query: query.trim(),
    iterations: [],
    sources: [],
    answer: null,
    citations: []
  }

  let currentQuery = state.query
  let iteration = 0

  while (iteration < MAX_ITERATIONS) {
    iteration++
    onProgress({ type: 'search', iteration, query: currentQuery, message: `Searching: ${currentQuery}` })

    const searchResults = await searchDuckDuckGo(currentQuery)
    const fetchedSources = []

    for (const result of searchResults) {
      const existing = state.sources.find((s) => s.url === result.url)
      if (existing) continue

      onProgress({ type: 'fetch', url: result.url, message: `Reading ${result.url}` })
      const content = await fetchPageContent(result.url, result.title)
      if (content) {
        const source = {
          title: content.title || result.title,
          description: content.description || result.snippet,
          url: result.url,
          text: content.text
        }
        fetchedSources.push(source)
        state.sources.push(source)
      } else if (result.title || result.snippet) {
        const source = { title: result.title, description: result.snippet, url: result.url, text: '' }
        state.sources.push(source)
      }
    }

    state.iterations.push({
      query: currentQuery,
      searchResults: searchResults.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
      fetchedCount: fetchedSources.length
    })

    onProgress({ type: 'evaluate', iteration, message: 'Evaluating gathered sources...' })
    const evaluation = await evaluateSufficiency(state.query, currentQuery, state.sources, apiKey)

    if (evaluation.sufficient) {
      onProgress({ type: 'synthesize', message: 'Synthesizing answer...' })
      const result = await synthesizeAnswer(state.query, state.sources, apiKey)
      state.answer = result.answer
      state.citations = result.citations
      break
    }

    if (evaluation.followUpQueries && evaluation.followUpQueries.length) {
      currentQuery = evaluation.followUpQueries[0]
      continue
    }

    // No follow-ups proposed; synthesize with what we have
    onProgress({ type: 'synthesize', message: 'Synthesizing answer...' })
    const result = await synthesizeAnswer(state.query, state.sources, apiKey)
    state.answer = result.answer
    state.citations = result.citations
    break
  }

  if (!state.answer) {
    const result = await synthesizeAnswer(state.query, state.sources, apiKey)
    state.answer = result.answer
    state.citations = result.citations
  }

  onProgress({ type: 'done', message: 'Search complete' })
  return state
}

module.exports = { performAgenticSearch }
