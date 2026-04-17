/**
 * One-shot script to generate the initial politicians.json using the
 * Abgeordnetenwatch API (no authentication required). Run with:
 *
 *   npx tsx server/fetch-initial.ts
 *
 * This is just a thin wrapper around server/sync.ts.
 */

import { syncPoliticians, DATA_FILE } from './sync.js';

syncPoliticians()
  .then(n => console.log(`[fetch-initial] Done — ${n} politicians written to ${DATA_FILE}`))
  .catch(err => { console.error(err); process.exit(1); });
