/**
 * Agentic web search (Perplexity-style).
 *
 * Main process only. Performs iterative, LLM-directed web research:
 * 1. Plans sub-questions and initial searches.
 * 2. Searches DuckDuckGo and/or visits URLs discovered on previous pages.
 * 3. After each iteration the LLM evaluates whether all details are present.
 * 4. If details are missing, the LLM issues new search queries or specific
 *    URLs to visit (up to 10 iterations).
 * 5. Consolidates all gathered sources into a final cited answer.
 */

const cheerio = require('cheerio')
const { callOpenRouter, extractJson } = require('./llm')

const MAX_ITERATIONS = 10
const RESULTS_PER_SEARCH = 5
const MAX_SOURCES = 25
const MAX_SOURCE_TEXT_LENGTH = 5000
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
  const challengeMarkers = [
    'just a moment', 'are you human', 'captcha', 'cloudflare',
    'access denied', 'please wait', 'enable javascript', 'verify you are human'
  ]
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

    const links = []
    $('a[href]').each((_i, el) => {
      const href = $(el).attr('href')
      const anchorText = $(el).text().trim().slice(0, 80)
      if (!href) return
      try {
        const resolved = new URL(href, url).href
        const linkHost = new URL(resolved).hostname
        const pageHost = new URL(url).hostname
        if (resolved.startsWith('http') && !resolved.includes('#')) {
          links.push({ url: resolved, sameSite: linkHost === pageHost, anchorText })
        }
      } catch {
        // ignore malformed URLs
      }
    })

    return {
      title,
      description,
      text: text.slice(0, MAX_SOURCE_TEXT_LENGTH),
      links: links.slice(0, 30)
    }
  } catch (err) {
    console.warn(`Agentic search fetch error for ${url}:`, err.message)
    return null
  }
}

