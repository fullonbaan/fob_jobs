# FOB Jobs — jobs.fullonbaan.com

Live Infor LN / Baan job tracker. Real listings only, from JSearch (RapidAPI, Google for Jobs data).

## Project structure
```
api/jobs.js     Serverless function: JSearch → rolling 30-day job pool (Vercel Blob)
public/index.html  The jobs site (fetches /api/jobs)
vercel.json     Daily cron (06:00 IST) + security headers
archive/        Old static exports (not deployed)
```

## Environment variables (Vercel → Settings → Environment Variables)
| Name | Purpose |
|---|---|
| `RAPIDAPI_KEY` | JSearch key (free plan: 200 requests/month) |
| `CRON_SECRET` | Random string, 16+ chars. Vercel sends it as `Authorization: Bearer …` on cron calls. Without it the cron is treated as a normal visitor and the feed refreshes only every ~2 days. |
| `BLOB_STORE_ID` / `BLOB_READ_WRITE_TOKEN` | Added automatically when a Vercel Blob store is connected. Holds the shared job pool. |

## How it works
- Each refresh runs 3 search tasks (≈6 JSearch requests), rotating through US, India, UK, Netherlands, Germany and UAE.
- Results are merged into a rolling pool (posted within 30 days, max 150 jobs), deduplicated by title + normalised company, job id and description.
- Each job is tagged with product (LN/Baan, M3, CSI/SyteLine, Visual, OS/ION, Other), type, module, work mode and employment type.
- Direct employer apply links are preferred over aggregator reposts (marked ✓ on the site).
- The site opens filtered to Infor LN / Baan; "All" shows every Infor product.
- The API only accepts GET and only allows browser calls from *.fullonbaan.com.
