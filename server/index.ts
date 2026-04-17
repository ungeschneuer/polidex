/**
 * Polidex server — serves pre-built politician data to the browser extension.
 *
 * Endpoints:
 *   GET /politicians.json  — full PoliticianData[] array, served from disk
 *   GET /health            — liveness check
 *
 * Supports conditional GET via ETag (mtime-based).
 * Refreshes daily at midnight Europe/Berlin via cron.
 *
 * Environment variables:
 *   PORT  — HTTP port (default: 3000)
 */

import http from 'http';
import fs from 'fs';
import { syncPoliticians, DATA_FILE } from './sync.js';
import cron from 'node-cron';

const DATA_FILE_GZ = DATA_FILE + '.gz';

// Clients should keep the file for 24 h (data updates only once daily).
// stale-while-revalidate lets CDN / reverse proxies serve the previous
// version for an extra hour while they fetch the new one in the background.
const CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=3600';

const PORT = Number(process.env.PORT ?? 3000);

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (req.url !== '/politicians.json') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  if (!fs.existsSync(DATA_FILE)) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Data not yet available — initial sync is running.' }));
    return;
  }

  // ETag from source file mtime — same value regardless of encoding
  const stat = fs.statSync(DATA_FILE);
  const etag = `"${Math.floor(stat.mtimeMs)}"`;

  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch === etag) {
    res.writeHead(304, {
      'ETag':                        etag,
      'Vary':                        'Accept-Encoding',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               CACHE_CONTROL,
    });
    res.end();
    return;
  }

  // Serve pre-compressed file when the client accepts gzip and the .gz exists.
  const acceptsGzip = (req.headers['accept-encoding'] ?? '').includes('gzip');
  const serveGz     = acceptsGzip && fs.existsSync(DATA_FILE_GZ);

  const headers: http.OutgoingHttpHeaders = {
    'Content-Type':                'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control':               CACHE_CONTROL,
    'ETag':                        etag,
    'Vary':                        'Accept-Encoding',
  };
  if (serveGz) headers['Content-Encoding'] = 'gzip';

  res.writeHead(200, headers);
  fs.createReadStream(serveGz ? DATA_FILE_GZ : DATA_FILE).pipe(res);
});

// ─── Cron: daily sync at midnight (Berlin time) ───────────────────────────────

cron.schedule('0 0 * * *', () => {
  console.log('[server] Starting scheduled midnight sync...');
  syncPoliticians()
    .then(n => console.log(`[server] Sync complete — ${n} politicians`))
    .catch(err => console.error('[server] Sync failed:', err));
}, { timezone: 'Europe/Berlin' });

// ─── Startup ──────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[Polidex server] listening on http://localhost:${PORT}`);
  console.log(`[Polidex server] endpoint: http://localhost:${PORT}/politicians.json`);

  if (!fs.existsSync(DATA_FILE)) {
    console.log('[server] No data file found — running initial sync (takes a few minutes)...');
    syncPoliticians()
      .then(n => console.log(`[server] Initial sync complete — ${n} politicians`))
      .catch(err => console.error('[server] Initial sync failed:', err));
  } else {
    const stat = fs.statSync(DATA_FILE);
    const age  = Math.round((Date.now() - stat.mtimeMs) / 3_600_000);
    console.log(`[server] Data file found (${age}h old)`);
  }
});
