import { readFile, writeFile } from 'fs/promises';
import { searchSerpApi } from './serpApiSearch.js';
import { searchSearXNG } from './searxngSearch.js';
import { searchGoogleCSE } from './googleSearch.js';
import { normalizeDomain, isTurkeyBasedDomain } from './normalizeDomain.js';
import pLimit from 'p-limit';
import { logger } from '../utils/logger.js';

function getSearchFn(discoveryOpts) {
  const provider = (discoveryOpts.provider || 'serpapi').toLowerCase();
  if (provider === 'searxng') return searchSearXNG;
  if (provider === 'google' || provider === 'googlecse') return searchGoogleCSE;
  return searchSerpApi;
}

function loadJson(path) {
  return readFile(path, 'utf-8').then(JSON.parse);
}

function resolveConfigValues(config, key) {
  const raw = config[key];
  if (Array.isArray(raw)) return Promise.resolve(raw);
  if (typeof raw === 'string') return loadJson(raw);
  return Promise.resolve([]);
}

// Default top markets with locale data for country-specific search
const DEFAULT_TOP_MARKETS = [
  { name: 'United Kingdom', searxngLang: 'en-GB', serpGl: 'gb', serpDomain: 'google.co.uk' },
  { name: 'Germany',        searxngLang: 'de-DE', serpGl: 'de', serpDomain: 'google.de' },
  { name: 'France',         searxngLang: 'fr-FR', serpGl: 'fr', serpDomain: 'google.fr' },
  { name: 'Netherlands',    searxngLang: 'nl-NL', serpGl: 'nl', serpDomain: 'google.nl' },
  { name: 'USA',            searxngLang: 'en-US', serpGl: 'us', serpDomain: 'google.com' },
  { name: 'Australia',      searxngLang: 'en-AU', serpGl: 'au', serpDomain: 'google.com.au' },
  { name: 'Russia',         searxngLang: 'ru-RU', serpGl: 'ru', serpDomain: 'google.ru' },
  { name: 'China',          searxngLang: 'zh-CN', serpGl: 'cn', serpDomain: 'google.com' },
  { name: 'Japan',          searxngLang: 'ja-JP', serpGl: 'jp', serpDomain: 'google.co.jp' },
  { name: 'South Korea',    searxngLang: 'ko-KR', serpGl: 'kr', serpDomain: 'google.co.kr' },
];

// ── Query strategies ────────────────────────────────────────────────

/**
 * Normalize topMarkets config: accept both string[] (legacy) and object[] (new).
 */
function normalizeMarkets(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_TOP_MARKETS;
  if (typeof raw[0] === 'string') {
    // Legacy: just country name strings -- find matching default or create minimal entry
    return raw.map((name) => {
      const match = DEFAULT_TOP_MARKETS.find((m) => m.name.toLowerCase() === name.toLowerCase());
      return match || { name, searxngLang: '', serpGl: '', serpDomain: '' };
    });
  }
  return raw; // Already objects
}

/**
 * "broad+markets" strategy (default):
 *   Tier 1: each keyword alone (no location suffix, no locale -- global results)
 *   Tier 2: core keywords searched WITH locale per market (country-specific Google results)
 */
function buildBroadMarketQueries(keywords, markets) {
  const coreKeywords = [
    'Turkey tours', 'Turkey tour operator', 'Turkey travel agency', 'Turkey DMC',
    'Turkey incoming tours', 'Turkey B2B tours', 'Turkey wholesale tours', 'Cappadocia tours',
  ];

  const queryList = [];
  const seen = new Set();

  const add = (query, country, city, locale = {}) => {
    const key = query.toLowerCase() + '|' + (locale.language || '') + '|' + (locale.gl || '');
    if (seen.has(key)) return;
    seen.add(key);
    queryList.push({ query, country, city, ...locale });
  };

  // Tier 1: every keyword alone, no locale (global results)
  for (const kw of keywords) {
    add(kw, '', '');
  }

  // Tier 2: core keywords x top markets WITH locale (country-specific results)
  // Query text is just the keyword -- the locale does the geo-targeting
  for (const kw of coreKeywords) {
    for (const market of markets) {
      add(kw, market.name, '', {
        language: market.searxngLang || '',
        gl: market.serpGl || '',
        googleDomain: market.serpDomain || '',
      });
    }
  }

  return queryList;
}

/**
 * "full" strategy (original): keyword x (country + city).
 */
