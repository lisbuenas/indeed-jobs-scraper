/**
 * Indeed Jobs Scraper
 *
 * Flow:
 *   LIST page (?start=0) ──► DETAIL page for each job (full description) ──► dataset
 *        └──► LIST page (?start=10) ──► ...   until maxResults or no more jobs
 *
 * Resilience is the core design goal. Indeed changes its markup often, so every
 * field is extracted with layered strategies, tried in order until one returns a value:
 *
 *   1. Embedded JSON (search results model / `_initialData` / JSON-LD JobPosting),
 *      looked up by key name anywhere in the object so structure changes don't break it.
 *   2. At least two CSS selector strategies per field, each isolated in try/catch.
 *
 * Values from the listing card and the detail page are merged, so a field missing
 * from one source is filled from the other. If a detail page fails permanently, the
 * job is still saved with the listing card data.
 */
import { Actor, log } from 'apify';
import { PlaywrightCrawler, sleep } from 'crawlee';

const LABELS = {
    LIST: 'LIST',
    DETAIL: 'DETAIL',
};

/** Indeed moves `start` by 10 per page regardless of how many cards it shows. */
const PAGE_OFFSET_STEP = 10;
/** Indeed stops serving results around start=1000. */
const MAX_LIST_PAGES = 100;
/** Values accepted by Indeed's `fromage` (posted within N days) parameter. */
const SUPPORTED_DAYS_POSTED = [1, 3, 7, 14];
/** Indeed's "Remote" attribute filter. */
const REMOTE_FILTER = '0kf:attr(DSQF7);';

await Actor.init();

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const input = (await Actor.getInput()) ?? {};
const {
    keywords,
    location = '',
    country = 'us',
    maxResults = 50,
    daysPosted = null,
    jobType = null,
    remoteOnly = false,
    maxConcurrency = 2,
    proxyConfiguration: proxyInput = { useApifyProxy: true },
} = input;

if (!keywords || !String(keywords).trim()) {
    throw new Error('Input "keywords" is required.');
}

const VALID_JOB_TYPES = ['fulltime', 'parttime', 'contract', 'internship'];
if (jobType && !VALID_JOB_TYPES.includes(jobType)) {
    throw new Error(`Input "jobType" must be one of: ${VALID_JOB_TYPES.join(', ')}.`);
}

const countryCode = String(country || 'us').trim().toLowerCase();
const origin = indeedOrigin(countryCode);

// Locally, Apify Proxy is only available with an Apify token, so skip it if unavailable.
const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput).catch((err) => {
    log.warning(`Proxy configuration failed, running without proxy: ${err.message}`);
    return undefined;
});

// ---------------------------------------------------------------------------
// Run state, persisted so an actor migration resumes without duplicates.
// ---------------------------------------------------------------------------

const state = await Actor.useState('RUN_STATE', {
    enqueuedJobIds: {}, // job IDs already sent to the detail queue
    enqueuedCount: 0,
    savedCount: 0,
    listPages: 0,
});

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/** Maps a country code to its Indeed site. */
function indeedOrigin(code) {
    if (code === 'us') return 'https://www.indeed.com';
    if (code === 'gb') return 'https://uk.indeed.com';
    return `https://${code}.indeed.com`;
}

/** Rounds a day count up to the nearest value Indeed supports. */
function normalizeDaysPosted(days) {
    const n = Number(days);
    if (!Number.isFinite(n) || n <= 0) return null;
    return SUPPORTED_DAYS_POSTED.find((d) => d >= n) ?? SUPPORTED_DAYS_POSTED.at(-1);
}

function buildSearchUrl(start = 0) {
    const url = new URL('/jobs', origin);
    url.searchParams.set('q', String(keywords).trim());
    url.searchParams.set('l', String(location ?? '').trim());
    const fromage = normalizeDaysPosted(daysPosted);
    if (fromage) url.searchParams.set('fromage', String(fromage));
    if (jobType) url.searchParams.set('jt', jobType);
    if (remoteOnly) url.searchParams.set('sc', REMOTE_FILTER);
    if (start > 0) url.searchParams.set('start', String(start));
    return url.toString();
}

const buildJobUrl = (jobId) => `${origin}/viewjob?jk=${encodeURIComponent(jobId)}`;

