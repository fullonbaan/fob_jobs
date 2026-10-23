// api/jobs.js — Vercel Serverless Function (Node.js 18+)
// Data chain: JSearch/RapidAPI (real jobs) → Groq (AI fallback) → Gemini (AI fallback)
// Env vars needed in Vercel → Settings → Environment Variables:
//   RAPIDAPI_KEY  — free at rapidapi.com  (subscribe to "JSearch" — free plan 500 req/month)
//   GROQ_API_KEY  — free at console.groq.com
//   GEMINI_API_KEY — free at aistudio.google.com

export const config = { maxDuration: 30 };

// ── Server-side cache — 6 hours for real data, 1 hour for AI fallback ────────
// The Vercel CDN also caches GET responses (see CDN_CACHE_* below), so every
// page open gets the latest feed while JSearch is called only a few times/day.
const CACHE_TTL_REAL = 6  * 60 * 60 * 1000;
const CDN_CACHE_REAL = 'public, max-age=0, s-maxage=21600, stale-while-revalidate=86400';
const CDN_CACHE_FALLBACK = 'public, max-age=0, s-maxage=600';
const CACHE_TTL_AI   = 1  * 60 * 60 * 1000;
let _cachedJobs = null;
let _cachedAt   = 0;
let _cachedReal = false;   // true = real JSearch data, false = AI-generated

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