function dedupeSources(sources) {
  const seen = new Set()
  return sources.filter((s) => {
    const key = s.url.toLowerCase().split('#')[0]
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function truncateContext(sources) {
  let total = 0
  const kept = []
  for (const source of sources) {
    const len = (source.text || '').length
    if (total + len > 22000 && kept.length >= 4) break
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

async function createSearchPlan(query, apiKey) {
  if (!apiKey) {
    return {
      subQuestions: [query],
      initialQueries: [query]
    }
  }

  const prompt = `You are a research planner. Break the user's question into a research plan.

User question: "${query}"

Return ONLY a valid JSON object with this shape:
{
  "subQuestions": ["specific question 1", "specific question 2", ...],
  "initialQueries": ["search query 1", "search query 2", ...]
}

Rules:
- subQuestions should cover every detail needed to fully answer the original question.
- initialQueries are web-search queries to start finding sources.
- Do not include any text outside the JSON object.`

  try {
    const data = await callOpenRouter(apiKey, [{ role: 'user', content: prompt }], 500)
    const parsed = extractJson(data.choices?.[0]?.message?.content || '')
    if (parsed && Array.isArray(parsed.subQuestions) && Array.isArray(parsed.initialQueries)) {
      return {
        subQuestions: parsed.subQuestions.slice(0, 5),
        initialQueries: parsed.initialQueries.slice(0, 4)
      }
    }
  } catch (err) {
    console.warn('Agentic search plan error:', err.message)
  }

  return {
    subQuestions: [query],
    initialQueries: [query]
  }
}

async function evaluateCoverage(query, subQuestions, sources, apiKey) {
  if (!apiKey) {
    return {
      sufficient: sources.length >= 5,
      missingDetails: [],
      nextActions: []
    }
  }

  const context = buildSourceContext(sources)
  const linksContext = sources
  .flatMap((s, i) => (s.links || []).map((l) => `[${i + 1}] ${l.anchorText ? l.anchorText + ' → ' : ''}${l.url}`))
  .slice(0, 40)
  .join('\n')

  const prompt = `You are a research evaluator. The user asked: "${query}"

We defined these sub-questions to answer:
${subQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}

We have gathered the following web sources:

${context}

Links discovered on those pages (you may propose visiting relevant ones):
${linksContext || '(none)'}

Evaluate whether we have enough detail to answer ALL sub-questions accurately. If not, decide the next best actions to gather missing information.

Return ONLY a valid JSON object with this exact shape:
{
  "sufficient": true or false,
  "missingDetails": ["what is missing 1", "what is missing 2"],
  "nextActions": [
    {"type": "search", "query": "a new web search query"},
    {"type": "visit", "url": "https://example.com/specific-page", "reason": "why this page should be visited"}
  ]
}

Rules:
- If sufficient is true, nextActions should be empty.
- Prefer "visit" actions when a discovered URL likely contains the missing detail.
- Prefer "search" actions when we need to discover new pages.
- Limit nextActions to 3 items.
- Do not include any text outside the JSON object.`

  try {
    const data = await callOpenRouter(apiKey, [{ role: 'user', content: prompt }], 700)
    const parsed = extractJson(data.choices?.[0]?.message?.content || '')
    if (parsed && typeof parsed.sufficient === 'boolean') {
      return {
        sufficient: parsed.sufficient,
        missingDetails: Array.isArray(parsed.missingDetails) ? parsed.missingDetails : [],
        nextActions: (parsed.nextActions || [])
          .filter((a) => a && (a.type === 'search' || a.type === 'visit'))
          .slice(0, 3)
      }
    }
  } catch (err) {
    console.warn('Agentic coverage evaluation error:', err.message)
  }

  return {
    sufficient: sources.length >= 5,
    missingDetails: [],
    nextActions: []
  }
}

async function synthesizeAnswer(query, sources, apiKey) {
  const context = buildSourceContext(sources)

  if (!apiKey) {
    const snippetSummary = sources
      .slice(0, 6)
      .map((s, i) => `[${i + 1}] ${s.title || 'Source'}: ${s.description || s.text?.slice(0, 200) || ''}`)
      .join('\n')
    return {
      answer: `I searched the web for "${query}" but no OpenRouter API key is configured, so I can only return raw snippets.\n\n${snippetSummary}`,
      citations: sources.slice(0, 6).map((s, i) => ({ number: i + 1, title: s.title || 'Source', url: s.url }))
    }
  }

  const prompt = `You are a precise research assistant. Synthesize a complete answer to the user's question using all provided web sources. Cite sources with [1], [2], etc. inline.

User question: "${query}"

Sources:
${context}

Instructions:
- Write a clear, well-structured answer in Markdown.
- Include inline citations like [1] or [2] whenever you use information from a source.
- If sources conflict, present the range or note the discrepancy.
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
    const data = await callOpenRouter(apiKey, [{ role: 'user', content: prompt }], 1500)
    const parsed = extractJson(data.choices?.[0]?.message?.content || '')
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
    citations: sources.slice(0, 6).map((s, i) => ({ number: i + 1, title: s.title || 'Source', url: s.url }))
  }
}

async function performAgenticSearch(query, apiKey, onProgress = () => {}) {
  if (!query || !query.trim()) throw new Error('Query is required')

  const state = {
    query: query.trim(),
    plan: null,
    iterations: [],
    sources: [],
    answer: null,
    citations: []
  }

  onProgress({ type: 'plan', message: 'Planning research...' })
  state.plan = await createSearchPlan(state.query, apiKey)

  // Queues for iterative work
  const pendingQueries = [...state.plan.initialQueries]
  const pendingUrls = []
  let iteration = 0

  while (iteration < MAX_ITERATIONS && state.sources.length < MAX_SOURCES) {
    iteration++

    // Decide what to do this iteration
    let action = null
    if (pendingUrls.length) {
      action = { type: 'visit', url: pendingUrls.shift() }
    } else if (pendingQueries.length) {
      action = { type: 'search', query: pendingQueries.shift() }
    }

    if (!action) {
      // Nothing queued; ask the LLM what to do next
      onProgress({ type: 'evaluate', iteration, message: 'Reviewing what we have...' })
      const evaluation = await evaluateCoverage(state.query, state.plan.subQuestions, state.sources, apiKey)

      if (evaluation.sufficient || state.sources.length >= MAX_SOURCES) {
        onProgress({ type: 'synthesize', message: 'Synthesizing final answer...' })
        const result = await synthesizeAnswer(state.query, state.sources, apiKey)
        state.answer = result.answer
        state.citations = result.citations
        break
      }

      for (const next of evaluation.nextActions) {
        if (next.type === 'search') pendingQueries.push(next.query)
        if (next.type === 'visit') pendingUrls.push(next.url)
      }

      if (!pendingQueries.length && !pendingUrls.length) {
        // LLM couldn't propose next actions; synthesize with what we have
        onProgress({ type: 'synthesize', message: 'Synthesizing answer...' })
        const result = await synthesizeAnswer(state.query, state.sources, apiKey)
        state.answer = result.answer
        state.citations = result.citations
        break
      }

      continue
    }

    // Execute the chosen action
    if (action.type === 'search') {
      onProgress({ type: 'search', iteration, query: action.query, message: `Searching: ${action.query}` })
      const searchResults = await searchDuckDuckGo(action.query)

      for (const result of searchResults) {
        if (state.sources.length >= MAX_SOURCES) break
        const existing = state.sources.find((s) => s.url === result.url)
        if (existing) continue

        onProgress({ type: 'fetch', url: result.url, message: `Reading ${result.url}` })
        const content = await fetchPageContent(result.url, result.title)
        if (content) {
          state.sources.push({
            title: content.title || result.title,
            description: content.description || result.snippet,
            url: result.url,
            text: content.text,
            links: content.links
          })
        } else if (result.title || result.snippet) {
          state.sources.push({ title: result.title, description: result.snippet, url: result.url, text: '' })
        }
      }

      state.iterations.push({
        iteration,
        action: 'search',
        query: action.query,
        resultsFound: searchResults.length,
        sourcesCount: state.sources.length
      })
    }

    if (action.type === 'visit') {
      onProgress({ type: 'fetch', url: action.url, message: `Reading ${action.url}` })
      const content = await fetchPageContent(action.url)
      if (content) {
        state.sources.push({
          title: content.title,
          description: content.description,
          url: action.url,
          text: content.text,
          links: content.links
        })
      }

      state.iterations.push({
        iteration,
        action: 'visit',
        url: action.url,
        sourcesCount: state.sources.length
      })
    }
  }

  if (!state.answer) {
    onProgress({ type: 'synthesize', message: 'Synthesizing final answer...' })
    const result = await synthesizeAnswer(state.query, state.sources, apiKey)
    state.answer = result.answer
    state.citations = result.citations
  }

  state.sources = dedupeSources(state.sources)
  onProgress({ type: 'done', message: 'Search complete' })
  return state
}

module.exports = { performAgenticSearch }
