// api/jobs.js — Vercel Serverless Function
// Live Infor LN / Baan jobs from JSearch (RapidAPI, Google for Jobs data).
//
// Env vars (Vercel → Settings → Environment Variables):
//   RAPIDAPI_KEY           — JSearch key (free plan: 200 requests/month)
//   BLOB_READ_WRITE_TOKEN  — added automatically when a Vercel Blob store is
//                            connected to this project (Storage → Blob). Optional
//                            but strongly recommended: it stores ONE shared copy
//                            of the jobs, so JSearch is called once a day in total.
//
// Quota maths: one refresh ≈ 6 JSearch requests (3 multi-page queries).
// Daily refresh ≈ 180 requests/month, which fits the 200/month free plan.

export const config = { maxDuration: 60 };

const REFRESH_AFTER_MS = 20 * 60 * 60 * 1000;   // data older than 20h gets refreshed (daily cron always qualifies)
const LOCK_MS          = 3 * 60 * 1000;         // another refresh in progress → serve stored copy
const BLOB_PATH        = 'fob-jobs/latest.json';

// CDN cache headers
const CDN_WITH_BLOB    = 'public, max-age=0, s-maxage=1800, stale-while-revalidate=86400';  // cheap: reads the stored copy
const CDN_NO_BLOB      = 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800'; // 1 refresh/day per CDN region
const CDN_SHORT        = 'public, max-age=0, s-maxage=300';

// Per-instance memory
let _mem      = null;   // { jobs, fetchedAt, quota }
let _inflight = null;   // shared promise so concurrent requests trigger only one refresh

// ── JSearch → normalised job schema ──────────────────────────────────────────
function inferType(title) {
  return /developer|technical|architect|integrat|engineer|program|iot|infor os/i.test(title)
    ? 'technical' : 'functional';
}

function inferModule(title) {
  const t = title.toLowerCase();
  if (/financ|account|gl\b|ap\b|ar\b|ledger|cost/i.test(t))       return 'finance';
  if (/manufactur|production|shop.?floor|mrp/i.test(t))            return 'manufacturing';
  if (/supply.?chain|warehouse|inventory|procure|purchas|logistic/i.test(t)) return 'supplychain';
  if (/project/i.test(t))                                           return 'projects';
  if (/architect/i.test(t))                                         return 'architecture';
  if (/automotive/i.test(t))                                        return 'automotive';
  return 'integration';
}

function inferRegion(country) {
  const c = (country || '').toUpperCase();
  if (['US','USA','UNITED STATES'].includes(c))                     return 'usa';
  if (['IN','IND','INDIA'].includes(c))                             return 'india';
  if (['AE','SA','QA','KW','BH','OM','UAE'].includes(c))           return 'middleeast';
  if (['AU','NZ','AUSTRALIA'].includes(c))                          return 'australia';
  if (['GB','DE','FR','NL','BE','IE','SE','NO','DK','FI','CH','PL','ES','IT'].includes(c)) return 'europe';
  return 'global';
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric'
    });
  } catch (_) {
    return new Date().toLocaleDateString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric'
    });
  }
}

function formatSalary(j) {
  if (j.job_min_salary && j.job_max_salary) {
    const sym    = j.job_salary_currency === 'USD' ? '$'
                 : j.job_salary_currency === 'INR' ? '₹'
                 : j.job_salary_currency === 'AED' ? 'AED '
                 : (j.job_salary_currency || '$');
    const period = j.job_salary_period === 'HOUR' ? '/hr'
                 : j.job_salary_period === 'YEAR' ? '/yr' : '';
    return `${sym}${Math.round(j.job_min_salary)}–${sym}${Math.round(j.job_max_salary)}${period}`;
  }
  return '';
}

