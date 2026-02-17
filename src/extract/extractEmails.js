import * as cheerio from 'cheerio';
import { extractEmailsWithLLM } from './openRouterExtract.js';

// Lookahead regex: email must end at a non-alphanumeric char or end-of-string.
// This prevents capturing garbage like info@site.comphone or info@site.com.you
const EMAIL_REGEX = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?=[^a-zA-Z0-9]|$)/g;

// Prefixes useful for B2B outreach
const GENERIC_PREFIXES = [
  'info', 'contact', 'sales', 'office', 'hello', 'support',
  'enquiry', 'enquiries', 'bookings', 'booking', 'reservations', 'reservation',
];

// Prefixes that are never useful for outreach -- filtered out entirely
const JUNK_PREFIXES = [
  'privacy', 'dpo', 'compliance', 'legal', 'abuse',
  'noreply', 'no-reply', 'do-not-reply', 'donotreply',
  'postmaster', 'mailer-daemon', 'webmaster', 'hostmaster', 'root', 'admin',
];

// Domains that are never agency websites -- emails @these are noise
const JUNK_DOMAINS = [
  'sentry.io', 'inforegulator.org.za', 'example.com', 'company.com',
  'siteadresiniz.com', 'yourdomain.com', 'domain.com', 'email.com',
  'test.com', 'localhost', 'ftc.gov', 'adr.org', 'hs01.kep.tr',
  'ustoa.com', 'abta.co.uk', 'caa.co.uk', 'sedgwick.com',
  'verasafe.com', 'iyzico.com', 'dvm.legal',
];

// Valid TLDs are 2-12 chars; anything longer is likely garbage
const MAX_TLD_LEN = 12;

function normalizeEmail(email) {
  return String(email).toLowerCase().trim();
}

/**
 * Validate an extracted email. Returns false for garbage.
 */
// Common TLD prefixes -- if a "TLD" starts with one of these but is longer, it's junk
const COMMON_TLD_PREFIXES = ['com', 'net', 'org', 'co', 'travel', 'tours', 'info'];

function isValidEmail(email) {
  const [local, domain] = email.split('@');
  if (!local || !domain) return false;
  // Reject if local starts with digits followed by letters (e.g. 10info, 5794info)
  if (/^\d+[a-z]/i.test(local)) return false;
  // Reject HTML entity prefix (u003e = >, u003c = <)
  if (/^u[0-9a-f]{4}/i.test(local)) return false;
  // Reject if local starts with special chars
  if (/^[._%+-]/.test(local)) return false;
  // Reject if local contains phone-number-like patterns
  if (/\+?\d{2,}[-.]?\d{2,}/.test(local)) return false;
  // Domain must have a dot
  if (!domain.includes('.')) return false;
  // TLD sanity check
  const parts = domain.split('.');
  const tld = parts[parts.length - 1];
  if (!tld || tld.length < 2 || tld.length > MAX_TLD_LEN) return false;
  // TLD must be only letters
  if (!/^[a-z]+$/i.test(tld)) return false;
  // Reject TLD that looks like a common TLD with trailing text (e.g. "comwebsite", "comphone")
  if (tld.length > 6) {
    for (const prefix of COMMON_TLD_PREFIXES) {
      if (tld.startsWith(prefix) && tld.length > prefix.length) return false;
    }
  }
  // Reject if second-level+tld looks like known TLD with junk appended (e.g. "com.you", "travelby")
  if (parts.length >= 2) {
    const secondLast = parts[parts.length - 2];
    const combined = secondLast + '.' + tld;
    // Patterns like "site.com.you", "group.travelby"
    if (/^(com|net|org|co|travel|tours)\.[a-z]{1,4}$/i.test(combined) && tld.length <= 4) {
      // This catches ".com.you", ".com.tr" is valid though -- only reject if tld is not a real country code
      const realCcTlds = ['tr', 'uk', 'au', 'br', 'cn', 'de', 'fr', 'jp', 'kr', 'nl', 'ru', 'za', 'in', 'my', 'sg', 'nz', 'mx', 'ar', 'il', 'be', 'at', 'ch', 'cz', 'dk', 'es', 'fi', 'gr', 'hu', 'ie', 'it', 'no', 'pl', 'pt', 'ro', 'se', 'ua'];
      if (!realCcTlds.includes(tld.toLowerCase())) return false;
    }
  }
  // Reject known junk domains
  if (JUNK_DOMAINS.some((jd) => domain === jd || domain.endsWith('.' + jd))) return false;
  // Reject if domain is suspiciously long (> 253 chars, RFC)
  if (domain.length > 253) return false;
  return true;
}

/**
 * Check if the email prefix is a junk/non-outreach prefix.
 */
function isJunkPrefix(email) {
  const local = email.split('@')[0] || '';
  return JUNK_PREFIXES.some((p) => local === p || local.startsWith(p + '.') || local.startsWith(p + '-'));
}

function isGeneric(email) {
  const local = email.split('@')[0] || '';
  return GENERIC_PREFIXES.some((p) => local === p || local.startsWith(p + '.') || local.startsWith(p + '-'));
}