// ---------------------------------------------------------------------------
// Extraction strategies
//
// Each field lists strategies tried in order. A strategy is plain data so it can be
// sent into the browser:
//   sel     CSS selector (omit to use the root element itself)
//   attr    read this attribute instead of the text
//   all     test every element matching `sel`, not just the first
//   test    regex the value must match to be accepted
//   pattern regex whose first capture group (or whole match) becomes the value
//   multiline keep line breaks (for descriptions)
// ---------------------------------------------------------------------------

const SALARY_TEST = '[$£€¥₹]|R\\$|\\b(per|an?|/)\\s*(hour|hr|year|yr|month|week|day)\\b|\\bhourly\\b|\\byearly\\b';
const JOB_TYPE_TEST = '\\b(full[- ]?time|part[- ]?time|contract|internship|temporary|permanent|freelance|seasonal|per diem)\\b';
const RATING_PATTERN = '(\\d(?:[.,]\\d)?)';
const RELATIVE_DATE_TEST = '(ago|today|just posted|active|hiring|posted|employer)';

/** Container selectors for job cards on the search results page. */
const CARD_SELECTORS = [
    'div.job_seen_beacon',
    '[data-testid="slider_item"]',
    'td.resultContent',
    'li div.cardOutline',
    'a[data-jk]',
];

const CARD_FIELDS = {
    jobId: [
        { sel: 'a[data-jk]', attr: 'data-jk' },
        { attr: 'data-jk' },
        { sel: '[data-jk]', attr: 'data-jk' },
        { sel: 'a[id^="job_"], a[id^="sj_"]', attr: 'id', pattern: '^(?:job|sj)_([a-z0-9]+)$' },
        { sel: 'a[href*="jk="]', attr: 'href', pattern: '[?&](?:jk|vjk)=([a-z0-9]+)' },
    ],
    title: [
        { sel: 'h2.jobTitle span[title]', attr: 'title' },
        { sel: 'a.jcs-JobTitle span[id^="jobTitle"]' },
        { sel: '[data-testid="jobTitle"]' },
        { sel: 'h2.jobTitle' },
        { sel: 'a[data-jk]', attr: 'aria-label', pattern: '^(?:full details of\\s+)?(.+)$' },
    ],
    company: [
        { sel: '[data-testid="company-name"]' },
        { sel: 'span.companyName' },
        { sel: '.companyName' },
        { sel: '.company_location [data-testid*="company"]' },
    ],
    location: [
        { sel: '[data-testid="text-location"]' },
        { sel: 'div.companyLocation' },
        { sel: '.companyLocation' },
        { sel: '.company_location > div > div:last-child' },
    ],
    salary: [
        { sel: '.salary-snippet-container', test: SALARY_TEST },
        { sel: '[data-testid="attribute_snippet_testid"]', all: true, test: SALARY_TEST },
        { sel: '.estimated-salary', test: SALARY_TEST },
        { sel: '.metadataContainer li, .jobMetaDataGroup div', all: true, test: SALARY_TEST },
    ],
    jobType: [
        { sel: '[data-testid="attribute_snippet_testid"]', all: true, test: JOB_TYPE_TEST },
        { sel: '.metadataContainer li, .jobMetaDataGroup div', all: true, test: JOB_TYPE_TEST },
        { sel: '.attribute_snippet', all: true, test: JOB_TYPE_TEST },
    ],
    datePostedText: [
        { sel: '[data-testid="myJobsStateDate"]' },
        { sel: 'span.date' },
        { sel: '.date' },
        { sel: '.underShelfFooter span', all: true, test: RELATIVE_DATE_TEST },
    ],
    companyRating: [
        { sel: '[data-testid="holistic-rating"]', pattern: RATING_PATTERN },
        { sel: 'span.ratingNumber', pattern: RATING_PATTERN },
        { sel: '[aria-label*="out of 5"]', attr: 'aria-label', pattern: RATING_PATTERN },
    ],
    snippet: [
        { sel: '[data-testid="jobsnippet_footer"]', multiline: true },
        { sel: '.job-snippet', multiline: true },
    ],
};