function buildFullQueries(keywords, countries, cities) {
  const queryList = [];
  for (const keyword of keywords) {
    for (const country of countries) {
      queryList.push({ query: `${keyword} ${country}`.trim(), country, city: '' });
    }
    for (const city of cities) {
      queryList.push({ query: `${keyword} ${city}`.trim(), country: '', city });
    }
  }
  return queryList;
}

/**
 * Run discovery: search queries with locale support, normalize domains, filter Turkey, return/write.
 * @param {object} config - Full config object
 * @param {string} outPath - Output path for domains JSON
 * @param {Function} [onDomainFound] - Optional callback(domainRecord) for streaming pipeline
 */
export async function runDiscover(config, outPath, onDomainFound = null) {
  const [countries, cities, keywords] = await Promise.all([
    resolveConfigValues(config, 'countries'),
    resolveConfigValues(config, 'cities'),
    resolveConfigValues(config, 'keywords'),
  ]);

  const discoveryOpts = config.discovery || {};
  const provider = (discoveryOpts.provider || 'serpapi').toLowerCase();
  const isSearxng = provider === 'searxng';
  const concurrency = isSearxng ? (discoveryOpts.concurrency ?? 1) : (discoveryOpts.concurrency ?? 2);
  const delaySearxngMs = discoveryOpts.delayBetweenSearxngQueriesMs ?? 2500;
  const resultsPerQuery = discoveryOpts.resultsPerQuery ?? 20;
  const queryStrategy = (discoveryOpts.queryStrategy || 'broad+markets').toLowerCase();
  const topMarkets = normalizeMarkets(discoveryOpts.topMarkets);

  const limit = pLimit(concurrency);
  const searchFn = getSearchFn(discoveryOpts);

  // Build query list based on strategy
  let queryList;
  if (queryStrategy === 'full') {
    queryList = buildFullQueries(keywords, countries, cities);
  } else {
    queryList = buildBroadMarketQueries(keywords, topMarkets);
  }

  logger.info('Discovery started', {
    provider,
    queryStrategy,
    totalQueries: queryList.length,
    concurrency,
    delaySearxngMs: isSearxng ? delaySearxngMs : undefined,
  });

  const baseSearchOptions = { count: resultsPerQuery };
  if (provider === 'searxng') baseSearchOptions.baseUrl = discoveryOpts.searxngUrl || process.env.SEARXNG_URL;
  if (provider === 'google' || provider === 'googlecse') {
    baseSearchOptions.apiKey = process.env.GOOGLE_CSE_API_KEY;
    baseSearchOptions.cx = discoveryOpts.googleCx || process.env.GOOGLE_CSE_CX;
  }

  const seen = new Map(); // domain -> record

  const tasks = queryList.map((item, index) =>
    limit(async () => {
      if (isSearxng && index > 0 && delaySearxngMs > 0) {
        await new Promise((r) => setTimeout(r, delaySearxngMs));
      }

      // Merge locale options for this specific query
      const searchOptions = { ...baseSearchOptions };
      if (item.language) searchOptions.language = item.language;
      if (item.gl) searchOptions.gl = item.gl;
      if (item.googleDomain) searchOptions.googleDomain = item.googleDomain;

      try {
        const results = await searchFn(item.query, searchOptions);
        for (const r of results) {
          const domain = normalizeDomain(r.url);
          if (!domain) continue;
          if (isTurkeyBasedDomain(domain)) continue;
          if (!seen.has(domain)) {
            const record = {
              domain,
              sampleUrl: r.url,
              queryUsed: item.query,
              title: r.title || '',
              snippet: r.snippet || '',
              country: item.country || '',
              city: item.city || '',
            };
            seen.set(domain, record);
            if (onDomainFound) onDomainFound(record);
          }
        }
        const locale = item.language || item.gl ? `[${item.language || item.gl}]` : '';
        logger.info('Discovery query done', { query: item.query, locale, results: results.length });
      } catch (err) {
        logger.error('Discovery query failed', { query: item.query, message: err.message });
      }
    })
  );

  await Promise.all(tasks);

  const domains = Array.from(seen.values());
  await writeFile(outPath, JSON.stringify(domains, null, 2), 'utf-8');
  logger.info('Discovery complete', { totalDomains: domains.length, totalQueries: queryList.length, outPath });
  return domains;
}

export default runDiscover;
