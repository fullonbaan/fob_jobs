// api/jobs.js  — Vercel Serverless Function
// Proxies requests to Anthropic API so the API key never touches the browser.
// Deploy: set ANTHROPIC_API_KEY in Vercel project environment variables.

export default async function handler(req, res) {
  // CORS — allow your Vercel domain and localhost
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured in Vercel environment variables' });
  }

  const monthYear = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });

  const prompt = `Generate a JSON array of 30 current Infor LN / Baan ERP job openings as of ${monthYear}.
Mix: 15 functional + 15 technical. Regions: USA 60%, India 20%, ME 10%, EU 7%, AU 3%.
Sources: LinkedIn, Indeed, Dice, Glassdoor, ZipRecruiter, Foundit, Naukri, TechFetch, Upwork, ERPJobs, Bayt, Infor Careers.
Companies: Deloitte, Accenture, NTT Data, HCL, Capgemini, Infosys, Wipro, TCS, DXC, Innova, PCG, Right Skale, staffing firms.
Salary: USA $45-$130/hr or $80k-$160k/yr; India 8-25 LPA; ME AED 15k-35k/mo.

Each object MUST have these exact keys:
type, title, description, company, location, workMode, employment, salary, module, region, posted, displayDate, source, applyUrl, recruiterEmail

Enums:
- type: functional | technical
- workMode: remote | hybrid | onsite
- employment: contract | fulltime | w2 | c2c
- module: finance | manufacturing | supplychain | integration | projects | architecture | automotive
- region: usa | india | middleeast | europe | australia | global
- posted: "2026-03" or "2026-02"
- displayDate: "Mar 2026" or "Feb 2026"
- description: max 20 words
- applyUrl: realistic URL for the source portal
- recruiterEmail: company domain email or "" if anonymous/staffing

Return ONLY a raw JSON object: {"jobs": [...]}
No markdown, no code fences, no explanation.`;

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 3500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!upstream.ok) {
      const errBody = await upstream.text();
      return res.status(upstream.status).json({ error: errBody });
    }

    const data = await upstream.json();
    let text = (data.content || []).map(b => b.text || '').join('');

    // Strip any accidental markdown fences
    text = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim();

    // Extract the JSON object robustly
    const start = text.indexOf('{');
    const end   = text.lastIndexOf('}');
    if (start === -1 || end === -1) {
      return res.status(500).json({ error: 'No JSON found in model response', raw: text.slice(0, 300) });
    }

    const parsed = JSON.parse(text.slice(start, end + 1));
    const jobs   = Array.isArray(parsed.jobs) ? parsed.jobs : parsed;

    return res.status(200).json({ jobs });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
