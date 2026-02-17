import { program } from 'commander';
import { readFile, writeFile } from 'fs/promises';
import dotenv from 'dotenv';

import { runDiscover } from './src/discover/runDiscover.js';
import { runExtract, createStreamingExtractor } from './src/extract/runExtract.js';
import { runDirectoryDiscover } from './src/discover/directoryDiscover.js';

dotenv.config();

program
  .name('scrapper')
  .description('AI-powered email scraper — discover websites, crawl them, and extract contact emails')
  .version('2.0.0');

// ── discover ──────────────────────────────────────────────────────────
program
  .command('discover')
  .description('Search for candidate domains (SearXNG / SerpAPI / Google CSE)')
  .requiredOption('--config <path>', 'Config JSON path')
  .requiredOption('--out <path>', 'Output domains JSON path')
  .option('--concurrency <n>', 'Discovery concurrency', (v) => parseInt(v, 10))
  .action(async (opts) => {
    const config = JSON.parse(await readFile(opts.config, 'utf-8'));
    if (opts.concurrency != null) {
      config.discovery = config.discovery || {};
      config.discovery.concurrency = opts.concurrency;
    }
    await runDiscover(config, opts.out);
  });

// ── discover-directories ──────────────────────────────────────────────
program
  .command('discover-directories')
  .description('Scrape online directories for business domains')
  .requiredOption('--config <path>', 'Config JSON path')
  .requiredOption('--out <path>', 'Output domains JSON path (merges with existing if present)')
  .action(async (opts) => {
    const config = JSON.parse(await readFile(opts.config, 'utf-8'));
    const directories = config.directories || [];
    if (!directories.length) {
      console.error('No directories configured in config.directories');
      process.exit(1);
    }

    // Load existing domains if file exists
    let existing = [];
    try {
      existing = JSON.parse(await readFile(opts.out, 'utf-8'));
    } catch (_) {}
    const seenDomains = new Set(existing.map((d) => d.domain));

    const newDomains = await runDirectoryDiscover(directories);
    let added = 0;
    for (const d of newDomains) {
      if (!seenDomains.has(d.domain)) {
        existing.push(d);
        seenDomains.add(d.domain);
        added++;
      }
    }

    await writeFile(opts.out, JSON.stringify(existing, null, 2), 'utf-8');
    console.log(`Directory discovery: ${newDomains.length} found, ${added} new, ${existing.length} total in ${opts.out}`);
  });

// ── extract ───────────────────────────────────────────────────────────
program
  .command('extract')
  .description('Crawl domains and extract emails to CSV (with snowball)')
  .requiredOption('--domains <path>', 'Domains JSON from discover')
  .requiredOption('--out <path>', 'Output leads CSV path')
  .option('--config <path>', 'Config JSON (for minRelevanceScore, extraction, snowball, unrelatedKeywords)')
  .option('--min-score <n>', 'Minimum relevance score', (v) => parseInt(v, 10))
  .option('--concurrency <n>', 'Extraction concurrency', (v) => parseInt(v, 10))
  .option('--timeout <ms>', 'Request timeout ms', (v) => parseInt(v, 10))
  .option('--model <id>', 'OpenRouter model (overrides config extraction.openRouter.model)')
  .option('--use-browser', 'Use headless Chrome to fetch pages (avoids 403 on protected sites)')
  .action(async (opts) => {
    let config = {};
    if (opts.config) {
      config = JSON.parse(await readFile(opts.config, 'utf-8'));
    }
    if (opts.minScore != null) config.minRelevanceScore = opts.minScore;
    if (opts.concurrency != null) {
      config.extraction = config.extraction || {};
      config.extraction.concurrency = opts.concurrency;
    }
    if (opts.timeout != null) {
      config.extraction = config.extraction || {};
      config.extraction.timeoutMs = opts.timeout;
    }
    if (opts.model != null) {
      config.extraction = config.extraction || {};
      config.extraction.openRouter = config.extraction.openRouter || {};
      config.extraction.openRouter.model = opts.model;
    }
    if (opts.useBrowser) {
      config.extraction = config.extraction || {};
      config.extraction.useBrowser = true;
    }
    await runExtract(opts.domains, opts.out, config);
    if (config.extraction?.useBrowser) {
      await new Promise((r) => setTimeout(r, 1500));
      process.exit(0);
    }
  });

// ── run (streaming: discover + directories + extract + snowball) ─────
program
  .command('run')
  .description('Full pipeline: discover (search + directories) then extract with snowball, streamed')
  .requiredOption('--config <path>', 'Config JSON path')
  .requiredOption('--out <path>', 'Output leads CSV path')
  .option('--domains-out <path>', 'Intermediate domains JSON (default: domains.json)', 'domains.json')
  .option('--min-score <n>', 'Minimum relevance score', (v) => parseInt(v, 10))
  .option('--concurrency <n>', 'Concurrency for discover/extract', (v) => parseInt(v, 10))
  .option('--timeout <ms>', 'Request timeout ms', (v) => parseInt(v, 10))
  .option('--model <id>', 'OpenRouter model (overrides config extraction.openRouter.model)')
  .option('--use-browser', 'Use headless Chrome for extraction (avoids 403 on protected sites)')
  .option('--skip-directories', 'Skip directory scraping (search only)')
  .action(async (opts) => {
    const config = JSON.parse(await readFile(opts.config, 'utf-8'));
    if (opts.minScore != null) config.minRelevanceScore = opts.minScore;
    if (opts.useBrowser) {
      config.extraction = config.extraction || {};
      config.extraction.useBrowser = true;
    }
    if (opts.model != null) {
      config.extraction = config.extraction || {};
      config.extraction.openRouter = config.extraction.openRouter || {};
      config.extraction.openRouter.model = opts.model;
    }
    if (opts.concurrency != null) {
      config.discovery = config.discovery || {};
      config.discovery.concurrency = opts.concurrency;
      config.extraction = config.extraction || {};
      config.extraction.concurrency = opts.concurrency;
    }
    if (opts.timeout != null) {
      config.extraction = config.extraction || {};
      config.extraction.timeoutMs = opts.timeout;
    }

    // Create streaming extractor with incremental CSV writing
    const extractor = createStreamingExtractor(config, opts.out);
    const allDiscoveredDomains = [];

    // Callback: each discovered domain goes straight to extraction
    const onDomainFound = (rec) => {
      allDiscoveredDomains.push(rec);
      extractor.addDomain(rec);
    };

    // Run search discovery and directory discovery in parallel
    const discoverPromise = runDiscover(config, opts.domainsOut, onDomainFound);

    let directoryPromise = Promise.resolve([]);
    const directories = config.directories || [];
    if (directories.length > 0 && !opts.skipDirectories) {
      directoryPromise = runDirectoryDiscover(directories, onDomainFound);
    }

    // Wait for both discovery sources to finish
    await Promise.all([discoverPromise, directoryPromise]);

    // Save all discovered domains (search + directories) to the domains file
    await writeFile(opts.domainsOut, JSON.stringify(allDiscoveredDomains, null, 2), 'utf-8');

    // Wait for all extraction (+ snowball) to complete
    const result = await extractor.finish(opts.out);

    if (config.extraction?.useBrowser) {
      await new Promise((r) => setTimeout(r, 1500));
      process.exit(0);
    }
  });

program.parse();