async function fetchFromJSearch(apiKey) {
  // Two complementary queries for variety; each uses 1 API request
  const queries = ['Infor LN consultant', 'Infor Baan ERP'];

  // One query with a hard timeout + a single retry. JSearch occasionally hangs,
  // so never let one slow call eat the whole 30s function budget.
  async function runQuery(query, attempt = 1) {
    const url = new URL('https://jsearch.p.rapidapi.com/search');
    url.searchParams.set('query',       query);
    url.searchParams.set('num_pages',   '1');       // 10 results per page (keeps free quota safe)
    url.searchParams.set('date_posted', 'month');   // posted in last 30 days
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 11000);
    try {
      console.log(`[FOB] JSearch querying: "${query}" (attempt ${attempt})`);
      const res = await fetch(url.toString(), {
        headers: { 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com', 'X-RapidAPI-Key': apiKey },
        signal: ctrl.signal
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json();
      return data.data || [];
    } catch (e) {
      console.error(`[FOB] JSearch "${query}" attempt ${attempt} failed: ${e.name === 'AbortError' ? 'timeout' : e.message}`);
      if (attempt < 2 && !/HTTP 4(01|03|29)/.test(e.message)) return runQuery(query, attempt + 1);
      throw e;
    } finally { clearTimeout(timer); }
  }

  // Run both queries in parallel; use whatever comes back
  const results = await Promise.allSettled(queries.map(q => runQuery(q)));
  let allRaw = [];
  results.forEach(r => { if (r.status === 'fulfilled') allRaw = allRaw.concat(r.value); });
  if (allRaw.length === 0) {
    throw new Error('All JSearch queries failed: ' + results.map(r => r.reason && r.reason.message).join(' | '));
  }

  // Deduplicate by job_id and by title+company, require title + company + apply link
  const seen = new Set();
  const unique = allRaw.filter(j => {
    if (!j.job_title || !j.employer_name || !j.job_apply_link) return false;
    const key2 = (j.job_title + '|' + j.employer_name).toLowerCase().replace(/[^a-z0-9|]/g, '');
    if (seen.has(j.job_id) || seen.has(key2)) return false;
    seen.add(j.job_id); seen.add(key2);
    return true;
  });
  // Newest first
  unique.sort((a, b) => (Date.parse(b.job_posted_at_datetime_utc) || 0) - (Date.parse(a.job_posted_at_datetime_utc) || 0));

  if (unique.length === 0) throw new Error('JSearch returned no usable jobs');

  const jobs = unique.map(mapJSearchJob).slice(0, 40);
  console.log(`[FOB] JSearch → ${jobs.length} real jobs (deduped from ${allRaw.length} raw)`);
  return jobs;
}

// ── AI fallback helpers ───────────────────────────────────────────────────────
function buildPrompt() {
  const monthYear = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
  return `Generate JSON with 15 Infor LN/Baan ERP job openings as of ${monthYear}. Mix: 8 functional + 7 technical.
Regions: USA 60%, India 20%, ME 10%, EU 7%, AU 3%.
Companies: Deloitte, Accenture, NTT Data, HCL, Capgemini, Infosys, Wipro, TCS, DXC, Innova.
Salary: USA $45-$130/hr; India 8-25 LPA; ME AED 15k-35k/mo.
Each job has ONLY these keys: type,title,description,company,location,workMode,employment,salary,module,region,posted,displayDate
Values: type=functional|technical; workMode=remote|hybrid|onsite; employment=contract|fulltime|w2|c2c; module=finance|manufacturing|supplychain|integration|projects|architecture|automotive; region=usa|india|middleeast|europe|australia|global; posted=DD MMM YYYY within last 14 days; displayDate=same as posted; description=10 words max; location=city and country.
Return ONLY: {"jobs":[...]}`;
}

function buildApplyUrls(job, index) {
  const cleanTitle = (job.title || '').replace(/^(infor\s+ln|baan)\s*/i, '').trim();
  const q          = encodeURIComponent(`"Infor LN" ${cleanTitle}`);
  const loc        = encodeURIComponent(job.location || '');
  const isRemote   = job.workMode === 'remote';

  if (index % 2 === 0) {
    const remoteParam = isRemote ? '&f_WT=2' : '';
    const locParam    = (!isRemote && loc) ? `&location=${loc}` : '';
    return { applyUrl: `https://www.linkedin.com/jobs/search/?keywords=${q}${locParam}${remoteParam}`, source: 'LinkedIn' };
  } else {
    const locParam = isRemote ? 'Remote' : (job.location || '');
    return { applyUrl: `https://www.indeed.com/jobs?q=${q}&l=${encodeURIComponent(locParam)}`, source: 'Indeed' };
  }
}

function enrichAIJobs(jobs) {
  return jobs.map((job, i) => {
    const { applyUrl, source } = buildApplyUrls(job, i);
    return { ...job, applyUrl, source, recruiterEmail: '' };
  });
}

function parseJobs(text) {
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/g, '').trim();
  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON object found');
  try {
    const end = text.lastIndexOf('}');
    if (end > start) {
      const parsed = JSON.parse(text.slice(start, end + 1));
      const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
      if (jobs.length > 0) return jobs;
    }
  } catch (_) {}
  const arrStart = text.indexOf('[');
  if (arrStart !== -1) {
    const arrText  = text.slice(arrStart);
    const lastClose = arrText.lastIndexOf('},');
    if (lastClose !== -1) {
      try {
        const jobs = JSON.parse(arrText.slice(0, lastClose + 1) + ']');
        if (Array.isArray(jobs) && jobs.length > 0) return jobs;
      } catch (_) {}
    }
  }
  throw new Error('No valid jobs array in response');
}

async function fetchFromGroq(apiKey, prompt) {
  const models = [
    { id: 'llama-3.3-70b-versatile', maxTok: 5000 },
    { id: 'llama-3.1-8b-instant',    maxTok: 3000 },
    { id: 'llama-3.1-70b-versatile', maxTok: 5000 }
  ];
  const errors = [];
  for (const { id: model, maxTok } of models) {
    try {
      console.log(`[FOB] Groq trying: ${model}`);
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model, max_tokens: maxTok, temperature: 0.7,
          messages: [
            { role: 'system', content: 'Return only valid JSON with no markdown.' },
            { role: 'user',   content: prompt }
          ]
        })
      });
      if (!res.ok) {
        const msg = `Groq ${model} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
        console.error(`[FOB] ${msg}`); errors.push(msg); continue;
      }
      const data = await res.json();
      const jobs = enrichAIJobs(parseJobs((data.choices || []).map(c => c.message?.content || '').join('')));
      console.log(`[FOB] Groq ${model} → ${jobs.length} AI jobs`);
      return jobs;
    } catch (e) {
      const msg = `Groq ${model}: ${e.message}`;
      console.error(`[FOB] ${msg}`); errors.push(msg);
    }
  }
  throw new Error(errors.join(' | '));
}

async function fetchFromGemini(apiKey, prompt) {
  const models = ['gemini-2.0-flash', 'gemini-2.0-flash-lite'];
  const errors = [];
  for (const model of models) {
    try {
      console.log(`[FOB] Gemini trying: ${model}`);
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 4096, temperature: 0.7 }
          })
        }
      );
      if (!res.ok) {
        const msg = `Gemini ${model} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
        console.error(`[FOB] ${msg}`); errors.push(msg); continue;
      }
      const data = await res.json();
      const rawText = (data.candidates || []).flatMap(c => (c.content?.parts || []).map(p => p.text || '')).join('');
      const jobs = enrichAIJobs(parseJobs(rawText));
      console.log(`[FOB] Gemini ${model} → ${jobs.length} AI jobs`);
      return jobs;
    } catch (e) {
      const msg = `Gemini ${model}: ${e.message}`;
      console.error(`[FOB] ${msg}`); errors.push(msg);
    }
  }
  throw new Error(errors.join(' | '));
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const fetchedAt = () => new Date(_cachedAt || Date.now()).toISOString();

  const JSEARCH_KEY = process.env.RAPIDAPI_KEY;
  const GROQ_KEY    = process.env.GROQ_API_KEY;
  const GEMINI_KEY  = process.env.GEMINI_API_KEY;

  // Serve from cache if fresh (TTL depends on source quality)
  const ttl = _cachedReal ? CACHE_TTL_REAL : CACHE_TTL_AI;
  if (_cachedJobs && (Date.now() - _cachedAt) < ttl) {
    const ageMin = Math.round((Date.now() - _cachedAt) / 60000);
    console.log(`[FOB] Cache hit — ${_cachedJobs.length} jobs (${_cachedReal ? 'real' : 'AI'}, age: ${ageMin}m)`);
    res.setHeader('Cache-Control', _cachedReal ? CDN_CACHE_REAL : CDN_CACHE_FALLBACK);
    return res.status(200).json({ jobs: _cachedJobs, provider: 'cache', real: _cachedReal, fetchedAt: fetchedAt() });
  }

  const errors = [];

  // 1. Try JSearch (real live jobs)
  if (JSEARCH_KEY) {
    try {
      const jobs = await fetchFromJSearch(JSEARCH_KEY);
      _cachedJobs = jobs; _cachedAt = Date.now(); _cachedReal = true;
      res.setHeader('Cache-Control', CDN_CACHE_REAL);
      return res.status(200).json({ jobs, provider: 'jsearch', real: true, fetchedAt: fetchedAt() });
    } catch (e) {
      errors.push(`JSearch: ${e.message}`);
      console.error('[FOB] JSearch failed:', e.message);
      // Prefer stale real jobs over AI-generated ones
      if (_cachedJobs && _cachedReal) {
        res.setHeader('Cache-Control', CDN_CACHE_FALLBACK);
        return res.status(200).json({ jobs: _cachedJobs, provider: 'stale-cache', real: true, fetchedAt: fetchedAt() });
      }
    }
  }

  // 2. AI fallback — Groq
  const prompt = buildPrompt();
  if (GROQ_KEY) {
    try {
      const jobs = await fetchFromGroq(GROQ_KEY, prompt);
      _cachedJobs = jobs; _cachedAt = Date.now(); _cachedReal = false;
      res.setHeader('Cache-Control', CDN_CACHE_FALLBACK);
      return res.status(200).json({ jobs, provider: 'groq', real: false, fetchedAt: fetchedAt() });
    } catch (e) {
      errors.push(`Groq: ${e.message}`);
      console.error('[FOB] Groq failed:', e.message);
    }
  }

  // 3. AI fallback — Gemini
  if (GEMINI_KEY) {
    try {
      const jobs = await fetchFromGemini(GEMINI_KEY, prompt);
      _cachedJobs = jobs; _cachedAt = Date.now(); _cachedReal = false;
      res.setHeader('Cache-Control', CDN_CACHE_FALLBACK);
      return res.status(200).json({ jobs, provider: 'gemini', real: false, fetchedAt: fetchedAt() });
    } catch (e) {
      errors.push(`Gemini: ${e.message}`);
      console.error('[FOB] Gemini failed:', e.message);
    }
  }

  res.setHeader('Cache-Control', 'no-store');
  if (errors.length === 0) {
    return res.status(500).json({ error: 'No API keys configured. Add RAPIDAPI_KEY, GROQ_API_KEY, or GEMINI_API_KEY in Vercel → Settings → Environment Variables.' });
  }

  return res.status(500).json({ error: 'All providers failed', details: errors });
}
