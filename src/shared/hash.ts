/**
 * Generates a stable SHA-256 hash for an article based on its URL and title.
 * Uses the WebCrypto API (available in both content scripts and service workers).
 */
export async function hashArticle(url: string, title: string): Promise<string> {
  const input = `${normalizeUrl(url)}|${title.trim().toLowerCase()}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return bufferToHex(hashBuffer);
}

/** Strip query params and fragments that don't change the article identity. */
function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    // Keep path and hostname; remove tracking params
    const TRACKING_PARAMS = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'ref', 'source', 'fbclid', 'gclid',
    ];
    TRACKING_PARAMS.forEach(p => url.searchParams.delete(p));
    url.hash = '';
    return url.toString();
  } catch {
    return raw;
  }
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