const DETAIL_FIELDS = {
    title: [
        { sel: '[data-testid="jobsearch-JobInfoHeader-title"]', pattern: '^(.*?)(?:\\s*-\\s*job post)?$' },
        { sel: 'h1.jobsearch-JobInfoHeader-title', pattern: '^(.*?)(?:\\s*-\\s*job post)?$' },
        { sel: '.jobsearch-JobInfoHeader-title-container h1' },
        { sel: 'h1' },
    ],
    company: [
        { sel: '[data-testid="inlineHeader-companyName"]' },
        { sel: '[data-company-name="true"]' },
        { sel: '.jobsearch-CompanyInfoContainer a' },
        { sel: '.jobsearch-InlineCompanyRating > div:first-child' },
    ],
    location: [
        { sel: '[data-testid="inlineHeader-companyLocation"]' },
        { sel: '[data-testid="job-location"]' },
        { sel: '#jobLocationText' },
        { sel: '.jobsearch-JobInfoHeader-subtitle > div:last-child' },
    ],
    salary: [
        { sel: '#salaryInfoAndJobType span', all: true, test: SALARY_TEST },
        { sel: '[data-testid="jobsearch-OtherJobDetailsContainer"] span', all: true, test: SALARY_TEST },
        { sel: '#jobDetailsSection [data-testid*="salary"], #salaryGuide li', all: true, test: SALARY_TEST },
        { sel: '.jobsearch-JobMetadataHeader-item', all: true, test: SALARY_TEST },
    ],
    jobType: [
        { sel: '#salaryInfoAndJobType span', all: true, test: JOB_TYPE_TEST },
        { sel: '[data-testid="jobsearch-OtherJobDetailsContainer"] span', all: true, test: JOB_TYPE_TEST },
        { sel: '#jobDetailsSection li, #jobDetailsSection [data-testid*="jobType"]', all: true, test: JOB_TYPE_TEST },
        { sel: '.jobsearch-JobMetadataHeader-item', all: true, test: JOB_TYPE_TEST },
    ],
    description: [
        { sel: '#jobDescriptionText', multiline: true },
        { sel: '[data-testid="jobsearch-JobComponent-description"]', multiline: true },
        { sel: '.jobsearch-jobDescriptionText', multiline: true },
        { sel: '.jobsearch-JobComponent-description', multiline: true },
    ],
    applyUrl: [
        { sel: '#applyButtonLinkContainer a[href]', attr: 'href' },
        { sel: 'a[href*="applystart"]', attr: 'href' },
        { sel: 'button[href]', attr: 'href' },
        { sel: 'a[aria-label*="Apply" i][href]', attr: 'href' },
    ],
    datePostedText: [
        { sel: '[data-testid="myJobsStateDate"]' },
        { sel: '.jobsearch-JobMetadataFooter span, .jobsearch-JobMetadataFooter div', all: true, test: RELATIVE_DATE_TEST },
        { sel: '.jobsearch-HiringInsights-entry--age' },
    ],
    companyRating: [
        { sel: '[data-testid="inlineHeader-companyReviewLink"] [aria-label]', attr: 'aria-label', pattern: RATING_PATTERN },
        { sel: '#companyRatings', attr: 'aria-label', pattern: RATING_PATTERN },
        { sel: '.jobsearch-InlineCompanyRating [aria-label*="out of 5"]', attr: 'aria-label', pattern: RATING_PATTERN },
        { sel: '[class*="ratingNumber"]', pattern: RATING_PATTERN },
    ],
};

/**
 * Runs inside the browser. Self-contained on purpose: Playwright serialises it and
 * evaluates it in the page, so it cannot reference anything from this module.
 *
 * mode "cards":  finds job cards with the first card selector that matches and
 *                extracts `fields` from each card.
 * mode "page":   extracts `fields` from the whole document.
 */
