/**
 * Extract hostname from URL and normalize: lowercase, strip www.
 * @param {string} url - Any URL string
 * @returns {string} Normalized domain (e.g. "example.com")
 */
export function normalizeDomain(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    let u = url;
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    let host = new URL(u).hostname || '';
    host = host.toLowerCase().trim();
    if (host.startsWith('www.')) host = host.slice(4);
    return host;
  } catch {
    return '';
  }
}

// Turkish TLDs
const TURKEY_TLDS = ['.com.tr', '.org.tr', '.net.tr', '.gov.tr', '.edu.tr', '.bel.tr'];

// Domain keywords that indicate a Turkey-based operator (not an international agency)
const TURKEY_DOMAIN_HINTS = [
  'turkey', 'turkiye', 'turco', 'turk', 'turkish',
  'istanbul', 'antalya', 'cappadocia', 'kapadokya',
  'bodrum', 'ephesus', 'efes', 'pamukkale', 'goreme',
  'fethiye', 'marmaris', 'kusadasi', 'alanya', 'kemer',
  'belek', 'dalyan', 'oludeniz', 'tursab',
];

/**
 * Check if a domain likely belongs to a Turkey-based company.
 * Used to filter out Turkish operators (we want international partners only).
 * @param {string} domain - Normalized domain string
 * @returns {boolean}
 */
export function isTurkeyBasedDomain(domain) {
  if (!domain) return false;
  const d = domain.toLowerCase();
  if (TURKEY_TLDS.some((t) => d.endsWith(t))) return true;
  if (TURKEY_DOMAIN_HINTS.some((h) => d.includes(h))) return true;
  return false;
}

export default normalizeDomain;
