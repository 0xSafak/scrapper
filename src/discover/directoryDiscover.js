// Scrape travel directories for international operators selling Turkey tours.

import axios from 'axios';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import { normalizeDomain } from './normalizeDomain.js';
import { logger } from '../utils/logger.js';

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchPage(url, timeoutMs = 20000) {
  const { data } = await axios.get(url, {
    timeout: timeoutMs,
    headers: {
      'User-Agent': process.env.USER_AGENT || DEFAULT_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    maxRedirects: 5,
  });
  return data;
}

// ── TourRadar parser ────────────────────────────────────────────────
// Parses the Turkey tour operators list: /g/turkey-tour-operators?page=N
// Each operator card has a link to /o/<slug> and sometimes /o/<slug>/turkey

function parseTourRadarOperators(html, pageUrl) {
  const $ = cheerio.load(html);
  const operators = [];

  // Operator profile links: /o/<slug>
  $('a[href*="/o/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const match = href.match(/\/o\/([a-z0-9-]+)/i);
    if (!match) return;
    const slug = match[1];
    const text = $(el).text().trim();
    // Skip non-operator links (like "View All Tours", etc. that contain /o/)
    if (!text || text.length < 2) return;
    const fullUrl = new URL(href, 'https://www.tourradar.com').href;
    operators.push({
      name: text,
      profileUrl: fullUrl,
      slug,
    });
  });

  // Dedupe by slug
  const seen = new Set();
  return operators.filter((op) => {
    if (seen.has(op.slug)) return false;
    seen.add(op.slug);
    return true;
  });
}

// Fetch a TourRadar operator profile and try to find their external website
async function fetchOperatorWebsite(profileUrl, delayMs = 1000) {
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  try {
    const html = await fetchPage(profileUrl);
    const $ = cheerio.load(html);
    // Look for external website links (not tourradar.com links)
    let website = null;
    $('a[href]').each((_, el) => {
      if (website) return;
      const href = $(el).attr('href') || '';
      const text = ($(el).text() || '').toLowerCase();
      // Look for "website", "visit website", or external links in the operator info area
      if ((text.includes('website') || text.includes('visit')) && href.startsWith('http') && !href.includes('tourradar.com')) {
        website = href;
      }
    });
    // Also check for og:url or canonical that points externally (rare but possible)
    if (!website) {
      $('a[href]').each((_, el) => {
        if (website) return;
        const href = $(el).attr('href') || '';
        if (href.startsWith('http') && !href.includes('tourradar.com') && !href.includes('facebook.com') &&
            !href.includes('instagram.com') && !href.includes('twitter.com') && !href.includes('youtube.com') &&
            !href.includes('linkedin.com') && !href.includes('tripadvisor.com') && !href.includes('google.com')) {
          const domain = normalizeDomain(href);
          if (domain && domain.length > 3) {
            website = href;
          }
        }
      });
    }
    return website;
  } catch (err) {
    logger.debug('Failed to fetch operator profile', { profileUrl, message: err.message });
    return null;
  }
}

