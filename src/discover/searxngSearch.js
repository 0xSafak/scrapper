import axios from 'axios';

/**
 * Call a self-hosted SearXNG instance with pagination support.
 * Fetches multiple pages to collect up to `count` results.
 * No API key or usage quota.
 *
 * @param {string} query - Search query
 * @param {object} options - { count, timeoutMs, baseUrl, language, pageDelayMs }
 * @returns {Promise<Array<{ url, title, snippet }>>}
 */
export async function searchSearXNG(query, options = {}) {
  const baseUrl = (options.baseUrl || process.env.SEARXNG_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
  const timeoutMs = options.timeoutMs ?? 15000;
  const count = Math.min(100, Math.max(1, options.count || 20));
  const language = options.language || '';
  const pageDelayMs = options.pageDelayMs ?? 1000;

  const results = [];
  const seenUrls = new Set();
  const maxPages = Math.ceil(count / 20); // ~20 results per page
  let emptyPages = 0;

  for (let page = 1; page <= maxPages; page++) {
    if (results.length >= count) break;
    if (emptyPages >= 2) break; // stop if 2 consecutive pages return nothing new

    if (page > 1 && pageDelayMs > 0) {
      await new Promise((r) => setTimeout(r, pageDelayMs));
    }

    const params = { q: query, format: 'json', pageno: page };
    if (language) params.language = language;

    try {
      const { data } = await axios.get(`${baseUrl}/search`, {
        params,
        timeout: timeoutMs,
        headers: { Accept: 'application/json' },
      });

      const items = data?.results;
      if (!Array.isArray(items) || items.length === 0) {
        emptyPages++;
        continue;
      }

      let newCount = 0;
      for (const item of items) {
        if (results.length >= count) break;
        const url = item.url || item.link;
        if (!url || seenUrls.has(url)) continue;
        seenUrls.add(url);
        results.push({
          url,
          title: item.title || '',
          snippet: item.content || item.snippet || '',
        });
        newCount++;
      }

      if (newCount === 0) emptyPages++;
      else emptyPages = 0;
    } catch (err) {
      // If a page fails, stop pagination but return what we have
      break;
    }
  }

  return results;
}

export default searchSearXNG;
