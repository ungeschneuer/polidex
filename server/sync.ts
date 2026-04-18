/**
 * Politician data sync — fetches Bundestag MdBs from WP16–WP21 via the
 * Abgeordnetenwatch API, deduplicates across periods, enriches with committee
 * memberships and Wikidata portrait images, then writes the result as JSON.
 *
 * Rate-limiting strategy:
 *   - Politician detail requests are batched (20 concurrent) with 100 ms gaps
 *   - Committee memberships are paginated with 200 ms gaps between pages
 *   - Wikidata image requests batch up to 50 QIDs per request with 100 ms gaps
 *   - 300 ms pause between fetching different parliament periods
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { gzip } from 'zlib';
import type { PoliticianData, Faction, PolidexType } from '../src/types/index.js';
import { COMMON_SURNAMES, committeesToTypes } from '../src/shared/constants.js';

const gzipAsync = promisify(gzip);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_FILE = path.join(__dirname, 'data', 'politicians.json');

/** AW parliament ID for the Bundestag (used when fetching period list). */
const AW_BUNDESTAG_PARLIAMENT = 5;

const AW_API  = 'https://www.abgeordnetenwatch.de/api/v2';
const WD_API  = 'https://www.wikidata.org/w/api.php';
const WC_PATH = 'https://commons.wikimedia.org/wiki/Special:FilePath';

