// api/jobs.js — Vercel Serverless Function
// Live Infor LN / Baan jobs from JSearch (RapidAPI, Google for Jobs data).
//
// Env vars (Vercel → Settings → Environment Variables):
//   RAPIDAPI_KEY  — JSearch key (free plan: 200 requests/month)
//   CRON_SECRET   — random string (16+ chars). Vercel sends it as
//                   "Authorization: Bearer <CRON_SECRET>" on cron calls; only
//                   requests carrying it are treated as the daily cron.
//   BLOB_STORE_ID (or BLOB_READ_WRITE_TOKEN) — added automatically when a Vercel
//                   Blob store is connected (Storage → Blob). Holds ONE shared,
//                   rolling pool of jobs so JSearch is called about once a day.
//
// Quota maths: each refresh runs 3 search tasks; a multi-page JSearch search is
// charged as 2 requests → ~6 requests per refresh → ~180/month on a daily cron.
// The tasks rotate across countries (US, India, UK, NL, DE, UAE) and the results
// are merged into a rolling 30-day pool, so every market is covered without
// spending more quota.

import { timingSafeEqual } from 'node:crypto';

export const config = { maxDuration: 60 };

const REFRESH_AFTER_MS = 26 * 60 * 60 * 1000;   // visitors trigger a refresh only if the daily cron was missed
const CRON_MIN_AGE_MS  =  6 * 60 * 60 * 1000;   // the authenticated cron refreshes anything older than 6h
const LOCK_MS          =  3 * 60 * 1000;        // another refresh in progress → serve stored copy
const POOL_DAYS        = 30;                    // keep jobs posted (or first seen) within this many days
const MAX_JOBS         = 150;
const BLOB_PATH        = 'fob-jobs/latest.json';

// CDN cache headers
const CDN_WITH_BLOB = 'public, max-age=0, s-maxage=1800, stale-while-revalidate=86400';
const CDN_NO_BLOB   = 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800';
const CDN_SHORT     = 'public, max-age=0, s-maxage=300';

// Only FullOnBaan sites may call this API from a browser
const ALLOWED_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*fullonbaan\.com$/i;

// Per-instance memory
let _mem      = null;
let _inflight = null;
let _quota    = null;

// ── Search plan (rotates; PER_REFRESH tasks per refresh) ─────────────────────
const TASKS = [
  { query: 'Infor LN',             country: 'us', pages: 5 },
  { query: 'Infor LN',             country: 'in', pages: 5 },
  { query: 'Infor LN',             country: 'gb', pages: 3 },
  { query: 'Baan ERP',             country: 'us', pages: 3 },
  { query: 'Infor LN',             country: 'nl', pages: 3 },
  { query: 'Infor LN',             country: 'de', pages: 3 },
  { query: 'Infor ERP consultant', country: 'us', pages: 3 },
  { query: 'Baan',                 country: 'in', pages: 3 },
  { query: 'Infor LN',             country: 'ae', pages: 2 },
];
const PER_REFRESH = 3;

// ── Helpers ──────────────────────────────────────────────────────────────────
const COUNTRY_NAMES = {
  US: 'USA', IN: 'India', GB: 'UK', NL: 'Netherlands', DE: 'Germany', AE: 'UAE',
  BE: 'Belgium', FR: 'France', IE: 'Ireland', SE: 'Sweden', NO: 'Norway', DK: 'Denmark',
  FI: 'Finland', CH: 'Switzerland', PL: 'Poland', ES: 'Spain', IT: 'Italy', AT: 'Austria',
  CZ: 'Czechia', HU: 'Hungary', PT: 'Portugal', SA: 'Saudi Arabia', QA: 'Qatar',
  KW: 'Kuwait', BH: 'Bahrain', OM: 'Oman', AU: 'Australia', NZ: 'New Zealand',
  CA: 'Canada', MX: 'Mexico', BR: 'Brazil', SG: 'Singapore', MY: 'Malaysia',
  PH: 'Philippines', CN: 'China', JP: 'Japan', ZA: 'South Africa',
};