async function scrapeTourRadar(config = {}) {
  const maxPages = config.maxPages ?? 5;
  const delayMs = config.delayMs ?? 2000;
  const baseUrl = config.url || 'https://www.tourradar.com/g/turkey-tour-operators';
  const results = [];
  const seenSlugs = new Set();

  for (let page = 1; page <= maxPages; page++) {
    const url = page === 1 ? baseUrl : `${baseUrl}?page=${page}`;
    logger.info('Scraping TourRadar page', { page, url });
    try {
      if (page > 1 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      const html = await fetchPage(url);
      const operators = parseTourRadarOperators(html, url);
      if (operators.length === 0) {
        logger.info('No more operators found, stopping', { page });
        break;
      }
      for (const op of operators) {
        if (seenSlugs.has(op.slug)) continue;
        seenSlugs.add(op.slug);
        results.push(op);
      }
      logger.info('TourRadar page scraped', { page, operators: operators.length, totalSoFar: results.length });
    } catch (err) {
      logger.error('TourRadar page failed', { page, url, message: err.message });
      break;
    }
  }

  // Now try to resolve external websites for each operator
  const limit = pLimit(1); // Sequential to be polite
  const domains = [];
  const tasks = results.map((op) =>
    limit(async () => {
      const website = await fetchOperatorWebsite(op.profileUrl, delayMs);
      if (website) {
        const domain = normalizeDomain(website);
        if (domain) {
          domains.push({
            domain,
            sampleUrl: website,
            queryUsed: `directory:tourradar:${op.slug}`,
            title: op.name,
            snippet: `Tour operator from TourRadar Turkey operators list`,
            country: '',
            city: '',
          });
        }
      } else {
        // If no external site found, use the TourRadar profile itself
        // (the extraction step can still try to find contact info)
        logger.debug('No external website for operator', { name: op.name, slug: op.slug });
      }
    })
  );
  await Promise.all(tasks);

  return domains;
}

// ── Generic directory parser ────────────────────────────────────────
// For directories that list tour operators with links to their websites.
// Extracts all outbound links that look like tour operator websites.

async function scrapeGenericDirectory(config = {}) {
  const maxPages = config.maxPages ?? 5;
  const delayMs = config.delayMs ?? 2000;
  const baseUrl = config.url;
  if (!baseUrl) return [];

  const allDomains = [];
  const seen = new Set();

  for (let page = 1; page <= maxPages; page++) {
    const url = page === 1 ? baseUrl : `${baseUrl}?page=${page}`;
    logger.info('Scraping directory page', { name: config.name, page, url });
    try {
      if (page > 1 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      const html = await fetchPage(url);
      const $ = cheerio.load(html);

      $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (!href.startsWith('http')) return;
        const domain = normalizeDomain(href);
        if (!domain) return;
        // Skip the directory itself and common non-operator domains
        const skip = ['tourradar.com', 'bookmundi.com', 'tripadvisor.com', 'viator.com',
          'getyourguide.com', 'booking.com', 'expedia.com', 'google.com',
          'facebook.com', 'instagram.com', 'twitter.com', 'youtube.com', 'linkedin.com',
          'pinterest.com', 'tiktok.com'];
        const dirDomain = normalizeDomain(baseUrl);
        if (domain === dirDomain || skip.includes(domain)) return;
        if (seen.has(domain)) return;
        seen.add(domain);

        const text = $(el).text().trim();
        allDomains.push({
          domain,
          sampleUrl: href,
          queryUsed: `directory:${config.name || 'generic'}`,
          title: text || domain,
          snippet: `Found on ${config.name || baseUrl}`,
          country: '',
          city: '',
        });
      });

      logger.info('Directory page scraped', { name: config.name, page, found: allDomains.length });
    } catch (err) {
      logger.error('Directory page failed', { name: config.name, page, message: err.message });
      break;
    }
  }

  return allDomains;
}

// ── Main entry point ────────────────────────────────────────────────

/**
 * Run directory discovery. Scrapes configured directories and returns domain records.
 * @param {Array} directories - Array of { name, url, maxPages, type?, delayMs? }
 * @param {Function} [onDomainFound] - Optional callback(domainRecord) for streaming pipeline
 * @returns {Promise<Array>} - Array of domain records
 */
export async function runDirectoryDiscover(directories = [], onDomainFound = null) {
  const allDomains = [];
  const seen = new Set();

  for (const dir of directories) {
    let domains = [];
    const type = (dir.type || dir.name || '').toLowerCase();

    if (type === 'tourradar') {
      domains = await scrapeTourRadar(dir);
    } else {
      domains = await scrapeGenericDirectory(dir);
    }

    for (const d of domains) {
      if (seen.has(d.domain)) continue;
      seen.add(d.domain);
      allDomains.push(d);
      if (onDomainFound) onDomainFound(d);
    }

    logger.info('Directory done', { name: dir.name, newDomains: domains.length, totalUnique: allDomains.length });
  }

  return allDomains;
}

export default runDirectoryDiscover;