// Allow running as a standalone script: `npm run server:sync`
if (process.argv.includes('--run-sync')) {
  syncPoliticians()
    .then(n => { console.log(`Done — ${n} politicians written to ${DATA_FILE}`); process.exit(0); })
    .catch(err => { console.error('Sync failed:', err); process.exit(1); });
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function syncPoliticians(outputPath: string = DATA_FILE): Promise<number> {
  console.log('[sync] Fetching parliament periods from Abgeordnetenwatch...');
  const periods = await fetchParliamentPeriods();
  console.log(`[sync] Found ${periods.length} Bundestag mandate periods: WP${periods[0]?.wp}–WP${periods[periods.length - 1]?.wp}`);

  const currentPeriod = periods.find(p => p.activeOnly)!;

  // Load existing data — if present this is an incremental run and we skip
  // all closed historical periods (they never change).
  let existingPoliticians: PoliticianData[] = [];
  try {
    const raw = await fs.readFile(outputPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0) existingPoliticians = parsed as PoliticianData[];
  } catch { /* first run or missing file */ }

  const isFirstRun    = existingPoliticians.length === 0;
  const periodsToFetch = isFirstRun ? periods : [currentPeriod];

  if (isFirstRun) {
    console.log('[sync] First run — fetching all periods');
  } else {
    console.log(`[sync] Incremental sync — re-fetching WP${currentPeriod.wp} only (${existingPoliticians.length} existing politicians loaded)`);
  }

  // Deduplicate within fetched periods by stable AW politician ID.
  const allByAwId = new Map<number, PoliticianWithInternals>();

  for (const { periodId, wp, activeOnly } of periodsToFetch) {
    console.log(`[sync] Fetching WP${wp} (period ${periodId})...`);
    const mandates = await fetchMandates(periodId, activeOnly);
    console.log(`[sync]   ${mandates.length} mandates`);
    const politicians = await fetchPoliticianDetails(mandates, wp);

    for (const p of politicians) {
      const existing = allByAwId.get(p._awId);
      if (existing) {
        existing.periodsActive = [...new Set([...existing.periodsActive, wp])].sort((a, b) => a - b);
        if (wp > existing._wp) {
          existing.faction    = p.faction;
          existing._qid       = p._qid ?? existing._qid;
          existing._wp        = wp;
          existing.id         = p.id;
          existing.mediaScore = p.mediaScore;
        }
      } else {
        p.periodsActive = [wp];
        allByAwId.set(p._awId, p);
      }
    }

    await sleep(300);
  }

  let politicians: PoliticianWithInternals[];

  if (isFirstRun) {
    politicians = Array.from(allByAwId.values());
    console.log(`[sync] ${politicians.length} unique politicians across WP${periods[0]?.wp}–WP${periods[periods.length - 1]?.wp}`);
  } else {
    // Merge fresh current-period data with the existing historical data.
    const existingById = new Map(existingPoliticians.map(p => [p.id, p]));
    const currentWP    = currentPeriod.wp;

    const currentIds = new Set<string>();
    const updatedCurrent: PoliticianWithInternals[] = Array.from(allByAwId.values()).map(p => {
      currentIds.add(p.id);
      const prev = existingById.get(p.id);
      if (!prev) return p;
      return {
        ...prev,
        faction:       p.faction,
        mediaScore:    p.mediaScore,
        periodsActive: [...new Set([...(prev.periodsActive ?? []), currentWP])].sort((a, b) => a - b),
        _qid:          p._qid,
        _awId:         p._awId,
        _mandateId:    p._mandateId,
        _wp:           p._wp,
        id:            p.id,
        isArchived:    undefined, // clear if they returned to active mandates
      };
    });

    // IDs that were active in the current period last sync — those now missing are archived.
    const previouslyInCurrentPeriod = new Set(
      existingPoliticians
        .filter(p => (p.periodsActive ?? []).includes(currentWP))
        .map(p => p.id)
    );

    // Historical politicians (closed periods) pass through unchanged.
    // Politicians who just left the current period get flagged as archived.
    const historical: PoliticianWithInternals[] = existingPoliticians
      .filter(p => !currentIds.has(p.id))
      .map(p => ({
        ...p,
        _awId:      0,
        _wp:        0,
        isArchived: previouslyInCurrentPeriod.has(p.id) ? true : p.isArchived,
      }));

    politicians = [...historical, ...updatedCurrent];
    console.log(`[sync] ${updatedCurrent.length} current-period politicians merged (${historical.length} historical unchanged)`);
  }

  // Committee memberships — only the current period.
  console.log(`[sync] Fetching committee memberships (WP${currentPeriod.wp})...`);
  const currentMandateIds = new Set(
    politicians.filter(p => p._mandateId).map(p => p._mandateId!)
  );
  const committeeMemberships = await fetchCommitteeMemberships(currentMandateIds);
  console.log(`[sync] Got committee memberships for ${committeeMemberships.size} politicians`);

  for (const p of politicians) {
    const committees = committeeMemberships.get(p._mandateId ?? 0) ?? [];
    if (committees.length > 0) {
      p.committees = committees;
      p.types = committeesToTypes(committees);
    }
  }

  // Only fetch images for politicians that don't have one yet.
  console.log('[sync] Fetching Wikidata portrait images...');
  await enrichImages(politicians);

  const json = JSON.stringify(politicians.map(stripInternals));
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, json, 'utf-8');

  const compressed = await gzipAsync(Buffer.from(json, 'utf-8'));
  await fs.writeFile(outputPath + '.gz', compressed);
  console.log(`[sync] Done — wrote ${politicians.length} politicians to ${outputPath} (${compressed.length} bytes gzipped)`);
  return politicians.length;
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchJSON<T>(url: string, retries = 3): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 1s, 2s, 4s, capped at 16s
      const delay = Math.min(1_000 * 2 ** (attempt - 1), 16_000);
      console.warn(`[sync] Backing off ${delay}ms before retry ${attempt}/${retries}...`);
      await sleep(delay);
    }

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': 'Polidex/1.0' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // Network error / timeout — retry
      if (attempt < retries) continue;
      throw new Error(`[sync] Network error after ${retries} retries: ${url}`);
    }

    // Retry on rate-limit or transient server errors
    if ((res.status === 429 || res.status >= 500) && attempt < retries) continue;

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.json() as Promise<T>;
  }
  throw new Error(`[sync] Gave up after ${retries} retries: ${url}`);
}

// ─── Abgeordnetenwatch: parliament periods ────────────────────────────────────

