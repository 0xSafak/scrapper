import axios from 'axios';

const SERPAPI_URL = 'https://serpapi.com/search';

/**
 * Call SerpAPI Google search. Returns organic results as { url, title, snippet }[].
 * @param {string} query - Search query
 * @param {object} options - { count, timeoutMs, apiKey, gl, googleDomain }
 * @returns {Promise<Array<{ url, title, snippet }>>}
 */
export async function searchSerpApi(query, options = {}) {
  const apiKey = options.apiKey || process.env.SERPAPI_API_KEY;
  if (!apiKey) throw new Error('SERPAPI_API_KEY is not set');
  const num = Math.min(100, Math.max(1, options.count || 20));
  const timeoutMs = options.timeoutMs ?? 15000;

  const params = {
    engine: 'google',
    q: query,
    api_key: apiKey,
    num,
  };
  if (options.gl) params.gl = options.gl;
  if (options.googleDomain) params.google_domain = options.googleDomain;

  const { data } = await axios.get(SERPAPI_URL, {
    params,
    timeout: timeoutMs,
  });

  const results = [];
  const organic = data?.organic_results;
  if (Array.isArray(organic)) {
    for (const item of organic) {
      const url = item.link || item.url;
      if (url) results.push({ url, title: item.title || '', snippet: item.snippet || '' });
    }
  }
  return results;
}

export default searchSerpApi;
