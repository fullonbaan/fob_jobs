// api/jobs.js — Vercel Serverless Function (Node.js 18+)
// Free LLM provider chain: Groq (primary) → Google Gemini Flash (secondary)
// Set GROQ_API_KEY and/or GEMINI_API_KEY in Vercel → Settings → Environment Variables.
// Both are 100% free — no credit card needed for the free tiers.

module.exports.config = { maxDuration: 30 };

// ── Shared prompt ────────────────────────────────────────────────────────────
function buildPrompt() {
  const monthYear = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
  return `Generate a JSON object containing an array of 30 current Infor LN / Baan ERP job openings as of ${monthYear}.

Mix: 15 functional + 15 technical.
Regions: USA 60%, India 20%, ME 10%, EU 7%, AU 3%.
Sources: LinkedIn, Indeed, Dice, Glassdoor, ZipRecruiter, Foundit, Naukri, TechFetch, Upwork, ERPJobs, Bayt, Infor Careers.
Companies: Deloitte, Accenture, NTT Data, HCL, Capgemini, Infosys, Wipro, TCS, DXC, Innova, PCG, Right Skale, staffing firms.
Salary: USA $45-$130/hr or $80k-$160k/yr; India 8-25 LPA; ME AED 15k-35k/mo.

Each job object MUST have exactly these keys:
type, title, description, company, location, workMode, employment, salary, module, region, posted, displayDate, source, applyUrl, recruiterEmail

Key rules:
- type: "functional" or "technical"
- workMode: "remote" | "hybrid" | "onsite"
- employment: "contract" | "fulltime" | "w2" | "c2c"
- module: "finance" | "manufacturing" | "supplychain" | "integration" | "projects" | "architecture" | "automotive"
- region: "usa" | "india" | "middleeast" | "europe" | "australia" | "global"
- posted: a realistic specific date in "DD MMM YYYY" format, mostly within the last 14 days (e.g. "10 Mar 2026", "05 Mar 2026", "28 Feb 2026"). Vary the dates.
- displayDate: same as posted (e.g. "10 Mar 2026")
- description: 15-20 words max
- applyUrl: realistic URL for that source portal
- recruiterEmail: company domain email (e.g. erp@deloitte.com) or "" if anonymous

Return ONLY this JSON, nothing else — no markdown, no code fences, no explanation:
{"jobs": [ ... ]}`;
}

// ── Parse jobs from raw LLM text ─────────────────────────────────────────────
function parseJobs(text) {
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim();
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in response');
  const parsed = JSON.parse(text.slice(start, end + 1));
  const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : (Array.isArray(parsed) ? parsed : []);
  if (jobs.length === 0) throw new Error('Parsed JSON had no jobs array');
  return jobs;
}

// ── Provider 1: Groq (free — 14,400 req/day, llama3 or mixtral) ─────────────
async function fetchFromGroq(apiKey, prompt) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',   // free, very fast (~1-2s)
      max_tokens: 4000,
      temperature: 0.7,
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that returns only valid JSON. Never include markdown, code fences, or any explanation.'
        },
        { role: 'user', content: prompt }
      ]
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = (data.choices || []).map(c => c.message?.content || '').join('');
  return parseJobs(text);
}

// ── Provider 2: Google Gemini Flash (free — 1,500 req/day) ───────────────────
async function fetchFromGemini(apiKey, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 4000,
        temperature: 0.7
      }
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = (data.candidates || [])
    .flatMap(c => (c.content?.parts || []).map(p => p.text || ''))
    .join('');
  return parseJobs(text);
}

// ── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const GROQ_KEY   = process.env.GROQ_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  if (!GROQ_KEY && !GEMINI_KEY) {
    return res.status(500).json({
      error: 'No API key configured. Set GROQ_API_KEY (free at console.groq.com) or GEMINI_API_KEY (free at aistudio.google.com) in Vercel → Settings → Environment Variables, then redeploy.'
    });
  }

  const prompt = buildPrompt();
  const errors = [];

  // Try Groq first (fastest, free)
  if (GROQ_KEY) {
    try {
      console.log('[FOB] Trying Groq (llama-3.1-8b-instant)...');
      const jobs = await fetchFromGroq(GROQ_KEY, prompt);
      console.log('[FOB] Groq returned', jobs.length, 'jobs');
      return res.status(200).json({ jobs, provider: 'groq' });
    } catch (err) {
      console.warn('[FOB] Groq failed:', err.message);
      errors.push('Groq: ' + err.message);
    }
  }

  // Fallback: Google Gemini Flash (also free)
  if (GEMINI_KEY) {
    try {
      console.log('[FOB] Trying Gemini Flash...');
      const jobs = await fetchFromGemini(GEMINI_KEY, prompt);
      console.log('[FOB] Gemini returned', jobs.length, 'jobs');
      return res.status(200).json({ jobs, provider: 'gemini' });
    } catch (err) {
      console.warn('[FOB] Gemini failed:', err.message);
      errors.push('Gemini: ' + err.message);
    }
  }

  return res.status(500).json({
    error: 'All providers failed. Check your API keys and Vercel logs.',
    details: errors
  });
};