/**
 * Strip HTML artifacts from text before regex extraction.
 */
function sanitizeText(text) {
  return text
    .replace(/\\u003[ce]/gi, ' ')
    .replace(/u003[ce]/gi, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/&#\d+;/gi, ' ');
}

/**
 * Regex + mailto extraction. Returns items with confidence 0.9 and extracted_by 'regex'.
 * Filters out junk emails (privacy@, dpo@, etc.) and invalid formats.
 * @param {string} html
 * @param {string} sourceUrl
 * @returns {Array<{ email, source_url, email_type, confidence, extracted_by }>}
 */
export function extractEmailsRegex(html, sourceUrl) {
  const seen = new Set();
  const out = [];

  const push = (email) => {
    const norm = normalizeEmail(email);
    if (!norm || !norm.includes('@') || seen.has(norm)) return;
    if (!isValidEmail(norm)) return;
    if (isJunkPrefix(norm)) return;
    seen.add(norm);
    out.push({
      email: norm,
      source_url: sourceUrl,
      email_type: isGeneric(norm) ? 'generic' : 'personal',
      confidence: 0.9,
      extracted_by: 'regex',
    });
  };

  const $ = cheerio.load(html || '');
  // Extract mailto: links first (higher quality)
  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const addr = href.replace(/^mailto:/i, '').split(/[?&]/)[0].trim();
    if (addr) push(addr);
  });

  // Extract from visible text (strip script/style, sanitize artifacts)
  $('script, style').remove();
  const rawText = $.text();
  const text = sanitizeText(rawText);
  let m;
  EMAIL_REGEX.lastIndex = 0;
  while ((m = EMAIL_REGEX.exec(text)) !== null) push(m[0]);

  return out;
}

/** Get visible text from HTML (strip script/style). */
export function getVisibleText(html) {
  const $ = cheerio.load(html || '');
  $('script, style').remove();
  return sanitizeText($.text());
}

/**
 * Merge AI and regex results by email: same email -> extracted_by 'both', confidence = max.
 */
function mergeEmailResults(aiList, regexList) {
  const byEmail = new Map();
  for (const r of regexList) {
    byEmail.set(r.email, { ...r });
  }
  for (const a of aiList) {
    // Validate AI results too
    if (!isValidEmail(a.email) || isJunkPrefix(a.email)) continue;
    const existing = byEmail.get(a.email);
    if (existing) {
      existing.extracted_by = 'both';
      existing.confidence = Math.max(existing.confidence, a.confidence);
      if (a.email_type !== 'unknown') existing.email_type = a.email_type;
    } else {
      byEmail.set(a.email, { ...a, source_url: a.source_url });
    }
  }
  return Array.from(byEmail.values());
}

/**
 * Pick the best N emails per domain, prioritizing outreach-useful ones.
 * Priority: info@ > contact@ > sales@ > booking@ > other generic > personal
 */
export function pickBestEmails(emails, maxPerDomain = 5) {
  const priorityOrder = ['info', 'contact', 'sales', 'booking', 'bookings', 'reservations', 'office', 'hello', 'enquiry', 'enquiries', 'support'];

  const scored = emails.map((e) => {
    const local = e.email.split('@')[0] || '';
    let priority = priorityOrder.indexOf(local);
    if (priority === -1) {
      // Check if local starts with a priority prefix
      priority = priorityOrder.findIndex((p) => local.startsWith(p));
    }
    if (priority === -1) {
      priority = e.email_type === 'generic' ? 50 : 100;
    }
    return { ...e, _priority: priority };
  });

  scored.sort((a, b) => a._priority - b._priority);
  return scored.slice(0, maxPerDomain).map(({ _priority, ...rest }) => rest);
}

/**
 * Extract emails from pages: optional LLM + regex, merge, dedupe.
 * @param {Array<{ url, html }>} pages
 * @param {object} options - { enableAiExtract, model, apiKey, aiTextMaxChars, maxEmailsPerDomain }
 * @returns {Promise<Array<{ email, email_type, confidence, source_url, extracted_by }>>}
 */
export async function extractEmailsFromPages(pages, options = {}) {
  const enableAi = options.enableAiExtract !== false && (options.apiKey || process.env.OPENROUTER_API_KEY);
  const maxEmails = options.maxEmailsPerDomain ?? 5;
  const allRegex = [];
  let allAi = [];

  for (const { url, html } of pages) {
    const regexList = extractEmailsRegex(html, url);
    allRegex.push(...regexList);

    if (enableAi && html) {
      const text = getVisibleText(html);
      if (text.trim()) {
        const aiList = await extractEmailsWithLLM(text, url, {
          model: options.model,
          apiKey: options.apiKey,
          aiTextMaxChars: options.aiTextMaxChars,
        });
        allAi.push(...aiList);
      }
    }
  }

  const merged = mergeEmailResults(allAi, allRegex);
  return pickBestEmails(merged, maxEmails);
}

export default extractEmailsFromPages;