interface AwParliamentPeriod {
  id: number;
  label: string;
  /** ISO date string or null if the period is still ongoing. */
  end_date_period: string | null;
}

interface AwParliamentPeriodList {
  meta: { result: { total: number } };
  data: AwParliamentPeriod[];
}

/**
 * Fetches all full mandate periods for the Bundestag (excludes "Wahl" periods
 * which are short election windows without active MdBs).
 * Returns periods sorted oldest-first; the most recent period is flagged
 * activeOnly=true so only currently active mandates are included.
 * This makes the sync forward-compatible: future periods are discovered
 * automatically without code changes.
 */
async function fetchParliamentPeriods(): Promise<Array<{ periodId: number; wp: number; activeOnly: boolean }>> {
  const url = `${AW_API}/parliament-periods?parliament=${AW_BUNDESTAG_PARLIAMENT}`;
  const res = await fetchJSON<AwParliamentPeriodList>(url);

  // Keep only full mandate periods (labels like "Bundestag 2005 - 2009").
  // "Wahl" periods are short election windows — skip them.
  const mandate = res.data
    .filter(p => !p.label.includes('Wahl'))
    .sort((a, b) => a.id - b.id);   // ascending = oldest first

  if (mandate.length === 0) throw new Error('[sync] No mandate periods found from AW API');

  // Derive a sequential WP number: the oldest available period gets the base
  // number, subsequent ones increment. We use WP16 as the anchor for period
  // ID 67 (first available); if earlier periods are ever added to AW they'll
  // extend the range automatically.
  const FIRST_PERIOD_ID = 67;
  const FIRST_WP        = 16;
  const idToWp = (id: number) => FIRST_WP + mandate.findIndex(p => p.id === id);

  const mostRecentId = mandate[mandate.length - 1].id;

  return mandate.map(p => ({
    periodId:   p.id,
    wp:         idToWp(p.id),
    activeOnly: p.id === mostRecentId,
  }));
}

// ─── Abgeordnetenwatch: mandates ──────────────────────────────────────────────

interface AwMandate {
  id: number;
  type: string;
  end_date: string | null;
  politician: { id: number };
  fraction_membership: Array<{
    fraction: { label: string };
    valid_until: string | null;
  }>;
}

interface AwMandateList {
  meta: { result: { total: number } };
  data: AwMandate[];
}

/**
 * Fetches mandates for a specific parliament period.
 * activeOnly=true keeps only mandates with end_date===null (current WP21).
 * For historical periods (activeOnly=false) all mandates are included.
 * Deduplicates by politician ID within the period.
 */
async function fetchMandates(periodId: number, activeOnly: boolean): Promise<AwMandate[]> {
  const out: AwMandate[] = [];
  let page = 0;
  let total = Infinity;

  while (out.length < total) {
    const url = `${AW_API}/candidacies-mandates?parliament_period=${periodId}&type=mandate&page=${page}&pager_limit=100`;
    const res = await fetchJSON<AwMandateList>(url);
    if (total === Infinity) total = res.meta.result.total;
    if (res.data.length === 0) break;
    const batch = activeOnly
      ? res.data.filter(m => m.end_date === null)
      : res.data;
    out.push(...batch);
    page++;
    if (out.length < total) await sleep(200);
  }

  // Deduplicate by politician ID (same person may have multiple mandate records).
  const seen = new Set<number>();
  return out.filter(m => {
    if (seen.has(m.politician.id)) return false;
    seen.add(m.politician.id);
    return true;
  });
}

// ─── Abgeordnetenwatch: politician details ────────────────────────────────────

interface AwPolitician {
  id: number;
  first_name: string;
  last_name: string;
  field_title: string | null;
  qid_wikidata: string | null;
  ext_id_bundestagsverwaltung: string | null;
  statistic_questions: number | null;
}

// Internal type: carries Wikidata QID, AW IDs, and source WP for merge logic.
type PoliticianWithInternals = PoliticianData & {
  _qid?: string;
  _awId: number;
  _mandateId?: number;
  _wp: number;
};