function browserExtract({ mode, cardSelectors, fields }) {
    const clean = (value, multiline) => {
        if (typeof value !== 'string') return null;
        const text = multiline
            ? value.replace(/[ \t\f\v]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim()
            : value.replace(/\s+/g, ' ').trim();
        return text || null;
    };

    const runStrategies = (root, strategies) => {
        for (const s of strategies) {
            try {
                let elements;
                if (!s.sel) elements = [root];
                else if (s.all) elements = [...root.querySelectorAll(s.sel)];
                else elements = [root.querySelector(s.sel)];

                for (const el of elements) {
                    if (!el) continue;
                    const raw = s.attr ? el.getAttribute(s.attr) : (el.innerText ?? el.textContent);
                    let value = clean(raw, s.multiline);
                    if (!value) continue;
                    if (s.test && !new RegExp(s.test, 'i').test(value)) continue;
                    if (s.pattern) {
                        const match = value.match(new RegExp(s.pattern, 'i'));
                        if (!match) continue;
                        value = clean(match[1] ?? match[0], s.multiline);
                        if (!value) continue;
                    }
                    return value;
                }
            } catch {
                // An invalid or unsupported selector must never break extraction.
            }
        }
        return null;
    };

    const extractFrom = (root) => Object.fromEntries(
        Object.entries(fields).map(([name, strategies]) => [name, runStrategies(root, strategies)]),
    );

    if (mode === 'page') return extractFrom(document);

    for (const selector of cardSelectors) {
        let cards = [];
        try {
            cards = [...document.querySelectorAll(selector)];
        } catch {
            continue;
        }
        if (cards.length) return cards.map(extractFrom);
    }
    return [];
}

// ---------------------------------------------------------------------------
// Embedded JSON helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the JSON object assigned in a script, e.g. `window._initialData = {...};`,
 * by bracket matching from the first `{` after `marker`.
 */
function extractJsonAfter(text, marker) {
    const markerIndex = text.indexOf(marker);
    if (markerIndex === -1) return null;
    const start = text.indexOf('{', markerIndex + marker.length);
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) {
                try {
                    return JSON.parse(text.slice(start, i + 1));
                } catch {
                    return null;
                }
            }
        }
    }
    return null;
}

/**
 * Depth-first search for the first non-empty value stored under any of `keys`.
 * Looking keys up anywhere in the object survives Indeed reshuffling its models.
 */
function deepFind(obj, keys, accept = () => true, maxDepth = 12) {
    const wanted = new Set(keys);
    // Breadth-first, so values closer to the root (the main job) win over nested modules.
    const queue = [{ value: obj, depth: 0 }];
    const seen = new Set();

    while (queue.length) {
        const { value, depth } = queue.shift();
        if (!value || typeof value !== 'object' || seen.has(value) || depth > maxDepth) continue;
        seen.add(value);

        for (const [key, child] of Object.entries(value)) {
            if (wanted.has(key) && child !== null && child !== undefined && child !== '' && accept(child)) return child;
        }
        for (const child of Object.values(value)) {
            if (child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 });
        }
    }
    return null;
}

/** Like deepFind, but only accepts strings or numbers (returned as a string). */
function deepFindString(obj, keys) {
    const value = deepFind(obj, keys, (v) => typeof v === 'string' || typeof v === 'number');
    return value === null ? null : String(value);
}

/** Search results model: window.mosaic.providerData["mosaic-provider-jobcards"]. */
async function extractListingJson(page, html) {
    let model = null;
    try {
        model = await page.evaluate(() => {
            const data = window.mosaic?.providerData?.['mosaic-provider-jobcards'];
            return data ? JSON.parse(JSON.stringify(data)) : null;
        });
    } catch {
        // Fall through to the HTML-based extraction.
    }
    model ??= extractJsonAfter(html, 'window.mosaic.providerData["mosaic-provider-jobcards"]');
    if (!model) return [];

    const results = model.metaData?.mosaicProviderJobCardsModel?.results
        ?? deepFind(model, ['results']);
    return Array.isArray(results) ? results.filter((r) => r && (r.jobkey || r.jobKey)) : [];
}

/** Detail page data: window._initialData plus any JSON-LD JobPosting. */
async function extractDetailJson(page, html) {
    let initialData = null;
    try {
        initialData = await page.evaluate(() => (window._initialData ? JSON.parse(JSON.stringify(window._initialData)) : null));
    } catch {
        // Fall through to the HTML-based extraction.
    }
    initialData ??= extractJsonAfter(html, 'window._initialData');

    let jobPosting = null;
    for (const [, json] of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
        try {
            const data = JSON.parse(json);
            const items = Array.isArray(data) ? data : [data, ...(data['@graph'] ?? [])];
            jobPosting = items.find((item) => item?.['@type'] === 'JobPosting') ?? jobPosting;
        } catch {
            // Ignore invalid JSON-LD.
        }
    }

    return { initialData, jobPosting };
}

