// api/jobs.js — Vercel Serverless Function (Node.js 18+)
// Free LLM chain: Groq (primary) → Gemini Flash (fallback)
// Env vars: GROQ_API_KEY and/or GEMINI_API_KEY in Vercel Settings → Environment Variables

export const config = { maxDuration: 30 };

// ── Server-side in-memory cache (survives across warm invocations) ──────────
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let _cachedJobs = null;
let _cachedAt   = 0;

function buildPrompt() {
  const monthYear = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
  return `Generate JSON with 15 Infor LN/Baan ERP job openings as of ${monthYear}. Mix: 8 functional + 7 technical.
Regions: USA 60%, India 20%, ME 10%, EU 7%, AU 3%.
Companies: Deloitte, Accenture, NTT Data, HCL, Capgemini, Infosys, Wipro, TCS, DXC, Innova.
Salary: USA $45-$130/hr; India 8-25 LPA; ME AED 15k-35k/mo.
Each job has ONLY these keys: type,title,description,company,location,workMode,employment,salary,module,region,posted,displayDate
Values: type=functional|technical; workMode=remote|hybrid|onsite; employment=contract|fulltime|w2|c2c; module=finance|manufacturing|supplychain|integration|projects|architecture|automotive; region=usa|india|middleeast|europe|australia|global; posted=DD MMM YYYY within last 14 days; displayDate=same as posted; description=10 words max; location=city and country e.g. "Chicago, USA".
Return ONLY: {"jobs":[...]}`;
}

// ── Build real job-search URLs from title + location (no fake job IDs) ───────
function buildApplyUrls(job, index) {
  // Strip leading "Infor LN" / "Baan" from title to avoid duplicate in search query
  const cleanTitle = (job.title || '').replace(/^(infor\s+ln|baan)\s*/i, '').trim();
  const q   = encodeURIComponent(`"Infor LN" ${cleanTitle}`);
  const loc = encodeURIComponent(job.location || '');
  const isRemote = job.workMode === 'remote';

  // Alternate LinkedIn / Indeed for variety across listings
  if (index % 2 === 0) {
    // LinkedIn Jobs search
    const remoteParam = isRemote ? '&f_WT=2' : '';
    const locParam    = (!isRemote && loc) ? `&location=${loc}` : '';
    return {
      applyUrl: `https://www.linkedin.com/jobs/search/?keywords=${q}${locParam}${remoteParam}`,
      source:   'LinkedIn'
    };
  } else {
    // Indeed search
    const locParam = isRemote ? 'Remote' : (job.location || '');
    return {
      applyUrl: `https://www.indeed.com/jobs?q=${q}&l=${encodeURIComponent(locParam)}`,
      source:   'Indeed'
    };
  }
}

function enrichJobs(jobs) {
  return jobs.map((job, i) => {
    const { applyUrl, source } = buildApplyUrls(job, i);
    return {
      ...job,
      applyUrl,
      source,
      recruiterEmail: ''
    };
  });
}

function parseJobs(text) {
  // Strip any markdown fences
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/g, '').trim();

  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in response');

  // Try clean full parse first
  try {
    const end = text.lastIndexOf('}');
    if (end > start) {
      const parsed = JSON.parse(text.slice(start, end + 1));
      const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
      if (jobs.length > 0) return jobs;
    }
  } catch (_) { /* fall through to repair */ }

  // Salvage truncated output — find last fully closed job object
  const arrStart = text.indexOf('[');
  if (arrStart !== -1) {
    const arrText = text.slice(arrStart);
    const lastClose = arrText.lastIndexOf('},');
    if (lastClose !== -1) {
      try {
        const jobs = JSON.parse(arrText.slice(0, lastClose + 1) + ']');
        if (Array.isArray(jobs) && jobs.length > 0) {
          console.log(`[FOB] Salvaged ${jobs.length} jobs from truncated response`);
          return jobs;
        }
      } catch (_) { /* continue */ }
    }
  }

  throw new Error('No valid jobs array found in response');
}