async function fetchPoliticianDetails(
  mandates: AwMandate[],
  wp: number,
): Promise<PoliticianWithInternals[]> {
  const BATCH = 20;
  const results: PoliticianWithInternals[] = [];

  for (let i = 0; i < mandates.length; i += BATCH) {
    const batch = mandates.slice(i, i + BATCH);
    const settled = await Promise.allSettled(
      batch.map(m => fetchJSON<{ data: AwPolitician }>(`${AW_API}/politicians/${m.politician.id}`))
    );

    for (let j = 0; j < batch.length; j++) {
      const result = settled[j];
      if (result.status === 'rejected') {
        console.warn(`[sync]   failed politician ${batch[j].politician.id}: ${result.reason}`);
        continue;
      }
      const p = result.value.data;
      const faction = normalizeFaction(activeFraction(batch[j]));
      results.push({
        id:              String(p.ext_id_bundestagsverwaltung ?? p.id),
        firstName:       p.first_name,
        lastName:        p.last_name,
        title:           p.field_title ?? undefined,
        faction,
        committees:      [],
        types:           factionToTypes(faction),
        isCommonSurname: COMMON_SURNAMES.has(p.last_name),
        mediaScore:      p.statistic_questions ?? 0,
        periodsActive:   [],  // set by caller
        _qid:            p.qid_wikidata ?? undefined,
        _awId:           p.id,
        _mandateId:      batch[j].id,
        _wp:             wp,
      });
    }

    if ((i + BATCH) % 100 === 0) {
      console.log(`[sync]   details: ${Math.min(i + BATCH, mandates.length)}/${mandates.length}`);
    }
    await sleep(100);
  }

  return results;
}

/**
 * Returns the most relevant fraction label for a mandate.
 * For active mandates (valid_until===null), uses the current fraction.
 * For historical mandates, uses the most recently ended fraction.
 */
function activeFraction(mandate: AwMandate): string {
  const active = mandate.fraction_membership.find(fm => fm.valid_until === null);
  if (active) return active.fraction.label;
  // Historical mandate: sort by valid_until descending, take the latest.
  const sorted = [...mandate.fraction_membership].sort((a, b) => {
    if (!a.valid_until) return 1;
    if (!b.valid_until) return -1;
    return b.valid_until.localeCompare(a.valid_until);
  });
  return sorted[0]?.fraction.label ?? '';
}

function stripInternals({ _qid: _q, _awId: _a, _mandateId: _m, _wp: _w, ...p }: PoliticianWithInternals): PoliticianData {
  return p;
}

// ─── Abgeordnetenwatch: committee memberships ─────────────────────────────────

interface AwCommitteeMembership {
  candidacy_mandate: { id: number };
  committee: { label: string };
}

interface AwCommitteeMembershipList {
  meta: { result: { total: number } };
  data: AwCommitteeMembership[];
}

/**
 * Fetches committee memberships for the given set of mandate IDs.
 * Returns a map of mandate ID → list of committee labels.
 *
 * The parliament_period filter on /committee-memberships returns HTTP 500
 * (confirmed AW API bug), so we fetch all pages and filter locally by mandate ID.
 */
async function fetchCommitteeMemberships(mandateIds: Set<number>): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  let page = 0;
  let total = Infinity;
  let fetched = 0;

  while (fetched < total) {
    const url = `${AW_API}/committee-memberships?pager_limit=1000&page=${page}`;
    let res: AwCommitteeMembershipList;
    try {
      res = await fetchJSON<AwCommitteeMembershipList>(url);
    } catch (err) {
      console.warn(`[sync] Committee memberships page ${page} failed:`, err);
      break;
    }

    if (total === Infinity) total = res.meta.result.total;
    if (res.data.length === 0) break;

    for (const m of res.data) {
      const mandateId = m.candidacy_mandate?.id;
      const label = m.committee?.label;
      if (!mandateId || !label || !mandateIds.has(mandateId)) continue;
      if (!out.has(mandateId)) out.set(mandateId, []);
      out.get(mandateId)!.push(label);
    }

    fetched += res.data.length;
    page++;
    if (fetched < total) await sleep(200);
  }

  return out;
}

