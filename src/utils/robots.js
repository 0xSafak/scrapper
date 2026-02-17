import axios from 'axios';
import { logger } from './logger.js';

const DEFAULT_UA = 'Mozilla/5.0 (compatible; Scrapper/2.0)';

/**
 * Fetch robots.txt and check if path is disallowed for our User-Agent.
 * If robots unreachable or parse fails, we allow (proceed cautiously).
 * @param {string} baseUrl - e.g. "https://example.com"
 * @param {string} path - e.g. "/contact"
 * @param {string} userAgent
 * @returns {Promise<boolean>} true if path is allowed, false if disallowed
 */
export async function isPathAllowed(baseUrl, path, userAgent = process.env.USER_AGENT || DEFAULT_UA) {
  try {
    const robotsUrl = new URL('/robots.txt', baseUrl).href;
    const { data } = await axios.get(robotsUrl, {
      timeout: 5000,
      headers: { 'User-Agent': userAgent },
      validateStatus: () => true,
    });
    const lines = (data || '').split(/\r?\n/);
    let currentUA = null;
    for (const line of lines) {
      const [directive, ...rest] = line.split(':').map((s) => s.trim());
      const value = rest.join(':').trim();
      if (/^user-agent$/i.test(directive)) {
        currentUA = value;
      } else if (/^disallow$/i.test(directive) && currentUA !== null) {
        const isOurs = currentUA === '*' || currentUA.toLowerCase().includes('scrapper');
        if (isOurs && value) {
          const pattern = value.replace(/\*/g, '.*');
          const re = new RegExp(`^${pattern}`);
          if (re.test(path)) return false;
        }
      }
    }
    return true;
  } catch (err) {
    logger.debug('robots.txt unreachable', { baseUrl, message: err.message });
    return true;
  }
}

export default { isPathAllowed };