async function fetchFromGroq(apiKey, prompt) {
  // Active Groq models + per-model max_tokens tuned to free-tier TPM limits:
  //   llama-3.3-70b-versatile  → 12000 TPM  → max_tokens 5000 safe
  //   llama-3.1-8b-instant     →  6000 TPM  → max_tokens 3000 safe (input ~400)
  //   llama-3.1-70b-versatile  → 12000 TPM  → max_tokens 5000 safe
  const models = [
    { id: 'llama-3.3-70b-versatile',  maxTok: 5000 },
    { id: 'llama-3.1-8b-instant',     maxTok: 3000 },
    { id: 'llama-3.1-70b-versatile',  maxTok: 5000 }
  ];

  const errors = [];
  for (const { id: model, maxTok } of models) {
    try {
      console.log(`[FOB] Groq trying model: ${model} (max_tokens: ${maxTok})`);
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTok,
          temperature: 0.7,
          messages: [
            { role: 'system', content: 'Return only valid JSON with no markdown or explanation.' },
            { role: 'user',   content: prompt }
          ]
        })
      });

      if (!res.ok) {
        const err = await res.text();
        const msg = `Groq ${model} HTTP ${res.status}: ${err.slice(0, 300)}`;
        console.error(`[FOB] ${msg}`);
        errors.push(msg);
        continue;
      }

      const data = await res.json();
      const rawText = (data.choices || []).map(c => c.message?.content || '').join('');
      const jobs = enrichJobs(parseJobs(rawText));
      console.log(`[FOB] Groq ${model} returned ${jobs.length} jobs`);
      return jobs;

    } catch (e) {
      const msg = `Groq ${model} error: ${e.message}`;
      console.error(`[FOB] ${msg}`);
      errors.push(msg);
    }
  }
  throw new Error(errors.join(' | ') || 'All Groq models failed');
}

async function fetchFromGemini(apiKey, prompt) {
  // Active Gemini v1beta models as of April 2026
  // gemini-1.5-flash and gemini-1.5-flash-8b removed (404 on v1beta)
  const models = ['gemini-2.0-flash', 'gemini-2.0-flash-lite'];

  const errors = [];
  for (const model of models) {
    try {
      console.log(`[FOB] Gemini trying model: ${model}`);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 4096, temperature: 0.7 }
        })
      });

      if (!res.ok) {
        const err = await res.text();
        const msg = `Gemini ${model} HTTP ${res.status}: ${err.slice(0, 300)}`;
        console.error(`[FOB] ${msg}`);
        errors.push(msg);
        continue;
      }

      const data = await res.json();
      const rawText = (data.candidates || [])
        .flatMap(c => (c.content?.parts || []).map(p => p.text || ''))
        .join('');
      const jobs = enrichJobs(parseJobs(rawText));
      console.log(`[FOB] Gemini ${model} returned ${jobs.length} jobs`);
      return jobs;

    } catch (e) {
      const msg = `Gemini ${model} error: ${e.message}`;
      console.error(`[FOB] ${msg}`);
      errors.push(msg);
    }
  }
  throw new Error(errors.join(' | ') || 'All Gemini models failed');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const GROQ_KEY   = process.env.GROQ_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  if (!GROQ_KEY && !GEMINI_KEY) {
    return res.status(500).json({
      error: 'No API key set. Add GROQ_API_KEY (free at console.groq.com) or GEMINI_API_KEY (free at aistudio.google.com) in Vercel → Settings → Environment Variables.'
    });
  }

  // Serve from cache if fresh (avoids burning free-tier quotas on every page load)
  if (_cachedJobs && (Date.now() - _cachedAt) < CACHE_TTL_MS) {
    console.log(`[FOB] Serving ${_cachedJobs.length} cached jobs (age: ${Math.round((Date.now()-_cachedAt)/60000)}m)`);
    return res.status(200).json({ jobs: _cachedJobs, provider: 'cache' });
  }

  const prompt = buildPrompt();
  const errors = [];

  if (GROQ_KEY) {
    try {
      const jobs = await fetchFromGroq(GROQ_KEY, prompt);
      _cachedJobs = jobs; _cachedAt = Date.now();
      return res.status(200).json({ jobs, provider: 'groq' });
    } catch (e) {
      errors.push(e.message);
      console.error('[FOB] Groq provider failed:', e.message);
    }
  }

  if (GEMINI_KEY) {
    try {
      const jobs = await fetchFromGemini(GEMINI_KEY, prompt);
      _cachedJobs = jobs; _cachedAt = Date.now();
      return res.status(200).json({ jobs, provider: 'gemini' });
    } catch (e) {
      errors.push(e.message);
      console.error('[FOB] Gemini provider failed:', e.message);
    }
  }

  return res.status(500).json({
    error: 'All providers failed',
    details: errors
  });
}