function safeUrl(u) {
  return typeof u === 'string' && /^https?:\/\/[^\s"'<>]+$/i.test(u.trim()) ? u.trim() : '';
}

function inferType(title) {
  if (/techno[\s-]?functional/i.test(title)) return 'techno-functional';
  return /developer|technical|architect|integrat|engineer|program|iot|infor os|\bion\b/i.test(title)
    ? 'technical' : 'functional';
}

function inferModule(title) {
  const t = title.toLowerCase();
  if (/financ|account|\bgl\b|\bap\b|\bar\b|ledger|cost/.test(t))                     return 'finance';
  if (/manufactur|production|shop.?floor|mrp|mps|planning|scheduling/.test(t))       return 'manufacturing';
  if (/supply.?chain|\bscm\b|warehouse|inventory|procure|purchas|logistic/.test(t))  return 'supplychain';
  if (/project/.test(t))                                                             return 'projects';
  if (/integrat|\bion\b|\bedi\b|infor os/.test(t))                                   return 'integration';
  if (/architect/.test(t))                                                           return 'architecture';
  if (/data|migration/.test(t))                                                      return 'data';
  if (/automotive/.test(t))                                                          return 'automotive';
  return 'general';
}

// Which Infor product the job is about (title first, then description)
function productOf(s) {
  if (/\bbaan\b|infor\s*(erp\s*)?ln\b|\bln\b|cloudsuite\s*industrial\s*enterprise|\bcsie\b/i.test(s)) return 'Infor LN / Baan';
  if (/\bm3\b|movex/i.test(s))                                                    return 'Infor M3';
  if (/syteline|\bcsi\b|cloudsuite\s*industrial(?!\s*enterprise)/i.test(s))       return 'Infor CSI / SyteLine';
  if (/infor\s*visual|\bvisual\s*erp/i.test(s))                                   return 'Infor Visual';
  if (/infor\s*os\b|\bion\b|birst|mongoose|infor\s*d\/?pm/i.test(s))              return 'Infor OS / ION';
  if (/infor\s*(xa|xm|lawson|eam|sx\.?e|hms|system\s*21)|\blawson\b/i.test(s))    return 'Other Infor';
  return '';
}
function inferProduct(title, desc) {
  return productOf(title) || productOf((desc || '').slice(0, 2000)) || 'Other Infor';
}

// Is this really an Infor/Baan job?
function isRelevant(title, desc) {
  const d = (desc || '').slice(0, 3000);
  if (/\binfor\b|\bbaan\b|syteline|cloudsuite/i.test(title)) return true;
  if (/\bln\b|\bm3\b|\bcsi\b/i.test(title) && /\binfor\b|\berp\b/i.test(title + ' ' + d)) return true;
  // Generic titles only if the description is clearly about Infor LN / Baan
  return /infor\s*(erp\s*)?ln\b|\bbaan\b|cloudsuite\s*industrial\s*enterprise/i.test(d);
}

function inferWorkMode(j, title, desc) {
  const head = (desc || '').slice(0, 500);
  if (j.job_is_remote || /\bremote\b/i.test(title)) return 'remote';
  if (/\bhybrid\b/i.test(title + ' ' + head)) return 'hybrid';
  if (/\bremote\b/i.test(head) && !/\b(not|no|non)[\s-]remote\b/i.test(head)) return 'remote';
  return 'onsite';
}

function inferEmployment(j, title) {
  const types = [].concat(j.job_employment_types || [], j.job_employment_type || []).map(String);
  if (types.some(t => /CONTRACT/i.test(t)) || /\b(contract|c2c|corp[\s-]to[\s-]corp|1099|w2)\b/i.test(title)) return 'contract';
  if (types.some(t => /FULL/i.test(t)))   return 'fulltime';
  if (types.some(t => /PART/i.test(t)))   return 'parttime';
  if (types.some(t => /INTERN/i.test(t))) return 'internship';
  return '';
}

function formatDate(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function formatSalary(j) {
  if (!(j.job_min_salary && j.job_max_salary)) return '';
  const c = j.job_salary_currency;
  const sym = c === 'USD' ? '$' : c === 'INR' ? '₹' : c === 'GBP' ? '£' : c === 'EUR' ? '€' : (c ? c + ' ' : '');
  const period = j.job_salary_period === 'HOUR' ? '/hr' : j.job_salary_period === 'YEAR' ? '/yr' : j.job_salary_period === 'MONTH' ? '/mo' : '';
  return `${sym}${Math.round(j.job_min_salary)}–${sym}${Math.round(j.job_max_salary)}${period}`;
}

function cleanDescription(raw) {
  return String(raw || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^(job\s*description|about\s*the\s*(job|role)|overview|description|summary)\s*[:\-–]?\s*/i, '');
}

// Aggregators that often repost, gate behind sign-up or go stale
const LOW_QUALITY = /jobleads|bebee|trabajo|jobrapido|onlinekunstskolen|learn4good|cazvid|talent\.com|jooble|jobilize|whatjobs|adzuna|simplyhired|energy jobline/i;
const GOOD_BOARDS = /linkedin|indeed|dice|glassdoor|naukri|monster|ziprecruiter|careers|workday|greenhouse|lever|ashby|smartrecruiters|icims/i;

function pickApply(j) {
  const opts = [];
  if (safeUrl(j.job_apply_link)) opts.push({ url: j.job_apply_link, publisher: j.job_publisher || '', direct: !!j.job_apply_is_direct });
  (Array.isArray(j.apply_options) ? j.apply_options : []).forEach(o => {
    if (safeUrl(o.apply_link)) opts.push({ url: o.apply_link, publisher: o.publisher || '', direct: !!o.is_direct });
  });
  const score = o => (o.direct ? 3 : LOW_QUALITY.test(o.publisher) ? 0 : GOOD_BOARDS.test(o.publisher) ? 2 : 1);
  opts.sort((a, b) => score(b) - score(a));
  if (opts[0]) return { url: opts[0].url.trim(), source: opts[0].publisher || 'Job board', direct: opts[0].direct };
  const g = safeUrl(j.job_google_link);
  return g ? { url: g, source: 'Google Jobs', direct: false } : null;
}

function mapJSearchJob(j) {
  const title   = (j.job_title || '').trim();
  const descRaw = cleanDescription(j.job_description);
  const country = String(j.job_country || '').toUpperCase();
  const cName   = COUNTRY_NAMES[country] || country;
  const work    = inferWorkMode(j, title, descRaw);
  const place   = [j.job_city, j.job_state].filter(Boolean);
  if (cName) place.push(cName);
  const location = place.length ? place.join(', ') : (work === 'remote' ? 'Remote' : 'Not specified');
  const apply   = pickApply(j);
  const months  = j.job_required_experience && j.job_required_experience.required_experience_in_months;
  const desc    = descRaw.slice(0, 220);

  return {
    id:             j.job_id || '',
    type:           inferType(title),
    title,
    description:    desc + (descRaw.length > 220 ? '…' : ''),
    company:        (j.employer_name || '').trim(),
    location,
    country:        cName,
    workMode:       work,
    employment:     inferEmployment(j, title),
    salary:         formatSalary(j),
    experience:     months ? `${Math.round(months / 12)}+ yrs` : '',
    product:        inferProduct(title, descRaw),
    module:         inferModule(title),
    posted:         formatDate(j.job_posted_at_datetime_utc),
    postedIso:      j.job_posted_at_datetime_utc || '',
    displayDate:    formatDate(j.job_posted_at_datetime_utc),
    source:         apply ? apply.source : (j.job_publisher || ''),
    direct:         apply ? apply.direct : false,
    applyUrl:       apply ? apply.url : '',
    recruiterEmail: '',
    firstSeen:      new Date().toISOString(),
  };
}

// Jobs stored by an older version of this function: fill in new fields
function upgradeStored(j) {
  const out = { ...j };
  if (!out.product) out.product = inferProduct(out.title || '', out.description || '');
  if (out.module === 'integration' && !/integrat|\bion\b|\bedi\b|infor os/i.test(out.title || '')) out.module = inferModule(out.title || '');
  if (!out.country && out.region === 'usa' && !/\b(usa|us|united states)\b/i.test(out.location || '') && out.location !== 'Remote') {
    out.location = `${out.location}, USA`; out.country = 'USA';
  }
  if (!out.firstSeen) out.firstSeen = out.postedIso || new Date().toISOString();
  if (!safeUrl(out.applyUrl)) out.applyUrl = '';
  return out;
}

// ── Deduplication ────────────────────────────────────────────────────────────
const COMPANY_SUFFIX = /\b(inc|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|pvt|private|plc|gmbh|bv|b\.v|ag|sa|lp|llp|group|technologies|technology|tech|solutions|consulting|services|global|international|america|north america|usa)\b/g;
const normCompany = c => String(c || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9 ]+/g, ' ')
  .replace(COMPANY_SUFFIX, ' ').replace(/\s+/g, '');
const normTitle = t => String(t || '').toLowerCase()
  .replace(/\(.*?\)/g, ' ')
  .replace(/\b(remote|hybrid|on[\s-]?site|w2( only)?|c2c|contract|full[\s-]?time|part[\s-]?time|urgent|hiring|immediate)\b/g, ' ')
  .replace(/\s+in\s+[a-z .,]+$/g, ' ')
  .replace(/[^a-z0-9]+/g, '');
const normDesc = d => String(d || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 100);

function dedupe(jobs) {
  // Prefer direct employer links, then newer posts
  const ranked = jobs.slice().sort((a, b) =>
    (Number(b.direct) - Number(a.direct)) || ((Date.parse(b.postedIso) || 0) - (Date.parse(a.postedIso) || 0)));
  const seen = new Set();
  const out = [];
  for (const j of ranked) {
    const keys = [normTitle(j.title) + '|' + normCompany(j.company)];
    if (j.id) keys.push('id:' + j.id);
    const dk = normDesc(j.description);
    if (dk.length >= 60) keys.push(normTitle(j.title) + '|d:' + dk);
    if (keys.some(k => seen.has(k))) continue;
    keys.forEach(k => seen.add(k));
    out.push(j);
  }
  return out;
}

const jobAgeMs = j => Date.now() - (Date.parse(j.postedIso) || Date.parse(j.firstSeen) || Date.now());

// ── JSearch ──────────────────────────────────────────────────────────────────
async function fetchFromJSearch(apiKey, tasks) {
  const started = Date.now();

  async function runQuery({ query, country, pages }, attempt = 1) {
    const url = new URL('https://jsearch.p.rapidapi.com/search');
    url.searchParams.set('query',       query);
    url.searchParams.set('country',     country);
    url.searchParams.set('page',        '1');
    url.searchParams.set('num_pages',   String(pages));
    url.searchParams.set('date_posted', 'month');
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    try {
      console.log(`[FOB] JSearch "${query}" [${country}] x${pages} pages (attempt ${attempt})`);
      const res = await fetch(url.toString(), {
        headers: { 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com', 'X-RapidAPI-Key': apiKey },
        signal: ctrl.signal
      });
      const lim = res.headers.get('x-ratelimit-requests-limit');
      const rem = res.headers.get('x-ratelimit-requests-remaining');
      if (lim || rem) _quota = { limit: lim, remaining: rem, at: new Date().toISOString() };
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json();
      console.log(`[FOB] JSearch "${query}" [${country}] → ${(data.data || []).length} raw (quota left: ${rem})`);
      return data.data || [];
    } catch (e) {
      console.error(`[FOB] JSearch "${query}" [${country}] attempt ${attempt} failed: ${e.name === 'AbortError' ? 'timeout' : e.message}`);
      // Retry only quick network failures; a timed-out search was probably already charged
      if (attempt < 2 && e.name !== 'AbortError' && Date.now() - started < 10000 && !/HTTP 4(01|03|29)/.test(e.message)) {
        return runQuery({ query, country, pages: Math.min(pages, 2) }, attempt + 1);
      }
      throw e;
    } finally { clearTimeout(timer); }
  }

  const results = await Promise.allSettled(tasks.map(t => runQuery(t)));
  let raw = [];
  results.forEach(r => { if (r.status === 'fulfilled') raw = raw.concat(r.value); });
  if (raw.length === 0) {
    throw new Error('All JSearch queries failed: ' + results.map(r => r.reason && r.reason.message).join(' | '));
  }

  const jobs = raw
    .filter(j => j.job_title && j.employer_name && isRelevant(j.job_title, j.job_description))
    .map(mapJSearchJob)
    .filter(j => j.applyUrl);
  console.log(`[FOB] JSearch → ${jobs.length} relevant of ${raw.length} raw in ${Date.now() - started}ms`);
  return jobs;
}

// ── Shared storage (Vercel Blob) ─────────────────────────────────────────────
function blobToken() { return process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN || ''; }

function blobPublicUrl() {
  const sid = process.env.BLOB_STORE_ID;
  const storeId = sid ? sid.replace(/^store_/, '') : (process.env.BLOB_READ_WRITE_TOKEN || '').split('_')[3];
  return storeId ? `https://${storeId.toLowerCase()}.public.blob.vercel-storage.com/${BLOB_PATH}` : '';
}

let _blobUrl = '';

async function readStored() {
  if (!blobToken()) return null;
  try {
    const res = await fetch((_blobUrl || blobPublicUrl()) + '?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) { console.log(`[FOB] Blob read HTTP ${res.status}`); return null; }
    return await res.json();
  } catch (e) { console.error('[FOB] Blob read failed:', e.message); return null; }
}

async function writeStored(payload) {
  if (!blobToken()) return;
  try {
    const { put } = await import('@vercel/blob');
    const r = await put(BLOB_PATH, JSON.stringify(payload), {
      access: 'public', addRandomSuffix: false, allowOverwrite: true,
      contentType: 'application/json', cacheControlMaxAge: 60
    });
    _blobUrl = r.url;
  } catch (e) { console.error('[FOB] Blob write failed:', e.message); }
}

// ── Refresh: fetch this rotation's tasks and merge into the rolling pool ─────
async function refresh(apiKey, stored) {
  if (_inflight) return _inflight;
  _inflight = (async () => {
    if (stored) await writeStored({ ...stored, refreshStartedAt: new Date().toISOString() });
    const rot   = Number.isInteger(stored && stored.rotation) ? stored.rotation % TASKS.length : 0;
    const tasks = Array.from({ length: PER_REFRESH }, (_, i) => TASKS[(rot + i) % TASKS.length]);
    const fresh = await fetchFromJSearch(apiKey, tasks);

    // Keep firstSeen for jobs we already had
    const prevById = new Map(((stored && stored.jobs) || []).filter(j => j.id).map(j => [j.id, j]));
    fresh.forEach(j => { const p = prevById.get(j.id); if (p && p.firstSeen) j.firstSeen = p.firstSeen; });

    const old = ((stored && stored.jobs) || []).map(upgradeStored)
      .filter(j => j.applyUrl && isRelevant(j.title || '', j.description || ''));
    const pool = dedupe(fresh.concat(old))
      .filter(j => jobAgeMs(j) <= POOL_DAYS * 86400000)
      .sort((a, b) => (Date.parse(b.postedIso) || 0) - (Date.parse(a.postedIso) || 0))
      .slice(0, MAX_JOBS);
    if (pool.length === 0) throw new Error('No usable jobs after merge');

    const payload = { jobs: pool, fetchedAt: new Date().toISOString(), quota: _quota,
      rotation: (rot + PER_REFRESH) % TASKS.length, lastTasks: tasks.map(t => `${t.query} [${t.country}]`) };
    _mem = payload;
    await writeStored(payload);
    console.log(`[FOB] Pool: ${pool.length} jobs (${fresh.length} fetched now: ${payload.lastTasks.join(', ')})`);
    return payload;
  })();
  try { return await _inflight; } finally { _inflight = null; }
}

const ageMs = p => p && p.fetchedAt ? Date.now() - Date.parse(p.fetchedAt) : Infinity;

function isAuthorizedCron(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const got = Buffer.from(String(req.headers?.authorization || ''));
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

function publicBody(p, provider) {
  // Upgrade jobs stored by an older version (adds product, country, etc.) before serving
  const jobs = (p.jobs || []).map(upgradeStored).filter(j => j.applyUrl && isRelevant(j.title || '', j.description || ''));
  return { jobs, provider, real: true, fetchedAt: p.fetchedAt, count: jobs.length };
}

function send(res, status, cache, body) {
  res.setHeader('Cache-Control', cache);
  return res.status(status).json(body);
}

// ── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const origin = String(req.headers?.origin || '');
  if (ALLOWED_ORIGIN.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const KEY     = process.env.RAPIDAPI_KEY;
  const hasBlob = !!blobToken();
  const isCron  = isAuthorizedCron(req);

  const blob    = await readStored();
  const okCache = (hasBlob && blob) ? CDN_WITH_BLOB : CDN_NO_BLOB;
  const stored  = [blob, _mem].filter(Boolean).sort((a, b) => ageMs(a) - ageMs(b))[0] || null;

  const host   = String(req.headers?.host || '').toLowerCase();
  const fresh  = stored && ageMs(stored) < (isCron ? CRON_MIN_AGE_MS : REFRESH_AFTER_MS);
  const refreshing = stored && stored.refreshStartedAt && (Date.now() - Date.parse(stored.refreshStartedAt)) < LOCK_MS;

  if (stored && (fresh || refreshing || !KEY)) {
    return send(res, 200, isCron ? 'no-store' : okCache, publicBody(stored, hasBlob ? 'stored' : 'cache'));
  }
  if (!KEY) {
    console.error('[FOB] RAPIDAPI_KEY is not configured');
    return send(res, 503, 'no-store', { error: 'Live job feed unavailable' });
  }

  // Only the real site and the authenticated cron may spend JSearch quota.
  if (!isCron && host.endsWith('.vercel.app')) {
    if (stored) return send(res, 200, CDN_SHORT, publicBody(stored, 'stored'));
    return send(res, 503, 'no-store', { error: 'Preview URL: open jobs.fullonbaan.com for the live feed.' });
  }

  try {
    const p = await refresh(KEY, stored);
    return send(res, 200, isCron ? 'no-store' : (hasBlob && _blobUrl) ? CDN_WITH_BLOB : okCache, publicBody(p, 'jsearch'));
  } catch (e) {
    console.error('[FOB] Refresh failed:', e.message);
    if (stored) return send(res, 200, CDN_SHORT, publicBody(stored, 'stale'));
    return send(res, 503, 'no-store', { error: 'Live job feed unavailable' });
  }
}
