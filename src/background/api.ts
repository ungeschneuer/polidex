/**
 * Extension API — fetches the pre-built politician list from the Polidex server.
 *
 * Supports conditional GET with ETag to avoid re-downloading unchanged data.
 * Returns null when server responds 304 Not Modified.
 */

import type { PoliticianData } from '../types/index.js';
import { POLIDEX_SERVER_URL } from '../shared/constants.js';

/**
 * Loads the politician list bundled with the extension (politicians.json in dist/).
 * Used as offline seed data on first install. Returns null if not available.
 */
export async function loadBundledPoliticians(): Promise<PoliticianData[] | null> {
  try {
    const url = chrome.runtime.getURL('politicians.json');
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json() as unknown;
    if (!Array.isArray(data)) return null;
    return data as PoliticianData[];
  } catch {
    return null;
  }
}

/**
 * Downloads the current politician list from the Polidex server.
 * Sends If-None-Match if we have a stored ETag; returns null on 304.
 * Returns [politicians, newETag] on success, or [null, null] on 304.
 * Throws if the server is unreachable or returns an unexpected error.
 */
export async function fetchPoliticiansFromServer(
  storedETag: string
): Promise<{ politicians: PoliticianData[]; etag: string } | null> {
  const headers: Record<string, string> = {};
  if (storedETag) headers['If-None-Match'] = storedETag;

  const res = await fetch(`${POLIDEX_SERVER_URL}/politicians.json`, {
    headers,
    cache: 'no-cache', // always send conditional GET; don't let browser cache suppress requests
  });

  if (res.status === 304) return null; // not modified

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Server responded ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as unknown;
  if (!Array.isArray(data)) throw new Error('Unexpected response shape from server');

  const etag = res.headers.get('ETag') ?? '';
  return { politicians: data as PoliticianData[], etag };
}
