// api/jobs.js — Vercel Serverless Function (Node.js 18+)
// Secure proxy: Anthropic API key stays server-side, never in the browser.
// Set ANTHROPIC_API_KEY in Vercel project → Settings → Environment Variables.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY is not set. Add it in Vercel → Settings → Environment Variables, then redeploy.'
    });
  }

  const monthYear = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });

  const prompt = `Generate a JSON object containing an array of 30 current Infor LN / Baan ERP job openings as of ${monthYear}.

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
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!upstream.ok) {
      const errBody = await upstream.text();
      console.error('Anthropic error:', errBody);
      return res.status(upstream.status).json({ error: 'Anthropic API error ' + upstream.status + ': ' + errBody.slice(0, 300) });
    }

    const data = await upstream.json();
    let text = (data.content || []).map(b => b.text || '').join('');

    // Strip accidental markdown fences
    text = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim();

    // Extract outermost JSON object
    const start = text.indexOf('{');
    const end   = text.lastIndexOf('}');
    if (start === -1 || end === -1) {
      console.error('No JSON found. Raw:', text.slice(0, 500));
      return res.status(500).json({ error: 'Model did not return valid JSON', raw: text.slice(0, 300) });
    }

    const parsed = JSON.parse(text.slice(start, end + 1));
    const jobs   = Array.isArray(parsed.jobs) ? parsed.jobs : (Array.isArray(parsed) ? parsed : []);

    if (jobs.length === 0) {
      return res.status(500).json({ error: 'Parsed JSON had no jobs array', raw: text.slice(0, 300) });
    }

    return res.status(200).json({ jobs });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: err.message });
  }
};
