import axios from 'axios';

const GOOGLE_CSE_URL = 'https://www.googleapis.com/customsearch/v1';

/**
 * Google Custom Search JSON API. Free tier: 100 queries/day; then $5 per 1,000.
 * Requires a Programmable Search Engine (cx) and an API key.
 * Returns organic results as { url, title, snippet }[].
 *
 * @param {string} query - Search query
 * @param {object} options - { count, timeoutMs, apiKey, cx }
 * @returns {Promise<Array<{ url, title, snippet }>>}
 */
export async function searchGoogleCSE(query, options = {}) {
  const apiKey = options.apiKey || process.env.GOOGLE_CSE_API_KEY;
  const cx = options.cx || process.env.GOOGLE_CSE_CX;
  if (!apiKey) throw new Error('GOOGLE_CSE_API_KEY is not set');
  if (!cx) throw new Error('GOOGLE_CSE_CX (Search Engine ID) is not set');

  const num = Math.min(10, Math.max(1, options.count || 10)); // API max 10 per request
  const timeoutMs = options.timeoutMs ?? 15000;

  const { data } = await axios.get(GOOGLE_CSE_URL, {
    params: { key: apiKey, cx, q: query, num },
    timeout: timeoutMs,
  });

  const results = [];
  const items = data?.items;
  if (!Array.isArray(items)) return results;

  for (const item of items) {
    const url = item.link;
    if (!url) continue;
    results.push({
      url,
      title: item.title || '',
      snippet: item.snippet || '',
    });
  }
  return results;
}

export default searchGoogleCSE;