// ---------------------------------------------------------------------------
// Value normalisation
// ---------------------------------------------------------------------------

/** Returns the first argument that is not null, undefined, an empty string or an empty array. */
function coalesce(...values) {
    for (const value of values) {
        if (value === null || value === undefined) continue;
        if (typeof value === 'string' && !value.trim()) continue;
        if (Array.isArray(value) && value.length === 0) continue;
        return typeof value === 'string' ? value.trim() : value;
    }
    return null;
}

function toNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const num = Number.parseFloat(String(value).replace(',', '.'));
    return Number.isFinite(num) ? num : null;
}

/** Indeed uses 0 for "no rating". */
function toRating(value) {
    const num = toNumber(value);
    return num && num > 0 && num <= 5 ? num : null;
}

function htmlToText(html) {
    if (typeof html !== 'string' || !html.trim()) return null;
    return html
        .replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, '\n')
        .replace(/<li[^>]*>/gi, '• ')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n\s*\n+/g, '\n\n')
        .trim() || null;
}

/** Makes relative URLs absolute; returns null for anything that isn't http(s). */
function absoluteUrl(href) {
    if (typeof href !== 'string' || !href.trim()) return null;
    try {
        const url = new URL(href, origin);
        return /^https?:$/.test(url.protocol) ? url.toString() : null;
    } catch {
        return null;
    }
}

/** Converts timestamps or relative text ("3 days ago", "Just posted") to an ISO date. */
function toIsoDate(value) {
    if (value === null || value === undefined || value === '') return null;

    if (typeof value === 'number' || /^\d{10,13}$/.test(String(value))) {
        const ms = Number(value) < 1e12 ? Number(value) * 1000 : Number(value);
        const date = new Date(ms);
        return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
    }

    const text = String(value).toLowerCase();
    const now = new Date();
    if (/just posted|today|hoje|aujourd|heute/.test(text)) return now.toISOString().slice(0, 10);

    const relative = text.match(/(\d+)\+?\s*(minute|hour|day|week|month)s?/);
    if (relative) {
        const amount = Number(relative[1]);
        const msPer = { minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6 }[relative[2]];
        return new Date(now.getTime() - amount * msPer).toISOString().slice(0, 10);
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function formatJsonLdSalary(baseSalary) {
    const value = baseSalary?.value;
    if (!value) return null;
    const currency = baseSalary.currency ?? '';
    const unit = value.unitText ? ` per ${String(value.unitText).toLowerCase()}` : '';
    if (value.minValue && value.maxValue) return `${currency} ${value.minValue} - ${value.maxValue}${unit}`.trim();
    const single = value.value ?? value.minValue ?? value.maxValue;
    return single ? `${currency} ${single}${unit}`.trim() : null;
}

function joinJobTypes(value) {
    if (Array.isArray(value)) return coalesce(value.filter(Boolean).map(String).join(', '));
    return coalesce(value);
}

/** Normalises one search results JSON entry into card fields. */
function cardFromJson(result) {
    return {
        jobId: coalesce(result.jobkey, result.jobKey),
        title: coalesce(result.displayTitle, result.title, result.normTitle),
        company: coalesce(result.company, result.truncatedCompany),
        location: coalesce(result.formattedLocation, result.jobLocationCity),
        salary: coalesce(
            result.salarySnippet?.text,
            result.estimatedSalary?.formattedRange,
            result.extractedSalary ? `${result.extractedSalary.min ?? ''} - ${result.extractedSalary.max ?? ''} ${result.extractedSalary.type ?? ''}`.trim() : null,
        ),
        jobType: joinJobTypes(result.jobTypes),
        datePosted: toIsoDate(coalesce(result.pubDate, result.createDate)),
        datePostedText: coalesce(result.formattedRelativeTime),
        companyRating: toRating(result.companyRating),
        companyReviewCount: toNumber(result.companyReviewCount) || null,
        isRemote: typeof result.remoteLocation === 'boolean' ? result.remoteLocation : null,
        applyUrl: absoluteUrl(coalesce(result.thirdPartyApplyUrl)),
        snippet: htmlToText(result.snippet),
    };
}

// ---------------------------------------------------------------------------
// Anti-bot handling
// ---------------------------------------------------------------------------

const BLOCK_TITLE = /just a moment|attention required|security check|access denied|captcha|verify you are human/i;

/** Detects Cloudflare / hCaptcha interstitials. Waits briefly for JS challenges to clear. */
async function assertNotBlocked(page, session) {
    const looksBlocked = async () => {
        const title = await page.title().catch(() => '');
        if (BLOCK_TITLE.test(title)) return true;
        return Boolean(await page.$('#challenge-form, iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"]').catch(() => null));
    };

    if (!(await looksBlocked())) return;

    // Cloudflare's JS challenge may resolve on its own within a few seconds.
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await sleep(3000);
    if (!(await looksBlocked())) return;

    session?.retire();
    throw new Error(`Blocked by anti-bot protection on ${page.url()}, retrying with a new session.`);
}

// ---------------------------------------------------------------------------
// Crawler
// ---------------------------------------------------------------------------

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency,
    maxRequestRetries: 6,
    requestHandlerTimeoutSecs: 120,
    navigationTimeoutSecs: 60,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
        maxPoolSize: 30,
        // Challenge pages answer 403 before resolving; assertNotBlocked decides instead.
        blockedStatusCodes: [],
    },
    // Headless by default. If Indeed blocks headless Chromium, set the environment
    // variable CRAWLEE_HEADLESS=0 on the actor: the Dockerfile starts XVFB, so a
    // headful browser works on the Apify platform without code changes.
    launchContext: {
        launchOptions: {
            args: ['--disable-blink-features=AutomationControlled'],
        },
    },

    preNavigationHooks: [
        async (_ctx, gotoOptions) => {
            // Random 1-2 s delay between requests to look less like a bot.
            await sleep(1000 + Math.floor(Math.random() * 1000));
            gotoOptions.waitUntil = 'domcontentloaded';
        },
    ],

    async requestHandler(context) {
        await assertNotBlocked(context.page, context.session);
        if (context.request.label === LABELS.DETAIL) return handleDetail(context);
        return handleList(context);
    },

    async failedRequestHandler({ request }, error) {
        log.error(`Request failed after ${request.retryCount + 1} attempts: ${request.url} (${error.message})`);

        // A failed detail page still yields a job with the listing card data.
        if (request.label === LABELS.DETAIL && request.userData.card) {
            await saveJob(buildJob(request.userData.card, {}, request.userData), `detail page failed: ${error.message}`);
        }
    },
});

