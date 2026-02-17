import axios from 'axios';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import { isPathAllowed } from '../utils/robots.js';
import { logger } from '../utils/logger.js';
import { fetchManyWithBrowser } from './browserFetch.js';

// Browser-like User-Agent to reduce 403 blocks (sites often block generic/crawler UAs)
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const FIXED_PATHS = ['/', '/contact', '/about', '/partners'];
const LINK_KEYWORDS = ['contact', 'about', 'team', 'partners', 'affiliates', 'our-partners', 'network'];

function getRequestHeaders(userAgent, originForReferer = null) {
  const ua = userAgent || process.env.USER_AGENT || DEFAULT_UA;
  const headers = {
    'User-Agent': ua,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate',
    'Cache-Control': 'max-age=0',
    DNT: '1',
    Connection: 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': originForReferer ? 'same-origin' : 'none',
    'Sec-Fetch-User': '?1',
    'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
  };
  if (originForReferer) headers.Referer = originForReferer + '/';
  return headers;
}

/**
 * Fetch URL with retries and exponential backoff.
 */
async function fetchWithRetry(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  const retries = options.retries ?? 3;
  const delays = options.retryDelaysMs ?? [1000, 2000, 4000];
  const userAgent = options.userAgent || process.env.USER_AGENT || DEFAULT_UA;
  const origin = options.origin || null;
  const headers = getRequestHeaders(userAgent, origin);

  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const { data } = await axios.get(url, {
        timeout: timeoutMs,
        headers,
        responseType: 'text',
        maxRedirects: 5,
        validateStatus: (s) => s >= 200 && s < 400,
      });
      return data;
    } catch (err) {
      lastErr = err;
      if (i < retries - 1 && delays[i] != null) {
        await new Promise((r) => setTimeout(r, delays[i]));
      }
    }
  }
  throw lastErr;
}

/**
 * Crawl a domain: fetch homepage + fixed paths + internal links containing contact/about/imprint/legal/terms.
 * Uses in-memory cache keyed by URL. Respects robots.txt when available.
 */
export async function crawlDomain(domain, options = {}) {
  const baseUrl = domain.startsWith('http') ? domain : `https://${domain}`;
  const cache = options.cache ?? new Map();
  const timeoutMs = options.timeoutMs ?? 15000;
  const retries = options.retries ?? 3;
  const retryDelaysMs = options.retryDelaysMs ?? [1000, 2000, 4000];
  const userAgent = options.userAgent || process.env.USER_AGENT || DEFAULT_UA;
  const concurrency = options.concurrency ?? 5;
  const delayBetweenRequestsMs = options.delayBetweenRequestsMs ?? 0;
  const useBrowser = options.useBrowser === true;
  const limit = pLimit(concurrency);

  const base = new URL(baseUrl);
  const origin = base.origin;
  const fetchOpts = { timeoutMs, retries, retryDelaysMs, userAgent, origin };

  const toFetch = new Set();
  for (const p of FIXED_PATHS) {
    const u = new URL(p || '/', baseUrl);
    if (u.origin === origin) toFetch.add(u.href);
  }

  if (useBrowser) {
    return crawlDomainWithBrowser(domain, baseUrl, origin, toFetch, cache, {
      timeoutMs,
      userAgent,
      delayBetweenRequestsMs: delayBetweenRequestsMs || 800,
    });
  }

  // Axios path: fetch homepage first to discover links
  const allowed = await isPathAllowed(baseUrl, '/', userAgent);
  if (allowed) {
    try {
      const url = new URL('/', baseUrl).href;
      if (!cache.has(url)) cache.set(url, await fetchWithRetry(url, fetchOpts));
      const homepageHtml = cache.get(url);
      const $ = cheerio.load(homepageHtml);
      $('a[href]').each((_, el) => {
        let href = $(el).attr('href');
        if (!href) return;
        try {
          const full = new URL(href, baseUrl);
          if (full.origin !== origin) return;
          const path = full.pathname.toLowerCase();
          if (LINK_KEYWORDS.some((k) => path.includes(k))) toFetch.add(full.href);
        } catch (_) {}
      });
    } catch (err) {
      logger.warn('Failed to fetch homepage', { domain, message: err.message });
    }
  }

  const results = [];
  const fetchOne = async (url) => {
    const path = new URL(url).pathname || '/';
    const allowed = await isPathAllowed(origin, path, userAgent);
    if (!allowed) return null;
    if (cache.has(url)) return { url, html: cache.get(url) };
    if (delayBetweenRequestsMs > 0) await new Promise((r) => setTimeout(r, delayBetweenRequestsMs));
    try {
      const html = await fetchWithRetry(url, fetchOpts);
      cache.set(url, html);
      return { url, html };
    } catch (err) {
      logger.debug('Fetch failed', { url, message: err.message });
      return null;
    }
  };

  const tasks = Array.from(toFetch).map((url) => limit(() => fetchOne(url)));
  const pages = await Promise.all(tasks);
  for (const p of pages) {
    if (p) results.push(p);
  }

  return results;
}

/** Use headless Chrome for all fetches (avoids 403 on Cloudflare etc.). */
async function crawlDomainWithBrowser(domain, baseUrl, origin, toFetch, cache, opts) {
  const homepageUrl = new URL('/', baseUrl).href;
  const toFetchArr = Array.from(toFetch);

  // 1) Fetch homepage first to discover more links
  const notCached = toFetchArr.filter((url) => !cache.has(url));
  if (notCached.length > 0) {
    try {
      const fetched = await fetchManyWithBrowser(notCached, {
        timeoutMs: opts.timeoutMs,
        userAgent: opts.userAgent,
        delayBetweenRequestsMs: opts.delayBetweenRequestsMs,
      });
      for (const [url, html] of fetched) {
        cache.set(url, html);
        if (url === homepageUrl) {
          const $ = cheerio.load(html);
          $('a[href]').each((_, el) => {
            const href = $(el).attr('href');
            if (!href) return;
            try {
              const full = new URL(href, baseUrl);
              if (full.origin === origin) {
                const path = full.pathname.toLowerCase();
                if (LINK_KEYWORDS.some((k) => path.includes(k))) toFetch.add(full.href);
              }
            } catch (_) {}
          });
        }
      }
    } catch (err) {
      logger.warn('Browser fetch failed', { domain, message: err.message });
    }
  }

  // 2) Fetch any newly discovered links (from homepage parse)
  const stillToFetch = Array.from(toFetch).filter((url) => !cache.has(url));
  if (stillToFetch.length > 0) {
    try {
      const fetched = await fetchManyWithBrowser(stillToFetch, {
        timeoutMs: opts.timeoutMs,
        userAgent: opts.userAgent,
        delayBetweenRequestsMs: opts.delayBetweenRequestsMs,
      });
      for (const [url, html] of fetched) cache.set(url, html);
    } catch (err) {
      logger.debug('Browser fetch (extra links) failed', { domain, message: err.message });
    }
  }

  const results = [];
  for (const url of toFetch) {
    if (cache.has(url)) results.push({ url, html: cache.get(url) });
  }
  return results;
}

export default crawlDomain;
