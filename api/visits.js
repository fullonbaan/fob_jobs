// api/visits.js — Vercel Serverless Function: visitor counter for jobs.fullonbaan.com
//
// GET  /api/visits  → { total }            (read only)
// POST /api/visits  → { total, counted }   (counts this visitor, once per day)
//
// Displayed total = BASE + number of counted visits.
//
// Storage, best first:
//   1. Upstash Redis (Vercel → Storage → Marketplace → Upstash Redis, free tier).
//      Env: KV_REST_API_URL + KV_REST_API_TOKEN  (or UPSTASH_REDIS_REST_URL + _TOKEN).
//      Atomic INCR, and each visitor (hashed IP + browser) is counted once per day.
//   2. Vercel Blob (already connected for the jobs feed). Counts are batched per
//      instance and written at most every 60 s to stay inside Blob's write limits,
//      so a few visits can be lost under heavy load. The browser also only reports
//      once per day.

import { createHash } from 'node:crypto';

const BASE        = 10000;
const KEY_TOTAL   = 'fob:jobs:visits';
const DAY_SECONDS = 24 * 60 * 60;
const BLOB_PATH   = 'fob-jobs/visits.json';
const FLUSH_MS    = 60 * 1000;
const ALLOWED_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*fullonbaan\.com$/i;

// ── Upstash Redis (REST, no dependency) ─────────────────────────────────────
const R_URL   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL   || '';
const R_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const hasRedis = !!(R_URL && R_TOKEN);

async function redis(cmds) {
  const res = await fetch(`${R_URL.replace(/\/$/, '')}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${R_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!res.ok) throw new Error(`Redis HTTP ${res.status}`);
  return (await res.json()).map(r => r.result);
}

// ── Vercel Blob fallback ────────────────────────────────────────────────────
const blobToken = () => process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN || '';
function blobPublicUrl() {
  const sid = process.env.BLOB_STORE_ID;
  const storeId = sid ? sid.replace(/^store_/, '') : (process.env.BLOB_READ_WRITE_TOKEN || '').split('_')[3];
  return storeId ? `https://${storeId.toLowerCase()}.public.blob.vercel-storage.com/${BLOB_PATH}` : '';
}
let _blobUrl = '';
let _pending = 0;          // visits counted by this instance, not yet written
let _lastFlush = 0;
let _lastKnown = 0;        // last stored count this instance saw

async function blobRead() {
  if (!blobToken()) return _lastKnown;
  try {
    const res = await fetch((_blobUrl || blobPublicUrl()) + '?t=' + Date.now(), { cache: 'no-store' });
    if (res.ok) { const d = await res.json(); _lastKnown = Math.max(_lastKnown, Number(d.count) || 0); }
  } catch (_) { /* first run: no file yet */ }
  return _lastKnown;
}

async function blobFlush(force) {
  if (!blobToken() || _pending === 0) return;
  if (!force && Date.now() - _lastFlush < FLUSH_MS) return;
  const add = _pending; _pending = 0; _lastFlush = Date.now();
  try {
    const current = await blobRead();
    const count = current + add;
    const { put } = await import('@vercel/blob');
    const r = await put(BLOB_PATH, JSON.stringify({ count, updatedAt: new Date().toISOString() }), {
      access: 'public', addRandomSuffix: false, allowOverwrite: true,
      contentType: 'application/json', cacheControlMaxAge: 60,
    });
    _blobUrl = r.url; _lastKnown = count;
  } catch (e) {
    _pending += add;   // try again on the next request
    console.error('[FOB] visits blob write failed:', e.message);
  }
}

// ── Handler ─────────────────────────────────────────────────────────────────
function visitorId(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '').split(',')[0].trim();
  const ua = String(req.headers['user-agent'] || '');
  const day = new Date().toISOString().slice(0, 10);
  return createHash('sha256').update(`${ip}|${ua}|${day}`).digest('hex').slice(0, 32);
}

const looksLikeBot = ua => /bot|crawl|spider|slurp|preview|headless|lighthouse|monitor|curl|wget|python|axios|node-fetch/i.test(ua || '');

export default async function handler(req, res) {
  const origin = String(req.headers?.origin || '');
  if (ALLOWED_ORIGIN.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Count only real page visits: a POST from a FullOnBaan page, not a bot
  const fromSite = ALLOWED_ORIGIN.test(origin) || /^https:\/\/([a-z0-9-]+\.)*fullonbaan\.com\//i.test(String(req.headers?.referer || ''));
  const shouldCount = req.method === 'POST' && fromSite && !looksLikeBot(req.headers['user-agent']);

  try {
    if (hasRedis) {
      let count, counted = false;
      if (shouldCount) {
        const [isNew] = await redis([['SET', `fob:jobs:v:${visitorId(req)}`, '1', 'NX', 'EX', String(DAY_SECONDS)]]);
        if (isNew === 'OK') { [count] = await redis([['INCR', KEY_TOTAL]]); counted = true; }
      }
      if (count === undefined) [count] = await redis([['GET', KEY_TOTAL]]);
      return res.status(200).json({ total: BASE + (Number(count) || 0), counted });
    }

    // Blob fallback
    if (shouldCount) _pending += 1;
    await blobFlush(false);
    const stored = await blobRead();
    return res.status(200).json({ total: BASE + stored + _pending, counted: shouldCount });
  } catch (e) {
    console.error('[FOB] visits failed:', e.message);
    return res.status(200).json({ total: null, counted: false });
  }
}