/** Search results page: extract cards, enqueue details, enqueue the next page. */
async function handleList({ request, page, addRequests }) {
    const { start = 0 } = request.userData;
    state.listPages += 1;

    // Wait for any card container, the "no results" message, or give up after a while.
    const readySelector = [
        ...CARD_SELECTORS,
        '.jobsearch-NoResult-messageContainer',
        '[data-testid="no-results"]',
        '.no_results',
    ].join(', ');
    await page.waitForSelector(readySelector, { timeout: 20_000 }).catch(() => {});

    const html = await page.content();

    // Layer 1: embedded search results JSON.
    const jsonCards = (await extractListingJson(page, html)).map(cardFromJson);

    // Layer 2: CSS selectors on the rendered cards.
    let domCards = [];
    try {
        domCards = await page.evaluate(browserExtract, { mode: 'cards', cardSelectors: CARD_SELECTORS, fields: CARD_FIELDS });
    } catch (err) {
        log.warning(`Card DOM extraction failed on ${request.url}: ${err.message}`);
    }

    // Merge both layers by job ID, keeping page order: JSON values first, DOM fills the gaps.
    const merged = new Map();
    for (const card of [...jsonCards, ...domCards]) {
        if (!card.jobId) continue;
        const existing = merged.get(card.jobId);
        if (!existing) {
            merged.set(card.jobId, { ...card });
            continue;
        }
        for (const [key, value] of Object.entries(card)) {
            existing[key] = coalesce(existing[key], value);
        }
    }
    const cards = [...merged.values()];

    if (cards.length === 0) {
        const noResults = await isNoResultsPage(page);
        if (noResults || start > 0) {
            log.info(start === 0
                ? `No jobs found for "${keywords}"${location ? ` in "${location}"` : ''}.`
                : `No more jobs after offset ${start}.`);
            return;
        }
        // First page with neither cards nor a "no results" message: likely a soft block.
        throw new Error(`No job cards and no "no results" message on ${request.url}, retrying.`);
    }

    // Enqueue detail pages for new jobs, up to maxResults.
    const detailRequests = [];
    for (const card of cards) {
        if (state.enqueuedCount >= maxResults) break;
        if (state.enqueuedJobIds[card.jobId]) continue;
        state.enqueuedJobIds[card.jobId] = true;
        state.enqueuedCount += 1;
        detailRequests.push({
            url: buildJobUrl(card.jobId),
            label: LABELS.DETAIL,
            uniqueKey: `detail:${card.jobId}`,
            userData: { card, searchUrl: request.url },
        });
    }
    if (detailRequests.length) await addRequests(detailRequests);

    log.info(`Offset ${start}: ${cards.length} cards, ${detailRequests.length} new jobs queued (${state.enqueuedCount}/${maxResults}).`);

    // ---- Pagination -------------------------------------------------------
    if (state.enqueuedCount >= maxResults) return;
    if (detailRequests.length === 0) {
        log.info('Page contained no new jobs, Indeed is repeating results. Stopping pagination.');
        return;
    }
    if (state.listPages >= MAX_LIST_PAGES) {
        log.info(`Reached the ${MAX_LIST_PAGES}-page safety limit.`);
        return;
    }

    // Prefer the real "next" link; compute the next offset only if the link isn't found.
    const nextHref = await findNextPageHref(page);
    const nextStart = nextHref
        ? Number(new URL(nextHref, origin).searchParams.get('start') ?? start + PAGE_OFFSET_STEP)
        : start + PAGE_OFFSET_STEP;
    if (!nextHref) log.debug('Next page link not found, falling back to computed offset.');

    if (!Number.isFinite(nextStart) || nextStart <= start) return;
    await addRequests([{
        url: nextHref ? absoluteUrl(nextHref) : buildSearchUrl(nextStart),
        label: LABELS.LIST,
        uniqueKey: `list:${nextStart}`,
        userData: { start: nextStart },
    }]);
}

