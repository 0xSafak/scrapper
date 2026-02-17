// Optional Puppeteer-based fetch for sites that block axios (e.g. Cloudflare 403).

import { logger } from '../utils/logger.js';

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Fetch a single URL with headless Chrome. Returns HTML or null on failure.
 * @param {string} url
 * @param {object} options - { timeoutMs, userAgent }
 */
export async function fetchWithBrowser(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20000;
  const userAgent = options.userAgent || process.env.USER_AGENT || DEFAULT_UA;
  let browser;
  try {
    const puppeteer = await import('puppeteer');
    browser = await puppeteer.default.launch({
      headless: true,
      handleSIGINT: false,
      handleSIGTERM: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
      ],
    });
    const page = await browser.newPage();
    await page.setUserAgent(userAgent);
    await page.setViewport({ width: 1280, height: 800 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const html = await page.content();
    return html;
  } catch (err) {
    throw err;
  } finally {
    await closeBrowser(browser);
  }
}

/** Close browser and swallow Windows process-termination errors. */
async function closeBrowser(browser) {
  logger.debug('Closing browser', { hasBrowser: !!browser });
  if (!browser) return;
  try {
    await Promise.race([
      browser.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('close timeout')), 5000)),
    ]);
  } catch (_) {
    try { browser.disconnect(); } catch (_) {}
  }
  // Give Windows time to release child processes before Node exits (reduces "could not be terminated" errors)
  await new Promise((r) => setTimeout(r, 500));
}

/**
 * Fetch multiple URLs with a single browser instance (sequential). Returns Map<url, html> for successful fetches.
 */
export async function fetchManyWithBrowser(urls, options = {}) {
  logger.debug('fetchManyWithBrowser', { urlsCount: urls.length });
  const timeoutMs = options.timeoutMs ?? 20000;
  const userAgent = options.userAgent || process.env.USER_AGENT || DEFAULT_UA;
  const delayMs = options.delayBetweenRequestsMs ?? 500;
  const results = new Map();
  let browser;
  try {
    const puppeteer = await import('puppeteer');
    logger.debug('Launching headless browser');
    browser = await puppeteer.default.launch({
      headless: true,
      handleSIGINT: false,
      handleSIGTERM: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--no-first-run',
      ],
    });
    const page = await browser.newPage();
    await page.setUserAgent(userAgent);
    await page.setViewport({ width: 1280, height: 800 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    for (const url of urls) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        if (response && response.status() >= 200 && response.status() < 400) {
          const html = await page.content();
          results.set(url, html);
        }
      } catch (_) {
        // skip this url
      }
    }
  } catch (err) {
    throw err;
  } finally {
    await closeBrowser(browser);
  }
  return results;
}