// ─── Manual image overrides ───────────────────────────────────────────────────
// Fallback image URLs for politicians not covered by Wikidata (no P18 claim).
// Key: qid_wikidata value from Abgeordnetenwatch API.

const MANUAL_IMAGE_OVERRIDES: Record<string, string> = {
  // Thomas Stephan (AfD) — no Wikidata portrait
  Q132733597: 'https://www.abgeordnetenwatch.de/sites/default/files/politicians-profile-pictures/tom2-mit-hintergrund1.png',
};

// ─── Wikidata images ──────────────────────────────────────────────────────────

async function enrichImages(politicians: PoliticianWithInternals[]): Promise<void> {
  const withQid = politicians.filter(p => p._qid && !p.imageUrl);
  const BATCH = 50;

  for (let i = 0; i < withQid.length; i += BATCH) {
    const batch  = withQid.slice(i, i + BATCH);
    const qids   = batch.map(p => p._qid!);
    const images = await fetchWikidataImages(qids);
    for (const p of batch) {
      if (!p._qid) continue;
      if (images[p._qid]) {
        p.imageUrl = images[p._qid];
      } else if (MANUAL_IMAGE_OVERRIDES[p._qid]) {
        p.imageUrl = MANUAL_IMAGE_OVERRIDES[p._qid];
      }
    }
    if ((i + BATCH) % 200 === 0) {
      console.log(`[sync]   images: ${Math.min(i + BATCH, withQid.length)}/${withQid.length}`);
    }
    await sleep(100);
  }
}

interface WikidataResponse {
  entities: Record<string, {
    claims?: { P18?: Array<{ mainsnak: { datavalue?: { value: string } } }> };
  }>;
}

async function fetchWikidataImages(qids: string[]): Promise<Record<string, string>> {
  if (qids.length === 0) return {};
  const url = `${WD_API}?action=wbgetentities&ids=${qids.join('|')}&props=claims&format=json&origin=*`;
  try {
    const res = await fetchJSON<WikidataResponse>(url);
    const out: Record<string, string> = {};
    for (const [qid, entity] of Object.entries(res.entities)) {
      const filename = entity.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
      if (filename) {
        const encoded = encodeURIComponent(filename.replace(/ /g, '_'));
        out[qid] = `${WC_PATH}/${encoded}`;
      }
    }
    return out;
  } catch {
    return {};
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeFaction(raw: string): Faction {
  const u = raw.toUpperCase();
  if (u.includes('SPD'))                                      return 'SPD';
  if (u.includes('CDU') && u.includes('CSU'))                 return 'CDU/CSU';
  if (u.includes('CDU'))                                      return 'CDU';
  if (u.includes('CSU'))                                      return 'CSU';
  if (u.includes('GRÜNE') || u.includes('GRÜNEN') ||
      u.includes('BÜNDNIS 90'))                               return 'GRÜNE';
  if (u.includes('FDP'))                                      return 'FDP';
  if (u.includes('AFD'))                                      return 'AfD';
  if (u.includes('BSW'))                                      return 'BSW';
  if (u.includes('LINKE') || u.includes('LINKSPARTEI') ||
      u.includes('PDS')   || u.includes('WASG'))             return 'Die Linke';
  return 'fraktionslos';
}

function factionToTypes(faction: Faction): PolidexType[] {
  const map: Partial<Record<Faction, PolidexType[]>> = {
    SPD:         ['Social'],
    CDU:         ['Economy'],
    CSU:         ['Economy'],
    'CDU/CSU':   ['Economy'],
    'GRÜNE':     ['Green'],
    FDP:         ['Economy'],
    AfD:         ['Defense'],
    BSW:         ['Social'],
    'Die Linke': ['Social'],
  };
  return map[faction] ?? ['Social'];
}
