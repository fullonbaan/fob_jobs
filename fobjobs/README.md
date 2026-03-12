# FOB Jobs — Vercel Deployment Guide

## Project Structure
```
fobjobs/
├── api/
│   └── jobs.js          ← Serverless function (Anthropic proxy)
├── public/
│   └── index.html       ← The jobs site
├── vercel.json          ← Routing config
└── README.md
```

## One-Time Setup

### 1. Deploy to Vercel

```bash
# Install Vercel CLI (if not already)
npm i -g vercel

# From the fobjobs/ folder:
vercel deploy --prod
```

Or connect your GitHub repo to Vercel via https://vercel.com/new

### 2. Add Your Anthropic API Key

In the Vercel dashboard:
1. Go to your project → **Settings** → **Environment Variables**
2. Add: `ANTHROPIC_API_KEY` = `sk-ant-...your key...`
3. Set environment: **Production** (and Preview if needed)
4. Click **Save** then **Redeploy**

Get your API key at: https://console.anthropic.com/

### 3. That's it!

The site will now fetch fresh AI-generated Infor LN jobs on every page load.
Jobs are cached in sessionStorage for 30 minutes to avoid redundant API calls.

## How it works

- Browser calls `/api/jobs` (same domain, no CORS issues)
- Vercel serverless function calls Anthropic API with your secret key
- Jobs returned as JSON, rendered with staggered animation
- Fallback to 30 curated static jobs if API is unavailable

## Cost estimate
- Claude Haiku: ~$0.001 per page load (3500 output tokens)
- 1000 visits/day ≈ $1/day