function mapJSearchJob(j) {
  const title    = j.job_title || '';
  const locParts = [j.job_city, j.job_state, j.job_country].filter(Boolean);
  const location = locParts.slice(0, 2).join(', ') || j.job_country || 'Remote';
  const empMap   = { FULLTIME: 'fulltime', CONTRACTOR: 'contract', PARTTIME: 'fulltime', INTERN: 'contract' };
  // Clean description to 120 chars, no newlines
  const desc = (j.job_description || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 120);

  return {
    type:           inferType(title),
    title,
    description:    desc + (desc.length >= 120 ? '…' : ''),
    company:        j.employer_name || '',
    location,
    workMode:       (j.job_is_remote || /\bremote\b/i.test(title + ' ' + (j.job_description || '').slice(0, 400))) ? 'remote' : 'onsite',
    employment:     empMap[j.job_employment_type] || 'contract',
    salary:         formatSalary(j),
    module:         inferModule(title),
    region:         inferRegion(j.job_country),
    posted:         formatDate(j.job_posted_at_datetime_utc),
    postedIso:      j.job_posted_at_datetime_utc || '',
    displayDate:    formatDate(j.job_posted_at_datetime_utc),
    source:         j.job_publisher || 'LinkedIn',
    applyUrl:       j.job_apply_link || j.job_google_link || '#',
    recruiterEmail: ''
  };
}

// Search plan: several pages per query so we get 50+ unique, recent listings.
const JSEARCH_QUERIES = [
  { query: 'Infor LN',             pages: 5 },
  { query: 'Baan ERP',             pages: 3 },
  { query: 'Infor ERP consultant', pages: 3 },
];
const MIN_JOBS = 50;
const MAX_JOBS = 100;
const RELEVANT = /infor|baan|\bln\b|cloudsuite/i;

let _quota = null;   // last seen RapidAPI quota headers

async function fetchFromJSearch(apiKey) {
  const started = Date.now();

  async function runQuery({ query, pages }, attempt = 1) {
    const url = new URL('https://jsearch.p.rapidapi.com/search');
    url.searchParams.set('query',       query);
    url.searchParams.set('page',        '1');
    url.searchParams.set('num_pages',   String(pages));
    url.searchParams.set('date_posted', 'month');
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 24000);
    try {
      console.log(`[FOB] JSearch querying: "${query}" x${pages} pages (attempt ${attempt})`);
      const res = await fetch(url.toString(), {
        headers: { 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com', 'X-RapidAPI-Key': apiKey },
        signal: ctrl.signal
      });
      const lim = res.headers.get('x-ratelimit-requests-limit');
      const rem = res.headers.get('x-ratelimit-requests-remaining');
      if (lim || rem) _quota = { limit: lim, remaining: rem, at: new Date().toISOString() };
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json();
      console.log(`[FOB] JSearch "${query}" → ${(data.data || []).length} raw (quota left: ${rem})`);
      return data.data || [];
    } catch (e) {
      console.error(`[FOB] JSearch "${query}" attempt ${attempt} failed: ${e.name === 'AbortError' ? 'timeout' : e.message}`);
      // Retry once, only if there is enough time left and it isn't an auth/quota error
      if (attempt < 2 && Date.now() - started < 25000 && !/HTTP 4(01|03|29)/.test(e.message)) {
        return runQuery({ query, pages: Math.min(pages, 2) }, attempt + 1);
      }
      throw e;
    } finally { clearTimeout(timer); }
  }

  const results = await Promise.allSettled(JSEARCH_QUERIES.map(q => runQuery(q)));
  let allRaw = [];
  results.forEach(r => { if (r.status === 'fulfilled') allRaw = allRaw.concat(r.value); });
  if (allRaw.length === 0) {
    throw new Error('All JSearch queries failed: ' + results.map(r => r.reason && r.reason.message).join(' | '));
  }

  // Deduplicate by job_id and by title+company; keep only Infor/Baan-relevant posts
  const seen = new Set();
  const unique = allRaw.filter(j => {
    if (!j.job_title || !j.employer_name || !j.job_apply_link) return false;
    if (!RELEVANT.test(j.job_title + ' ' + (j.job_description || '').slice(0, 1500))) return false;
    const key2 = (j.job_title.replace(/[\s\-–(]*\d+\)?\s*$/, '') + '|' + j.employer_name).toLowerCase().replace(/[^a-z0-9|]/g, '');
    if (seen.has(j.job_id) || seen.has(key2)) return false;
    seen.add(j.job_id); seen.add(key2);
    return true;
  });
  unique.sort((a, b) => (Date.parse(b.job_posted_at_datetime_utc) || 0) - (Date.parse(a.job_posted_at_datetime_utc) || 0));

  if (unique.length === 0) throw new Error('JSearch returned no usable jobs');
  const jobs = unique.map(mapJSearchJob).slice(0, MAX_JOBS);
  console.log(`[FOB] JSearch → ${jobs.length} real jobs (deduped from ${allRaw.length} raw; target ${MIN_JOBS}+) in ${Date.now() - started}ms`);
  return jobs;
}