async function findNextPageHref(page) {
    const selectors = [
        'a[data-testid="pagination-page-next"]',
        'nav[role="navigation"] a[aria-label="Next Page"]',
        'a[aria-label="Next"]',
        'a[aria-label*="next" i]',
    ];
    for (const selector of selectors) {
        try {
            const href = await page.$eval(selector, (a) => a.getAttribute('href'));
            if (href) return href;
        } catch {
            // Try the next selector.
        }
    }
    return null;
}

async function isNoResultsPage(page) {
    const selectors = ['.jobsearch-NoResult-messageContainer', '[data-testid="no-results"]', '.no_results'];
    for (const selector of selectors) {
        try {
            if (await page.$(selector)) return true;
        } catch {
            // Try the next selector.
        }
    }
    try {
        const text = await page.evaluate(() => document.body?.innerText ?? '');
        return /did not match any jobs|no jobs found|no results found|não encontramos vagas/i.test(text);
    } catch {
        return false;
    }
}

/** Job detail page: extract every field with JSON + selector layers and save. */
async function handleDetail({ request, page }) {
    const { card } = request.userData;
    if (state.savedCount >= maxResults) return;

    await page
        .waitForSelector('#jobDescriptionText, [data-testid="jobsearch-JobComponent-description"], .jobsearch-jobDescriptionText, h1', { timeout: 20_000 })
        .catch(() => {});

    const html = await page.content();
    const { initialData, jobPosting } = await extractDetailJson(page, html);

    let dom = {};
    try {
        dom = await page.evaluate(browserExtract, { mode: 'page', fields: DETAIL_FIELDS });
    } catch (err) {
        log.warning(`Detail DOM extraction failed on ${request.url}: ${err.message}`);
    }

    // Layer 1: `_initialData` looked up by key name, then JSON-LD JobPosting.
    // Scope the search to the main job model when present, so "similar jobs"
    // modules elsewhere in the page data can't leak in.
    const jobModel = deepFind(initialData, ['jobInfoWrapperModel', 'jobInfoModel'], (v) => typeof v === 'object') ?? initialData;
    const reviewModel = deepFind(jobModel, ['companyReviewModel', 'ratingsModel'], (v) => typeof v === 'object');
    const jsonLdLocation = [].concat(jobPosting?.jobLocation ?? [])[0]?.address;

    const fromJson = {
        title: coalesce(deepFindString(jobModel, ['jobTitle']), jobPosting?.title),
        company: coalesce(deepFindString(jobModel, ['companyName']), jobPosting?.hiringOrganization?.name),
        location: coalesce(
            deepFindString(jobModel, ['formattedLocation', 'jobLocationText']),
            [jsonLdLocation?.addressLocality, jsonLdLocation?.addressRegion].filter(Boolean).join(', '),
        ),
        salary: coalesce(
            deepFindString(initialData, ['salaryText', 'formattedSalary']),
            formatJsonLdSalary(jobPosting?.baseSalary),
        ),
        jobType: coalesce(
            joinJobTypes(deepFind(initialData, ['jobTypes', 'jobType'], (v) => typeof v === 'string' || Array.isArray(v))),
            joinJobTypes(jobPosting?.employmentType),
        ),
        description: coalesce(
            htmlToText(stringOrContent(deepFind(jobModel, ['sanitizedJobDescription']))),
            htmlToText(jobPosting?.description),
        ),
        applyUrl: absoluteUrl(deepFindString(initialData, ['thirdPartyApplyUrl', 'applyUrl', 'indeedApplyUrl'])),
        datePosted: toIsoDate(coalesce(jobPosting?.datePosted)),
        companyRating: toRating(deepFindString(reviewModel, ['rating', 'companyRating'])),
    };

    // Layer 2: CSS selectors.
    const fromDom = {
        ...dom,
        applyUrl: absoluteUrl(dom.applyUrl),
        companyRating: toRating(dom.companyRating),
        datePosted: toIsoDate(dom.datePostedText),
    };

    await saveJob(buildJob(card, { fromJson, fromDom }, request.userData));
}

