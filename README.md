# scrapper

A locally-running, AI-powered email scraper. It discovers websites through search engines, crawls them for contact information, and extracts publicly available email addresses.

I built this because manually hunting for business emails across hundreds of websites is painfully slow. This tool is here to automate it.

If you're doing B2B outreach with zero budget, market research, or lead generation and need to collect publicly available contact emails at scale, this might save you a lot of time.

## Table of Contents

- [What It Does](#what-it-does)
- [Features](#features)
- [Requirements](#requirements)
- [Setup](#setup)
- [Usage](#usage)
- [Configuration](#configuration)
- [Output](#output)
- [Email Quality](#email-quality)
- [Search Providers](#search-providers)
- [AI Extraction](#ai-extraction)
- [Domain Filtering](#domain-filtering)
- [Compliance & Ethics](#compliance--ethics)
- [Project Structure](#project-structure)
- [Tips](#tips)
- [License](#license)

---

## What It Does

At its core, **scrapper** is a three-stage pipeline:

```
[Discovery] → [Extraction] → [Output]
```

1. **Discovery** — Finds websites that match your search keywords using your preferred search engine (SearXNG, SerpAPI, or Google Custom Search). Can also scrape online directories.

2. **Extraction** — Crawls each discovered website (homepage, contact page, about page, partners page) and pulls out email addresses using regex pattern matching and/or an AI language model.

3. **Output** — Saves results to a CSV file incrementally, so even if you stop the process mid-way, you keep everything found so far.

### The Streaming Pipeline

One thing I'm quite happy with: the pipeline is **streaming**. It doesn't wait for all discovery to finish before starting extraction. As soon as the first websites are found, extraction begins in parallel. This makes the whole process significantly faster than a sequential approach.

```
Search (SearXNG / SerpAPI / Google CSE)
        +                                → Domain Queue → Crawl → Extract → leads.csv
Directory Scraping (optional)                              |
        ^                                                  v
        └────── Snowball (partner links) ←──── Crawled Pages
```

### Snowball Discovery

When crawling a website, the tool can optionally look for outbound links that point to similar businesses — partner links, affiliate pages, "our partners" sections, etc. These newly discovered domains get added to the extraction queue automatically. It's a nice way to organically find more leads beyond what search engines return.

---

## Features

- **Multiple search backends** — SearXNG (self-hosted, free, no API key), SerpAPI, or Google Custom Search
- **Country-specific search** — Target specific markets by setting locale/language parameters per query (e.g., search through `google.co.uk`, `google.de`, `google.fr`)
- **AI-assisted extraction** — Uses a small LLM (via [OpenRouter](https://openrouter.ai/)) to find emails that regex might miss, with classification (generic/personal) and confidence scoring
- **Smart email filtering** — Filters out junk emails (`noreply@`, `privacy@`, `dpo@`), validates format, and prioritizes outreach-friendly addresses (`info@`, `contact@`, `sales@`)
- **Domain filtering** — Configurable filters to skip domains that don't match your target (by TLD, domain keywords, etc.)
- **Incremental saving** — Results are written to CSV as they're found. Ctrl+C? No problem, your data is safe.
- **Snowball discovery** — Finds new domains through partner/affiliate links on crawled pages
- **Directory scraping** — Scrape online business directories for additional leads
- **robots.txt compliance** — Respects robots.txt disallow rules
- **Rate limiting** — Configurable delays and concurrency to be polite to servers
- **Headless browser fallback** — Optional Puppeteer-based fetching for sites behind Cloudflare or similar protection
- **Relevance scoring** — Score domains based on keyword matches to filter out irrelevant results

---

## Requirements

- **Node.js** v18 or later
- **A search provider** (at least one):
  - [SearXNG](https://docs.searxng.org/) — self-hosted, no API key. Run with Docker.
  - [SerpAPI](https://serpapi.com/) — cloud API, requires a key (free tier available).
  - [Google Custom Search](https://programmablesearchengine.google.com/) — 100 free queries/day.
- **OpenRouter API key** *(optional)* — for AI-assisted email extraction. Get one free at [openrouter.ai](https://openrouter.ai/). Without it, the tool uses regex-only extraction, which still works well.
- **Docker** *(optional)* — only needed if using SearXNG.

---

## Setup

1. **Clone the repo:**

   ```bash
   git clone https://github.com/0xSafak/scrapper.git
   cd scrapper
   ```

2. **Install dependencies:**

   ```bash
   npm install
   ```

3. **Set up your environment:**

   ```bash
   cp .env.example .env
   ```

   On Windows (PowerShell): `copy .env.example .env`

   Edit `.env` and add your API keys. See [Environment Variables](#environment-variables) below.

4. **Create your config:**

   ```bash
   cp config.example.json config.json
   ```

   On Windows (PowerShell): `copy config.example.json config.json`

   Edit `config.json` to set your search keywords, target markets, and extraction preferences. See [Configuration](#configuration) below.

5. **(Optional) Start SearXNG** if you're using it as your search provider:

   ```powershell
   # PowerShell (Windows) — from the project folder
   .\run-searxng.ps1
   ```

   Or manually with Docker:

   ```bash
   docker run -d -p 8081:8080 \
     -v "$(pwd)/searxng-settings.yml:/etc/searxng/settings.yml" \
     --name searxng searxng/searxng
   ```

---

## Environment Variables

Create a `.env` file from the example:

| Variable | Required? | Description |
|----------|-----------|-------------|
| `SEARXNG_URL` | If using SearXNG | URL of your local SearXNG instance (e.g., `http://127.0.0.1:8081`) |
| `SERPAPI_API_KEY` | If using SerpAPI | Your SerpAPI key from [serpapi.com](https://serpapi.com/) |
| `GOOGLE_CSE_API_KEY` | If using Google CSE | Your Google API key |
| `GOOGLE_CSE_CX` | If using Google CSE | Your Programmable Search Engine ID |
| `OPENROUTER_API_KEY` | No (recommended) | Enables AI-assisted extraction. [openrouter.ai](https://openrouter.ai/) |
| `USER_AGENT` | No | Custom User-Agent string for HTTP requests |

---

## Usage

### Full Pipeline (Recommended)

Run discovery and extraction together in a streaming pipeline:

```bash
node index.js run --config config.json --out leads.csv
```

This will:
1. Search for websites matching your keywords
2. Optionally scrape any configured directories
3. Start extracting emails as soon as domains are discovered
4. Apply snowball discovery if enabled
5. Save results incrementally to `leads.csv`

### Step by Step

If you prefer to run each stage separately:

**Discover websites:**

```bash
node index.js discover --config config.json --out domains.json
```

**Discover from directories:**

```bash
node index.js discover-directories --config config.json --out domains.json
```

**Extract emails from discovered domains:**

```bash
node index.js extract --domains domains.json --out leads.csv --config config.json
```

### CLI Flags

| Command | Key Flags | Description |
|---------|-----------|-------------|
| `run` | `--config`, `--out`, `--domains-out`, `--min-score`, `--concurrency`, `--timeout`, `--model`, `--use-browser`, `--skip-directories` | Full streaming pipeline |
| `discover` | `--config`, `--out`, `--concurrency` | Search-based discovery only |
| `discover-directories` | `--config`, `--out` | Directory scraping only |
| `extract` | `--domains`, `--out`, `--config`, `--min-score`, `--concurrency`, `--timeout`, `--model`, `--use-browser` | Email extraction only |

**Examples:**

```bash
# Full pipeline with custom concurrency
node index.js run --config config.json --out leads.csv --concurrency 5

# Discovery only, with 3 parallel queries
node index.js discover --config config.json --out domains.json --concurrency 3

# Extract with headless browser (for Cloudflare-protected sites)
node index.js extract --domains domains.json --out leads.csv --config config.json --use-browser

# Extract with a specific AI model
node index.js extract --domains domains.json --out leads.csv --config config.json --model "anthropic/claude-3-haiku"
```

---

## Configuration

The `config.json` file controls everything. Here's a breakdown of each section.

### `keywords`

An array of search terms. These are the queries sent to search engines to find relevant websites. Keep them focused on your target — **15-25 keywords** is usually a good sweet spot.

```json
{
  "keywords": [
    "web design agency",
    "web development company",
    "digital marketing agency",
    "SEO agency contact",
    "freelance web developer"
  ]
}
```

### `minRelevanceScore`

Minimum relevance score (integer) for a domain to be included in results. Domains are scored based on how well their page content matches your keywords. Set to `0` to include everything.

### `discovery`

Controls how the tool searches for websites.

| Key | Default | Description |
|-----|---------|-------------|
| `provider` | `"serpapi"` | Search backend: `"serpapi"`, `"searxng"`, or `"google"` |
| `queryStrategy` | `"broad+markets"` | `"broad+markets"` sends each keyword globally + core keywords per locale. `"full"` does keyword × country × city (many more queries). |
| `topMarkets` | *See defaults* | Array of market objects with locale data for country-specific search |
| `concurrency` | `2` (1 for SearXNG) | How many search queries run in parallel |
| `delayBetweenSearxngQueriesMs` | `2500` | Delay between SearXNG queries to avoid rate limits |
| `resultsPerQuery` | `20` | Max results per query. SearXNG paginates automatically up to 100. |

**Top Markets format** (for country-specific search targeting):

```json
{
  "topMarkets": [
    { "name": "United Kingdom", "searxngLang": "en-GB", "serpGl": "gb", "serpDomain": "google.co.uk" },
    { "name": "Germany", "searxngLang": "de-DE", "serpGl": "de", "serpDomain": "google.de" },
    { "name": "France", "searxngLang": "fr-FR", "serpGl": "fr", "serpDomain": "google.fr" }
  ]
}
```

This lets you search as if you were in that country — the same keyword can return very different results depending on locale.

### `directories` *(optional)*

Scrape online directories for additional domains. The tool includes a built-in parser for TourRadar-style directories and a generic parser that extracts outbound links from any directory page.

```json
{
  "directories": [
    {
      "name": "my-directory",
      "type": "generic",
      "url": "https://example.com/business-directory",
      "maxPages": 5,
      "delayMs": 2000
    }
  ]
}
```

| Key | Description |
|-----|-------------|
| `name` | Friendly name for logging |
| `type` | `"tourradar"` (built-in parser) or `"generic"` (extracts all outbound links) |
| `url` | Starting URL of the directory |
| `maxPages` | How many pages to scrape |
| `delayMs` | Delay between page requests |

### `snowball` *(optional)*

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Enable snowball discovery from partner links |
| `maxDepth` | `1` | How deep to follow. `1` = only from originally discovered domains. |
| `maxNewDomainsPerSource` | `10` | Max new domains to discover per crawled site |

### `extraction`

| Key | Default | Description |
|-----|---------|-------------|
| `concurrency` | `5` | How many domains to crawl in parallel |
| `timeoutMs` | `15000` | HTTP request timeout per page |
| `retries` | `2` | Retry count for failed requests |
| `retryDelaysMs` | `[1000, 2000]` | Backoff delays between retries |
| `delayBetweenRequestsMs` | `200` | Delay between requests to the same domain |
| `useBrowser` | `false` | Use headless Chrome (Puppeteer) instead of axios. Slower but handles Cloudflare. |
| `enableAiExtract` | `true` | Use LLM for email extraction (needs `OPENROUTER_API_KEY`) |
| `aiTextMaxChars` | `4000` | Max characters of page text sent to the LLM |
| `maxEmailsPerDomain` | `5` | Keep only the N best emails per domain |
| `openRouter.model` | `"meta-llama/llama-3.1-8b-instruct:free"` | Which OpenRouter model to use for extraction |

### `unrelatedKeywords`

A blocklist. If a domain's page content contains any of these terms, it gets a relevance score penalty. Useful for filtering out noise.

```json
{
  "unrelatedKeywords": ["casino", "gambling", "real estate", "cryptocurrency"]
}
```

---

## Output

| File | Description |
|------|-------------|
| `leads.csv` | Main output — one row per email found |
| `domains.json` | All discovered domains with metadata |
| `logs/run-YYYYMMDD.json` | Run statistics (timing, counts, errors) |
| `logs/skipped.log` | Domains that were skipped and why |

### CSV Columns

| Column | Description |
|--------|-------------|
| `business_name` | Business name extracted from the site (page title or H1) |
| `domain` | Website domain |
| `country` | Country (from search locale, if available) |
| `city` | City (from search query, if available) |
| `email` | Extracted email address |
| `email_type` | `generic` (info@, sales@, contact@) or `personal` |
| `confidence` | 0.0 – 1.0 confidence score |
| `relevance_score` | How relevant the domain is to your keywords |
| `source_url` | The exact page URL where the email was found |
| `discovered_by_query` | Which search query led to discovering this domain |

---

## Email Quality

Extracting emails from the wild web is messy. A naive regex will give you tons of garbage. This tool puts real effort into giving you clean, useful results:

- **Format validation** — Word-boundary regex with lookahead prevents garbage like `info@site.comphone` or `user@domain.travelby`
- **Junk filtering** — `privacy@`, `dpo@`, `compliance@`, `noreply@`, `postmaster@`, `webmaster@` are automatically excluded
- **Smart prioritization** — Emails are ranked: `info@` > `contact@` > `sales@` > `booking@` > other generic > personal addresses
- **Capped per domain** — Only the top N emails per domain are kept (configurable, default 5)
- **AI + regex merge** — When both methods find the same email, the confidence score is boosted and marked as verified by both
- **HTML sanitization** — Strips HTML entities and artifacts before extraction to avoid false matches

---

## Search Providers

### SearXNG (Self-Hosted) — Free

No API key, no quotas, no cost. You run a SearXNG instance locally with Docker, and the tool queries it.

**Pros:** Free, private, unlimited queries.
**Cons:** Search engines sometimes block requests from Docker instances, so results can be less consistent. Pagination helps, but you may get fewer results than SerpAPI.

The tool includes a `searxng-settings.yml` file that enables JSON output (required) and a helper script:

```powershell
# Start SearXNG (PowerShell)
.\run-searxng.ps1
```

Or run Docker directly:

```bash
docker run -d -p 8081:8080 \
  -v "$(pwd)/searxng-settings.yml:/etc/searxng/settings.yml" \
  --name searxng searxng/searxng
```

SearXNG returns ~20 results per page. The tool automatically paginates to collect up to `resultsPerQuery` results (max 100).

### SerpAPI — Reliable

A paid service with a free tier. Very reliable results, supports country-specific search (`gl` and `google_domain` parameters).

Get your API key at [serpapi.com](https://serpapi.com/) and set `SERPAPI_API_KEY` in `.env`.

### Google Custom Search — 100 Free/Day

Good for small-scale runs or testing. Set up a Programmable Search Engine at [programmablesearchengine.google.com](https://programmablesearchengine.google.com/).

Set `GOOGLE_CSE_API_KEY` and `GOOGLE_CSE_CX` in `.env`.

---

## AI Extraction

By default, the tool uses regex to find emails in page text. If you provide an `OPENROUTER_API_KEY`, it also sends the visible page text to a language model to extract emails the regex might miss.

The default model is **Llama 3.1 8B** (free on OpenRouter). It's fast, cheap, and good enough for email extraction. You can swap in any model available on [OpenRouter](https://openrouter.ai/) by setting `extraction.openRouter.model` in your config.

The AI is prompted to:
- Only extract emails that are **explicitly present** in the text (no hallucinating)
- Classify each email as `generic`, `personal`, or `unknown`
- Assign a confidence score (0.0 – 1.0)

When both regex and AI find the same email, it gets marked as `extracted_by: "both"` with a boosted confidence score. This gives you high confidence that the email is real.

---

## Domain Filtering

The tool supports configurable domain filters to skip websites that don't match your target audience. This is done through:

- **TLD-based filtering** — Skip domains with specific top-level domains (e.g., `.com.tr`, `.gov.tr`)
- **Keyword-based filtering** — Skip domains containing certain words (e.g., city names, brand keywords)

The default configuration includes filters for Turkish domains (since the example config targets international agencies). You can customize these filters in `src/discover/normalizeDomain.js` to match your use case.

---

## Compliance & Ethics

This tool only collects email addresses that are **publicly displayed** on websites. It does not:

- Access private/authenticated areas
- Bypass CAPTCHAs or anti-bot measures
- Ignore `robots.txt` disallow rules
- Aggressively hammer servers — all requests are rate-limited with configurable delays

Each email in the output includes its **source URL**, so you always know exactly where it came from.

**Please use this tool responsibly.** Respect website terms of service and applicable privacy regulations (GDPR, CAN-SPAM, etc.) when using any data you collect. This tool is meant for collecting publicly available business contact information, not for spamming.

---

## Project Structure

```
scrapper/
├── index.js                          # CLI entry point (Commander.js)
├── config.example.json               # Example configuration
├── .env.example                      # Example environment variables
├── searxng-settings.yml              # SearXNG config (enables JSON output)
├── run-searxng.ps1                   # PowerShell helper to start SearXNG via Docker
├── package.json
│
└── src/
    ├── discover/
    │   ├── runDiscover.js            # Orchestrates search-based discovery
    │   ├── searxngSearch.js          # SearXNG client (with pagination)
    │   ├── serpApiSearch.js          # SerpAPI client
    │   ├── googleSearch.js           # Google Custom Search client
    │   ├── directoryDiscover.js      # Online directory scraping
    │   ├── snowballDiscover.js       # Partner link discovery
    │   └── normalizeDomain.js        # Domain normalization & filtering
    │
    ├── extract/
    │   ├── runExtract.js             # Streaming extraction engine
    │   ├── crawlDomain.js            # Website crawler (axios + optional Puppeteer)
    │   ├── extractEmails.js          # Email extraction (regex + AI merge)
    │   ├── openRouterExtract.js      # LLM-based email extraction via OpenRouter
    │   ├── scoreRelevance.js         # Content relevance scoring
    │   └── browserFetch.js           # Headless Chrome fetch (Puppeteer)
    │
    └── utils/
        ├── csvWriter.js              # Incremental CSV output
        ├── robots.js                 # robots.txt parser & checker
        └── logger.js                 # Structured logging
```

---

## Tips

- **Start small** — Use 5-10 keywords and run `discover` first to see what domains come back before running the full pipeline.
- **Check the skipped log** — `logs/skipped.log` tells you which domains were skipped and why. Really helpful for tuning your config.
- **SearXNG quirks** — If SearXNG returns very few results, try different keywords or switch to SerpAPI. SearXNG's results depend on which upstream engines are available.
- **AI is optional** — Regex-only extraction works well for most websites. AI helps with edge cases (emails in unusual formats, obfuscated with JavaScript, etc.).
- **Incremental saves** — The tool writes to CSV after every domain. If you need to stop mid-run, just Ctrl+C. Your results are safe.
- **Be polite** — Keep `delayBetweenRequestsMs` at a reasonable value (200ms+). Nobody likes getting hammered.
- **Browser mode** — If many sites return 403 errors, try `--use-browser`. It's slower but uses a real Chrome instance that passes Cloudflare checks.

---

## Contributing

Contributions are welcome! Feel free to open issues or PRs. If you have ideas for new discovery sources, better email parsing, or any improvements, I'd love to hear them.

---

## License

MIT

---

*Built with a lot of coffee and a desire to automate the boring stuff. If this saves you some time, I'm happy. Drop a star if you find it useful!*