// ── Shared storage (Vercel Blob) ─────────────────────────────────────────────
function blobToken() { return process.env.BLOB_READ_WRITE_TOKEN || ''; }

function blobPublicUrl() {
  // Token format: vercel_blob_rw_<storeId>_<secret>
  const parts = blobToken().split('_');
  const storeId = parts[3];
  return storeId ? `https://${storeId.toLowerCase()}.public.blob.vercel-storage.com/${BLOB_PATH}` : '';
}

let _blobUrl = '';   // exact URL returned by put(), preferred over the derived one

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
    console.log('[FOB] Blob written:', r.url, r.url === blobPublicUrl() ? '(matches derived URL)' : '(DIFFERS from derived ' + blobPublicUrl() + ')');
  } catch (e) { console.error('[FOB] Blob write failed:', e.message); }
}

// ── Refresh (one at a time per instance) ─────────────────────────────────────
async function refresh(apiKey, stored) {
  if (_inflight) return _inflight;
  _inflight = (async () => {
    // Mark a refresh as in progress so other instances keep serving the stored copy
    if (stored) await writeStored({ ...stored, refreshStartedAt: new Date().toISOString() });
    const jobs = await fetchFromJSearch(apiKey);
    const payload = { jobs, fetchedAt: new Date().toISOString(), quota: _quota };
    _mem = payload;
    await writeStored(payload);
    return payload;
  })();
  try { return await _inflight; } finally { _inflight = null; }
}

const ageMs = p => p && p.fetchedAt ? Date.now() - Date.parse(p.fetchedAt) : Infinity;

function send(res, status, cache, body) {
  res.setHeader('Cache-Control', cache);
  return res.status(status).json(body);
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const KEY     = process.env.RAPIDAPI_KEY;
  const hasBlob = !!blobToken();
  const okCache = hasBlob ? CDN_WITH_BLOB : CDN_NO_BLOB;

  // 1. Best available stored copy: shared Blob, else this instance's memory
  const blob   = await readStored();
  const stored = [blob, _mem].filter(Boolean).sort((a, b) => ageMs(a) - ageMs(b))[0] || null;

  const fresh      = stored && ageMs(stored) < REFRESH_AFTER_MS;
  const refreshing = stored && stored.refreshStartedAt && (Date.now() - Date.parse(stored.refreshStartedAt)) < LOCK_MS;

  if (stored && (fresh || refreshing || !KEY)) {
    return send(res, 200, okCache, { jobs: stored.jobs, provider: hasBlob ? 'stored' : 'cache', real: true,
      fetchedAt: stored.fetchedAt, quota: stored.quota || null });
  }
  if (!KEY) return send(res, 500, 'no-store', { error: 'RAPIDAPI_KEY is not configured.' });

  // 2. Stale or missing → refresh from JSearch (≈6 requests)
  try {
    const p = await refresh(KEY, stored);
    return send(res, 200, okCache, { jobs: p.jobs, provider: 'jsearch', real: true, fetchedAt: p.fetchedAt, quota: p.quota });
  } catch (e) {
    console.error('[FOB] Refresh failed:', e.message);
    if (stored) {
      return send(res, 200, CDN_SHORT, { jobs: stored.jobs, provider: 'stale', real: true,
        fetchedAt: stored.fetchedAt, quota: stored.quota || null });
    }
    return send(res, 503, 'no-store', { error: 'Live job feed unavailable', details: e.message });
  }
}
