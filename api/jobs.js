// api/jobs.js — Vercel Serverless Function (Node.js 18+)
// Free LLM chain: Groq (primary) → Gemini Flash (fallback)
// Env vars: GROQ_API_KEY and/or GEMINI_API_KEY in Vercel Settings → Environment Variables

export const config = { maxDuration: 30 };

function buildPrompt() {
  const monthYear = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
  return `Generate a JSON object with an array of 30 current Infor LN / Baan ERP job openings as of ${monthYear}.

Mix: 15 functional + 15 technical.
Regions: USA 60%, India 20%, ME 10%, EU 7%, AU 3%.
Companies: Deloitte, Accenture, NTT Data, HCL, Capgemini, Infosys, Wipro, TCS, DXC, Innova, PCG, Right Skale.
Salary: USA $45-$130/hr or $80k-$160k/yr; India 8-25 LPA; ME AED 15k-35k/mo.

Each job MUST have exactly these keys:
type, title, description, company, location, workMode, employment, salary, module, region, posted, displayDate, source, applyUrl, recruiterEmail

Rules:
- type: "functional" or "technical"
- workMode: "remote" | "hybrid" | "onsite"
- employment: "contract" | "fulltime" | "w2" | "c2c"
- module: "finance" | "manufacturing" | "supplychain" | "integration" | "projects" | "architecture" | "automotive"
- region: "usa" | "india" | "middleeast" | "europe" | "australia" | "global"
- posted: date in "DD MMM YYYY" format within last 14 days e.g. "12 Apr 2026"
- displayDate: same as posted
- description: 15-20 words max
- applyUrl: realistic job portal URL
- recruiterEmail: company email or ""

Return ONLY valid JSON, no markdown, no explanation:
{"jobs": [ ... ]}`;
}

function parseJobs(text) {
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/g, '').trim();
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON found in response');
  const parsed = JSON.parse(text.slice(start, end + 1));
  const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
  if (jobs.length === 0) throw new Error('No jobs array in response');
  return jobs;
}

async function fetchFromGroq(apiKey, prompt) {
  // Try models in order — first working one wins
  const models = [
    'llama-3.1-8b-instant',
    'llama3-8b-8192',
    'llama-3.3-70b-versatile',
    'mixtral-8x7b-32768'
  ];

  let lastError = '';
  for (const model of models) {
    try {
      console.log(`[FOB] Groq trying model: ${model}`);
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          temperature: 0.7,
          messages: [
            { role: 'system', content: 'Return only valid JSON with no markdown or explanation.' },
            { role: 'user',   content: prompt }
          ]
        })
      });

      if (!res.ok) {
        const err = await res.text();
        lastError = `Groq ${model} HTTP ${res.status}: ${err.slice(0, 300)}`;
        console.error(`[FOB] ${lastError}`);
        continue; // try next model
      }

      const data = await res.json();
      const text = (data.choices || []).map(c => c.message?.content || '').join('');
      const jobs = parseJobs(text);
      console.log(`[FOB] Groq ${model} returned ${jobs.length} jobs`);
      return jobs;

    } catch (e) {
      lastError = `Groq ${model} error: ${e.message}`;
      console.error(`[FOB] ${lastError}`);
    }
  }
  throw new Error(lastError || 'All Groq models failed');
}

async function fetchFromGemini(apiKey, prompt) {
  const models = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-flash-8b'];

  let lastError = '';
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
        lastError = `Gemini ${model} HTTP ${res.status}: ${err.slice(0, 300)}`;
        console.error(`[FOB] ${lastError}`);
        continue;
      }

      const data = await res.json();
      const text = (data.candidates || [])
        .flatMap(c => (c.content?.parts || []).map(p => p.text || ''))
        .join('');
      const jobs = parseJobs(text);
      console.log(`[FOB] Gemini ${model} returned ${jobs.length} jobs`);
      return jobs;

    } catch (e) {
      lastError = `Gemini ${model} error: ${e.message}`;
      console.error(`[FOB] ${lastError}`);
    }
  }
  throw new Error(lastError || 'All Gemini models failed');
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

  const prompt = buildPrompt();
  const errors = [];

  if (GROQ_KEY) {
    try {
      const jobs = await fetchFromGroq(GROQ_KEY, prompt);
      return res.status(200).json({ jobs, provider: 'groq' });
    } catch (e) {
      errors.push(e.message);
      console.error('[FOB] Groq provider failed:', e.message);
    }
  }

  if (GEMINI_KEY) {
    try {
      const jobs = await fetchFromGemini(GEMINI_KEY, prompt);
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