/** `sanitizedJobDescription` has been both a string and `{ content: string }`. */
function stringOrContent(value) {
    if (typeof value === 'string') return value;
    return value?.content ?? value?.html ?? null;
}

/** Merges card and detail data into the output item. Detail data wins over card data. */
function buildJob(card, { fromJson = {}, fromDom = {} }, userData) {
    const jobId = card.jobId;
    const pick = (field) => coalesce(fromJson[field], fromDom[field], card[field]);
    const jobUrl = buildJobUrl(jobId);

    return {
        jobId,
        title: pick('title'),
        company: pick('company'),
        companyRating: coalesce(fromJson.companyRating, fromDom.companyRating, card.companyRating),
        companyReviewCount: card.companyReviewCount ?? null,
        location: pick('location'),
        isRemote: card.isRemote ?? null,
        salary: pick('salary'),
        jobType: pick('jobType'),
        datePosted: coalesce(card.datePosted, fromJson.datePosted, fromDom.datePosted, toIsoDate(card.datePostedText)),
        datePostedText: coalesce(card.datePostedText, fromDom.datePostedText),
        description: coalesce(fromJson.description, fromDom.description, card.snippet),
        descriptionIsSnippet: !coalesce(fromJson.description, fromDom.description) && Boolean(card.snippet),
        // Indeed Apply jobs have no external link; the job page is where users apply.
        applyUrl: coalesce(fromJson.applyUrl, fromDom.applyUrl, card.applyUrl, jobUrl),
        jobUrl,

        searchKeywords: String(keywords).trim(),
        searchLocation: String(location ?? '').trim() || null,
        country: countryCode,
        searchUrl: userData?.searchUrl ?? null,
        scrapedAt: new Date().toISOString(),
    };
}

async function saveJob(job, warning = null) {
    if (state.savedCount >= maxResults) return;
    state.savedCount += 1;
    await Actor.pushData(warning ? { ...job, '#warning': warning } : job);
    log.info(`Saved ${state.savedCount}/${maxResults}: ${job.title ?? job.jobId} @ ${job.company ?? 'unknown company'}`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const startUrl = buildSearchUrl(0);
log.info(`Searching ${startUrl} (max ${maxResults} results)`);

await crawler.run([{ url: startUrl, label: LABELS.LIST, uniqueKey: 'list:0', userData: { start: 0 } }]);

log.info(`Done. Saved ${state.savedCount} jobs from ${state.listPages} search pages.`);
if (state.savedCount === 0) log.warning('No jobs were saved. Check the search filters or the run log for blocks.');

await Actor.exit();
