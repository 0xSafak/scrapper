import { readFile, writeFile, mkdir, appendFile } from 'fs/promises';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import { crawlDomain } from './crawlDomain.js';
import { extractEmailsFromPages } from './extractEmails.js';
import { scoreRelevance } from './scoreRelevance.js';
import { writeLeadsCsv, initLeadsCsv, appendLeadsCsv } from '../utils/csvWriter.js';
import { logger } from '../utils/logger.js';
import { extractOutboundTravelDomains } from '../discover/snowballDiscover.js';
import { isTurkeyBasedDomain } from '../discover/normalizeDomain.js';

function extractBusinessName(pages) {
  const home = pages.find((p) => {
    const path = new URL(p.url).pathname.replace(/\/$/, '') || '/';
    return path === '/' || path === '';
  });
  if (!home?.html) return '';
  const $ = cheerio.load(home.html);
  const title = $('title').text().trim();
  if (title) return title;
  const h1 = $('h1').first().text().trim();
  return h1 || '';
}

// ── Streaming extraction engine ─────────────────────────────────────
// Accepts domains from any source (search, directories, snowball) and
// processes them as they arrive.

/**
 * Create a streaming extractor that processes domains as they arrive.
 * Returns { addDomain, finish, getResults }.
 */
export function createStreamingExtractor(options = {}, outPath = null) {
  const startTime = new Date().toISOString();
  const minScore = options.minRelevanceScore ?? 2;
  const extraction = options.extraction || {};
  const useBrowser = extraction.useBrowser === true;
  const concurrency = useBrowser ? Math.min(extraction.concurrency ?? 2, 2) : (extraction.concurrency ?? 10);
  const timeoutMs = extraction.timeoutMs ?? 15000;
  const retries = extraction.retries ?? 2;
  const retryDelaysMs = extraction.retryDelaysMs ?? [1000, 2000];
  const unrelatedKeywords = options.unrelatedKeywords || [];
  const openRouter = options.extraction?.openRouter ?? options.openRouter ?? {};
  const enableAiExtract = (options.extraction?.enableAiExtract ?? options.enableAiExtract) !== false;
  const aiTextMaxChars = options.extraction?.aiTextMaxChars ?? options.aiTextMaxChars ?? 4000;
  const csvPath = outPath; // for incremental writes
  let csvInitialized = false;

  // Snowball config
  const snowball = options.snowball || {};
  const snowballEnabled = snowball.enabled === true;
  const snowballMaxDepth = snowball.maxDepth ?? 1;
  const snowballMaxPerSource = snowball.maxNewDomainsPerSource ?? 10;

  const limit = pLimit(concurrency);
  const cache = new Map();
  const allRows = [];
  const processedDomains = new Set();
  const pendingTasks = [];
  let domainIndex = 0;
  let skippedLogPath = 'logs/skipped.log';

  const runLog = {
    date: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    totals: { domainsProcessed: 0, leadsCount: 0, emailsCount: 0, snowballDomains: 0 },
    errors: [],
    skipped: [],
    timing: { startTime, endTime: null, durationMs: null },
    rateLimitStats: { openRouterCalls: 0, crawlRequests: 0 },
  };

  // Internal: process a single domain
  const processOne = async (rec, depth = 0) => {
    const domain = rec.domain || rec;
    if (processedDomains.has(domain)) return [];
    processedDomains.add(domain);

    // Skip Turkey-based domains (we want international partners only)
    if (isTurkeyBasedDomain(domain)) {
      runLog.skipped.push({ domain, reason: 'turkey-based domain' });
      await appendFile(skippedLogPath, `${domain}\tturkey-based domain\n`, 'utf-8').catch(() => {});
      logger.info('Skipping Turkey-based domain', { domain });
      return [];
    }

    const discoveredByQuery = rec.queryUsed ?? rec.discoveredByQuery ?? '';
    const country = rec.country ?? '';
    const city = rec.city ?? '';
    const idx = ++domainIndex;
    logger.info('Processing domain', { domain, index: idx, depth });

    try {
      const pages = await crawlDomain(domain, {
        cache,
        timeoutMs,
        retries,
        retryDelaysMs,
        concurrency: 3,
        delayBetweenRequestsMs: extraction.delayBetweenRequestsMs,
        useBrowser: extraction.useBrowser,
      });
      runLog.rateLimitStats.crawlRequests += pages.length;
      logger.info('Crawled domain', { domain, pages: pages.length });

      if (!pages.length) {
        runLog.skipped.push({ domain, reason: 'no pages fetched' });
        await appendFile(skippedLogPath, `${domain}\tno pages fetched\n`, 'utf-8');
        logger.warn('Domain skipped (no pages)', { domain });
        return [];
      }

      // ── Snowball: find partner domains ──
      if (snowballEnabled && depth < snowballMaxDepth) {
        const newDomains = extractOutboundTravelDomains(pages, domain);
        const added = newDomains.filter((sd) => !isTurkeyBasedDomain(sd)).slice(0, snowballMaxPerSource);
        for (const sd of added) {
          if (!processedDomains.has(sd)) {
            runLog.totals.snowballDomains++;
            logger.info('Snowball domain found', { source: domain, newDomain: sd });
            // Queue the snowballed domain for processing
            const snowRec = {
              domain: sd,
              sampleUrl: `https://${sd}`,
              queryUsed: `snowball:${domain}`,
              title: '',
              snippet: `Discovered via partner link on ${domain}`,
              country: '',
              city: '',
            };
            const task = limit(() => processOne(snowRec, depth + 1));
            pendingTasks.push(task);
          }
        }
      }

      // ── Extract emails ──
      const extractOptions = {
        enableAiExtract,
        model: openRouter.model,
        apiKey: process.env.OPENROUTER_API_KEY,
        aiTextMaxChars,
      };
      const emails = await extractEmailsFromPages(pages, extractOptions);
      if (enableAiExtract && emails.some((e) => e.extracted_by === 'ai' || e.extracted_by === 'both')) {
        runLog.rateLimitStats.openRouterCalls += pages.length;
      }
      logger.info('Extracted emails', { domain, emails: emails.length });

      // ── Score relevance ──
      const combinedText = pages.map((p) => p.html).join(' ');
      const { relevanceScore } = scoreRelevance(combinedText, unrelatedKeywords);

      if (relevanceScore < minScore) {
        runLog.skipped.push({ domain, reason: 'score below threshold', relevanceScore, minScore });
        await appendFile(skippedLogPath, `${domain}\tscore below threshold (${relevanceScore} < ${minScore})\n`, 'utf-8');
        logger.warn('Domain skipped (low relevance)', { domain, relevanceScore, minScore });
        return [];
      }

      const businessName = extractBusinessName(pages);
      const rows = emails.map((e) => ({
        business_name: businessName,
        domain,
        country,
        city,
        email: e.email,
        email_type: e.email_type,
        confidence: e.confidence,
        relevance_score: relevanceScore,
        source_url: e.source_url,
        discovered_by_query: discoveredByQuery,
      }));
      allRows.push(...rows);
      // Incremental CSV: append rows immediately so data survives Ctrl+C
      if (rows.length > 0 && csvPath) {
        if (!csvInitialized) {
          await initLeadsCsv(csvPath);
          csvInitialized = true;
        }
        await appendLeadsCsv(csvPath, rows);
      }
      logger.info('Domain done', { domain, leads: rows.length });
      return rows;
    } catch (err) {
      runLog.errors.push({ domain, message: err.message });
      logger.error('Extract failed for domain', { domain, message: err.message });
      await appendFile(skippedLogPath, `${domain}\terror: ${err.message}\n`, 'utf-8');
      return [];
    }
  };

  /**
   * Add a domain to the extraction queue. Can be called while extraction is running.
   */
  function addDomain(rec) {
    const domain = rec.domain || rec;
    if (processedDomains.has(domain)) return;
    const task = limit(() => processOne(rec, 0));
    pendingTasks.push(task);
  }

  /**
   * Wait for all pending tasks (including snowball tasks that may be added during processing).
   */
  async function finish(outPath) {
    await mkdir('logs', { recursive: true });
    await writeFile(skippedLogPath, '', 'utf-8');

    // Process in waves: tasks can add more tasks (snowball), so loop until empty
    while (pendingTasks.length > 0) {
      const batch = pendingTasks.splice(0);
      await Promise.all(batch);
    }

    const endTime = new Date().toISOString();
    runLog.totals.leadsCount = allRows.length;
    runLog.totals.domainsProcessed = processedDomains.size;
    runLog.totals.emailsCount = allRows.length;
    runLog.timing.endTime = endTime;
    runLog.timing.durationMs = new Date(endTime) - new Date(startTime);

    // CSV was written incrementally. If no rows were written yet (e.g. empty run), init file.
    const finalOutPath = outPath || csvPath;
    if (finalOutPath && !csvInitialized) {
      await initLeadsCsv(finalOutPath);
    }
    logger.info('Leads CSV written incrementally', { path: finalOutPath, rows: allRows.length });

    const logPath = `logs/run-${runLog.date}.json`;
    await writeFile(logPath, JSON.stringify(runLog, null, 2), 'utf-8');

    logger.info('Extraction complete', {
      leads: runLog.totals.leadsCount,
      domainsProcessed: runLog.totals.domainsProcessed,
      snowballDomains: runLog.totals.snowballDomains,
      skipped: runLog.skipped.length,
      durationMs: runLog.timing.durationMs,
      logPath,
      skippedLogPath,
    });

    return { rows: allRows, runLog };
  }

  function getResults() {
    return { rows: allRows, runLog };
  }

  return { addDomain, finish, getResults };
}

// ── Legacy entry point (file-based, non-streaming) ──────────────────

/**
 * Run extraction: read domains from file, crawl, extract, write CSV.
 * Supports snowball if config.snowball.enabled is true.
 */
export async function runExtract(domainsPath, outPath, options = {}) {
  const raw = await readFile(domainsPath, 'utf-8');
  const domains = JSON.parse(raw);
  if (!Array.isArray(domains)) throw new Error('domains.json must be an array');

  logger.info('Extraction started', {
    domains: domains.length,
    outPath,
  });

  const extractor = createStreamingExtractor(options, outPath);

  for (const rec of domains) {
    extractor.addDomain(rec);
  }

  return extractor.finish(outPath);
}

export default runExtract;
