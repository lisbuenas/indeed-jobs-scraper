# Indeed Jobs Scraper

Scrape job listings from [Indeed](https://www.indeed.com) with full details: title, company, location, salary, job type, posting date, full description, apply link and company rating. Each job becomes one item in the Apify dataset.

## Features

- **Search filters**: keywords, location, country site, posted within N days, job type and remote-only.
- **Full descriptions**: the scraper opens every job page instead of keeping only the short snippet from the search results.
- **Resilient multi-selector architecture**: every field is extracted with layered strategies, so a single markup change on Indeed doesn't break the scraper (see below).
- **Graceful degradation**: if a job page can't be loaded, the job is still saved with the search card data, flagged with `#warning`.
- **Polite crawling**: random 1–2 s delay before every request, low concurrency, session rotation and anti-bot detection with automatic retries.
- **Handles "no results"** searches without failing the run.

## Input

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `keywords` | string | **required** | Job title, skills or company |
| `location` | string | empty | City, state, ZIP or "remote" |
| `country` | string | `us` | Indeed site: `us` = www.indeed.com, `uk` = uk.indeed.com, `ca`, `br`, `de`, ... |
| `maxResults` | integer | `50` | Maximum number of jobs to save |
| `daysPosted` | integer | none | Posted within N days. Indeed supports 1, 3, 7 or 14; other values round up. |
| `jobType` | enum | none | `fulltime`, `parttime`, `contract` or `internship` |
| `remoteOnly` | boolean | `false` | Only remote jobs |
| `maxConcurrency` | integer | `2` | Parallel pages |
| `proxyConfiguration` | object | `{ "useApifyProxy": true }` | Apify Proxy settings. Residential proxies are recommended. |

Example:

```json
{
  "keywords": "data engineer",
  "location": "Austin, TX",
  "country": "us",
  "maxResults": 100,
  "daysPosted": 7,
  "jobType": "fulltime",
  "remoteOnly": false,
  "proxyConfiguration": { "useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"] }
}
```

The search URL is built as `https://www.indeed.com/jobs?q={keywords}&l={location}&fromage={daysPosted}&jt={jobType}`, plus `sc=0kf:attr(DSQF7);` for remote-only and `start` for pagination.

## Output

```json
{
  "jobId": "a1b2c3d4e5f6a7b8",
  "title": "Senior Data Engineer",
  "company": "Example Corp",
  "companyRating": 4.1,
  "companyReviewCount": 523,
  "location": "Austin, TX",
  "isRemote": false,
  "salary": "$140,000 - $170,000 a year",
  "jobType": "Full-time",
  "datePosted": "2026-09-12",
  "datePostedText": "3 days ago",
  "description": "About the role\n\nWe are looking for ...",
  "descriptionIsSnippet": false,
  "applyUrl": "https://www.indeed.com/viewjob?jk=a1b2c3d4e5f6a7b8",
  "jobUrl": "https://www.indeed.com/viewjob?jk=a1b2c3d4e5f6a7b8",
  "searchKeywords": "data engineer",
  "searchLocation": "Austin, TX",
  "country": "us",
  "searchUrl": "https://www.indeed.com/jobs?q=data+engineer&l=Austin%2C+TX&fromage=7&jt=fulltime",
  "scrapedAt": "2026-09-15T12:00:00.000Z"
}
```

- Missing values are always `null`.
- `applyUrl` is the employer's external application link when Indeed exposes one. Otherwise it's the Indeed job page, where "Easily apply" jobs are applied to.
- `datePosted` is an ISO date. When Indeed only shows relative text ("3 days ago", "30+ days ago"), the date is approximate; the original text is kept in `datePostedText`.
- `descriptionIsSnippet: true` means the job page couldn't be loaded and `description` holds the short search snippet instead. Such items also have a `#warning` field.

## How the resilient extraction works

Each field is resolved by trying strategies in order until one returns a value:

1. **Embedded JSON**: the search results model (`window.mosaic.providerData["mosaic-provider-jobcards"]`), the job page's `window._initialData`, and JSON-LD `JobPosting`. Keys are looked up by name anywhere in the object, not by a fixed path, so reshuffled models keep working.
2. **CSS selectors**: at least two selector strategies per field (current `data-testid` attributes, older class names, structural fallbacks). Each one runs in its own `try/catch` and can require the text to match a pattern, e.g. a currency sign for salary.

Search card and job page values are merged, with job page values taking priority. All strategies are declared as data in `CARD_FIELDS` and `DETAIL_FIELDS` in `src/main.js`, so fixing a broken field means adding a selector to a list.

## Troubleshooting blocks

Indeed uses Cloudflare and other anti-bot protection.

- Use **residential proxies** (`"apifyProxyGroups": ["RESIDENTIAL"]`).
- The actor runs **headless** by default. If runs keep failing with "Blocked by anti-bot protection", set the environment variable `CRAWLEE_HEADLESS=0` in the actor's settings. The Docker image starts a virtual display (XVFB), so a headful browser works on the Apify platform without code changes. Headful browsers are often much harder for Cloudflare to detect.
- Keep `maxConcurrency` low.

## Run locally

```bash
npm install
npx playwright install chromium
mkdir -p storage/key_value_stores/default
echo '{"keywords":"data engineer","location":"Austin, TX","maxResults":10}' > storage/key_value_stores/default/INPUT.json
npm start
```

## Tech

Node.js 20, [Crawlee](https://crawlee.dev) `PlaywrightCrawler` and the [Apify SDK](https://docs.apify.com/sdk/js).
