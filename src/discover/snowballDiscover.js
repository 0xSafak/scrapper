// Extract outbound travel-related domains from crawled pages (snowball discovery).

import * as cheerio from 'cheerio';
import { normalizeDomain } from './normalizeDomain.js';

// Domain keywords that suggest a travel agency / tour operator
const TRAVEL_DOMAIN_HINTS = [
  'tour', 'travel', 'voyage', 'holiday', 'excursion',
  'adventure', 'explore', 'journey', 'trek', 'safari',
  'cruise', 'expedit', 'discover', 'wander',
];

// Anchor text keywords that suggest the link points to a travel partner
const TRAVEL_TEXT_HINTS = [
  'tour', 'travel', 'agency', 'operator', 'partner',
  'holiday', 'excursion', 'voyage', 'booking', 'adventure',
];

// Known aggregators and non-agency domains to skip
const SKIP_DOMAINS = new Set([
  'tripadvisor.com', 'viator.com', 'getyourguide.com',
  'booking.com', 'expedia.com', 'hotels.com', 'airbnb.com',
  'kayak.com', 'skyscanner.com', 'trivago.com',
  'google.com', 'facebook.com', 'instagram.com', 'twitter.com',
  'youtube.com', 'linkedin.com', 'pinterest.com', 'tiktok.com',
  'wikipedia.org', 'reddit.com', 'trustpilot.com',
  'tourradar.com', 'bookmundi.com', 'responsibletravel.com',
  'lonelyplanet.com', 'roughguides.com', 'fodors.com',
]);

/**
 * Extract outbound travel-related domains from crawled pages.
 * @param {Array<{ url, html }>} pages - Crawled pages
 * @param {string} ownDomain - The domain being crawled (excluded from results)
 * @returns {string[]} - Array of normalized domain strings
 */
export function extractOutboundTravelDomains(pages, ownDomain) {
  const found = new Set();
  const ownNorm = (ownDomain || '').toLowerCase().replace(/^www\./, '');

  for (const { html } of pages) {
    if (!html) continue;
    const $ = cheerio.load(html);

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (!href.startsWith('http')) return;

      const domain = normalizeDomain(href);
      if (!domain || domain === ownNorm) return;

      // Skip known aggregators/social
      if (SKIP_DOMAINS.has(domain)) return;
      // Also check if domain ends with any skip domain (subdomains)
      for (const sd of SKIP_DOMAINS) {
        if (domain.endsWith('.' + sd)) return;
      }

      const anchorText = ($(el).text() || '').toLowerCase();

      // Check if domain name suggests travel
      const domainMatch = TRAVEL_DOMAIN_HINTS.some((h) => domain.includes(h));
      // Check if anchor text suggests travel
      const textMatch = TRAVEL_TEXT_HINTS.some((h) => anchorText.includes(h));

      if (domainMatch || textMatch) {
        found.add(domain);
      }
    });
  }

  return Array.from(found);
}

export default extractOutboundTravelDomains;
