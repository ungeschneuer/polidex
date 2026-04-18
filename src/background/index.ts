/**
 * Background Service Worker — Manifest V3
 *
 * Responsibilities:
 * - Handles messages from content script and popup
 * - Runs politician data sync on alarm
 * - Manages game state (catch, XP, leveling, streak, achievements)
 */

import browser from 'webextension-polyfill';
import type {
  ExtensionMessage,
  ScanPageMessage,
  CatchPoliticianMessage,
  ImportCollectionMessage,
  ArticleStatusMessage,
  PokedexEntry,
  CaughtPolitician,
  MatchCandidate,
  PoliticianData,
  AllPoliticiansDataMessage,
  GameStateDataMessage,
  StreakData,
} from '../types/index.js';
import { hashArticle } from '../shared/hash.js';
import {
  calcLevel,
  calcMediaPresence,
  calcLongevity,
  XP_PER_ARTICLE,
  XP_MULTI_MENTION_BONUS,
  POLITICIANS_SYNC_INTERVAL_MS,
  POLITICIANS_SYNC_MIN_AGE_MS,
  POLITICIANS_SYNC_JITTER_MS,
  getStreakMultiplier,
  ACHIEVEMENTS,
  POLIDEX_SERVER_URL,
} from '../shared/constants.js';
import { findMatches } from './matcher.js';
import { fetchPoliticiansFromServer, loadBundledPoliticians, fetchDomainLists } from './api.js';
import * as Store from './storage.js';

// ─── In-memory cache ──────────────────────────────────────────────────────────

let politiciansCache: PoliticianData[] | null = null;
let politicianMap: Map<string, PoliticianData> | null = null;

async function getPoliticiansCached(): Promise<PoliticianData[]> {
  if (!politiciansCache) {
    politiciansCache = await Store.getPoliticians();
    politicianMap = new Map(politiciansCache.map(p => [p.id, p]));
  }
  return politiciansCache;
}

function getPoliticianById(id: string): PoliticianData | undefined {
  return politicianMap?.get(id);
}

function invalidateCache(): void {
  politiciansCache = null;
  politicianMap = null;
}

// ─── Sync state ───────────────────────────────────────────────────────────────

let syncInProgress = false;

// ─── Sync scheduling ──────────────────────────────────────────────────────────

/**
 * Schedule the next sync alarm as a one-shot with random jitter.
 * Using a one-shot alarm (instead of periodInMinutes) means each client
 * independently picks its next fire time, preventing thundering-herd bursts
 * where many users installed around the same time all hit the server together.
 *
 * Each call produces a unique delay in [INTERVAL, INTERVAL + JITTER], so
 * the per-client schedule drifts slightly each cycle and stays permanently
 * spread across the jitter window.
 */
function scheduleNextSync(): void {
  const jitterMs    = Math.random() * POLITICIANS_SYNC_JITTER_MS;
  const delayMinutes = (POLITICIANS_SYNC_INTERVAL_MS + jitterMs) / 60_000;
  browser.alarms.create('syncPoliticians', { delayInMinutes: delayMinutes });
}

// ─── Installation / startup ───────────────────────────────────────────────────

browser.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    const bundled = await loadBundledPoliticians();
    if (bundled && bundled.length > 0) {
      await Store.setPoliticians(bundled);
      invalidateCache();
      console.log(`[Polidex] Seeded ${bundled.length} politicians from bundled data`);
    }
    syncPoliticians(true).catch(err => console.warn('[Polidex] Initial sync failed:', err));
    browser.tabs.create({ url: browser.runtime.getURL('welcome.html') });
  }

  if (reason === 'update') {
    // Re-apply the bundled snapshot immediately so any new required fields
    // (e.g. periodsActive) are present in storage before any UI interaction.
    // Without this, stored politicians from the previous schema cause TypeErrors
    // until the next scheduled sync fires (up to 26 h later).
    const bundled = await loadBundledPoliticians();
    if (bundled && bundled.length > 0) {
      await Store.setPoliticians(bundled);
      invalidateCache();
      console.log(`[Polidex] Re-applied bundled politicians after update (${bundled.length} entries)`);
    }
    // Then pull the freshest data from the server.
    syncPoliticians(true).catch(err => console.warn('[Polidex] Post-update sync failed:', err));
  }

  // Replace any existing sync alarm (including old periodInMinutes-based alarms
  // from previous versions) with a fresh jittered one-shot alarm.
  scheduleNextSync();
  browser.alarms.create('pruneArticles', {
    periodInMinutes: 60, // hourly check
  });
});

browser.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === 'syncPoliticians') {
    // Reschedule BEFORE syncing so that a service worker crash during sync
    // doesn't orphan the alarm and leave the client without future syncs.
    scheduleNextSync();
    await syncPoliticians();
  }
  if (alarm.name === 'pruneArticles') await Store.pruneOldArticles();
});

// ─── Message handling ─────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((rawMessage: unknown, sender, sendResponse) => {
  const message = rawMessage as ExtensionMessage;
  if (message.type === 'ARTICLE_STATUS') {
    handleArticleStatus(message, sender.tab?.id);
    sendResponse(null);
  } else {
    handleMessage(message).then(sendResponse).catch(err => {
      console.error('[Polidex] Message handler error:', err);
      sendResponse({ error: String(err) });
    });
  }
  return true;
});

async function handleMessage(message: ExtensionMessage): Promise<unknown> {
  switch (message.type) {
    case 'SCAN_PAGE':             return handleScanPage(message);
    case 'CATCH_POLITICIAN':      return handleCatch(message);
    case 'GET_POKEDEX':           return handleGetPokedex();
    case 'GET_ALL_POLITICIANS':   return handleGetAllPoliticians();
    case 'SYNC_POLITICIANS':      return syncPoliticians(true); // manual always forces
    case 'GET_SYNC_STATUS':       return handleGetSyncStatus();
    case 'IMPORT_COLLECTION':     return handleImportCollection(message);
    case 'GET_GAME_STATE':        return handleGetGameState();
    default: return { error: 'Unknown message type' };
  }
}

// ─── Scan ─────────────────────────────────────────────────────────────────────

async function handleScanPage(message: ScanPageMessage) {
  const { content } = message;
  const hash = await hashArticle(content.url, content.headline);

  const alreadyScanned = await Store.isArticleScanned(hash);
  const politicians = await getPoliticiansCached();

  if (politicians.length === 0) {
    return { type: 'SCAN_RESULT', candidates: [], alreadyScanned, articleHash: hash };
  }

  const candidates = findMatches(politicians, content);

  let newAchievements: string[] = [];
  let streak: StreakData | undefined;

  if (!alreadyScanned && candidates.length > 0) {
    const result = await awardXpFromScan(candidates, hash, content);
    newAchievements = result.newAchievements;
    streak = result.streak;
  } else if (!alreadyScanned) {
    // Still save article (no politicians found, no streak update)
    await Store.saveArticle({
      hash,
      url: content.url,
      title: content.headline,
      scannedAt: Date.now(),
      politicianIds: [],
    });
  }

  return {
    type: 'SCAN_RESULT',
    candidates,
    alreadyScanned,
    articleHash: hash,
    newAchievements,
    streak,
  };
}

async function awardXpFromScan(
  candidates: MatchCandidate[],
  hash: string,
  content: { url: string; headline: string }
): Promise<{ newAchievements: string[]; streak: StreakData }> {
  const caught = await Store.getCaught();
  const politicianIds: string[] = [];

  // Update streak first (so multiplier is based on updated streak)
  const streak = await updateStreak();
  const multiplier = getStreakMultiplier(streak.current);

  for (const candidate of candidates) {
    const id = candidate.politician.id;
    politicianIds.push(id);

    if (id in caught) {
      const entry = caught[id];
      const bonus = candidate.mentionCount > 1 ? XP_MULTI_MENTION_BONUS : 0;
      const baseXp = Math.round((XP_PER_ARTICLE + bonus) * multiplier);
      entry.xp += baseXp;
      entry.level = calcLevel(entry.xp);
      entry.articleCount++;
      entry.lastSeenAt = Date.now();
      await Store.saveCaught(entry);
    }
  }

  await Store.saveArticle({
    hash,
    url: content.url,
    title: content.headline,
    scannedAt: Date.now(),
    politicianIds,
  });

  const newAchievements = await checkScanAchievements(streak);
  return { newAchievements, streak };
}

// ─── Streak ───────────────────────────────────────────────────────────────────

function todayDate(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function yesterdayDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function updateStreak(): Promise<StreakData> {
  const streak = await Store.getStreak();
  const today = todayDate();

  if (streak.lastScanDate === today) {
    return streak; // already scanned today, no change
  }

  if (streak.lastScanDate === yesterdayDate()) {
    streak.current++;
  } else {
    streak.current = 1; // reset (gap > 1 day)
  }

  if (streak.current > streak.longest) streak.longest = streak.current;
  streak.lastScanDate = today;
  await Store.setStreak(streak);
  return streak;
}

// ─── Catch ────────────────────────────────────────────────────────────────────

async function handleCatch(message: CatchPoliticianMessage) {
  const { politicianId, articleHash } = message;

  const alreadyCaught = await Store.isCaught(politicianId);
  if (alreadyCaught) {
    const existing = await Store.getCaughtById(politicianId);
    const data = getPoliticianById(politicianId);
    return {
      type: 'CATCH_RESULT',
      success: false,
      alreadyCaught: true,
      entry: data ? mergeEntry(existing!, data) : undefined,
    };
  }

  const politicians = await getPoliticiansCached();
  const data = politicians.find(p => p.id === politicianId);
  if (!data) {
    return { type: 'CATCH_RESULT', success: false, alreadyCaught: false, error: 'Unknown politician' };
  }

  const initialXp = 1;
  const entry: CaughtPolitician = {
    id: politicianId,
    xp: initialXp,
    level: calcLevel(initialXp),
    caughtAt: Date.now(),
    articleCount: 1,
    lastSeenAt: Date.now(),
    caughtUrl:          message.articleUrl,
    caughtTitle:        message.articleTitle,
    caughtInHeadline:   message.inHeadline ?? false,
  };
  await Store.saveCaught(entry);

  const article = await Store.getArticleByHash(articleHash);
  if (!article) {
    await Store.saveArticle({
      hash: articleHash,
      url: '',
      title: '',
      scannedAt: Date.now(),
      politicianIds: [politicianId],
    });
  }

  const newAchievements = await checkCatchAchievements(entry, data);

  return {
    type: 'CATCH_RESULT',
    success: true,
    alreadyCaught: false,
    entry: mergeEntry(entry, data),
    xpGained: initialXp,
    newAchievements,
  };
}

// ─── Achievement checking ─────────────────────────────────────────────────────

async function checkCatchAchievements(
  entry: CaughtPolitician,
  data: PoliticianData
): Promise<string[]> {
  const caught = await Store.getCaught();
  const totalCaught = Object.keys(caught).length;
  const unlocked: string[] = [];

  const candidates: Array<{ id: string; cond: boolean }> = [
    { id: 'first_catch',        cond: totalCaught === 1 },
    { id: 'ten_caught',         cond: totalCaught >= 10 },
    { id: 'fifty_caught',       cond: totalCaught >= 50 },
    { id: 'hundred_caught',     cond: totalCaught >= 100 },
    { id: 'two_hundred_caught', cond: totalCaught >= 200 },
    { id: 'catch_epic',       cond: calcMediaPresence(data.mediaScore) === 'OBSCURE' },
    { id: 'catch_headline',   cond: entry.caughtInHeadline === true },
    { id: 'catch_veteran',    cond: ['VETERAN', 'LEGEND'].includes(calcLongevity(data.periodsActive ?? [])) },
    { id: 'catch_legend',     cond: calcLongevity(data.periodsActive ?? []) === 'LEGEND' },
    { id: 'catch_historical', cond: !(data.periodsActive ?? []).includes(21) },
  ];

  for (const { id, cond } of candidates) {
    if (cond && await Store.unlockAchievement(id)) {
      unlocked.push(id);
    }
  }

  // all_periods: check if we now have at least one catch from every available period.
  if (await checkAllPeriodsAchievement(caught)) {
    if (await Store.unlockAchievement('all_periods')) unlocked.push('all_periods');
  }

  // type_collector: 8+ distinct types across all caught politicians.
  const allTypes = new Set<string>();
  for (const id of Object.keys(caught)) {
    const pd = getPoliticianById(id);
    if (pd) pd.types.forEach(t => allTypes.add(t));
  }
  if (allTypes.size >= 8 && await Store.unlockAchievement('type_collector')) unlocked.push('type_collector');

  // faction_sweep: at least one politician from each of the 7 active factions.
  const REQUIRED_FACTIONS = ['SPD', 'CDU/CSU', 'GRÜNE', 'FDP', 'AfD', 'BSW', 'Die Linke'];
  const caughtFactions = new Set<string>(
    Object.keys(caught).map(id => getPoliticianById(id)?.faction).filter((f): f is NonNullable<typeof f> => f != null)
  );
  if (REQUIRED_FACTIONS.every(f => caughtFactions.has(f)) && await Store.unlockAchievement('faction_sweep')) {
    unlocked.push('faction_sweep');
  }

  // five_obscure: 5+ caught politicians with OBSCURE media presence.
  const obscureCount = Object.keys(caught).filter(id => {
    const pd = getPoliticianById(id);
    return pd && calcMediaPresence(pd.mediaScore) === 'OBSCURE';
  }).length;
  if (obscureCount >= 5 && await Store.unlockAchievement('five_obscure')) unlocked.push('five_obscure');

  return unlocked;
}

/**
 * Returns true when the caught collection includes at least one politician
 * from each of the 6 Wahlperioden available (WP16–WP21).
 */
async function checkAllPeriodsAchievement(caught: Record<string, CaughtPolitician>): Promise<boolean> {
  const politicians = await getPoliticiansCached();
  const caughtIds = new Set(Object.keys(caught));
  const coveredPeriods = new Set<number>();
  for (const p of politicians) {
    if (caughtIds.has(p.id)) {
      for (const wp of (p.periodsActive ?? [])) coveredPeriods.add(wp);
    }
  }
  // Require all 6 periods WP16–WP21 to be covered.
  for (let wp = 16; wp <= 21; wp++) {
    if (!coveredPeriods.has(wp)) return false;
  }
  return true;
}

async function checkScanAchievements(streak: StreakData): Promise<string[]> {
  const articleCount = await Store.getArticleCount();
  const caught = await Store.getCaught();
  const unlocked: string[] = [];

  // Check max level across all caught politicians
  const maxLevel = Object.values(caught).reduce((max, e) => Math.max(max, e.level), 0);

  const candidates: Array<{ id: string; cond: boolean }> = [
    { id: 'ten_articles',    cond: articleCount >= 10 },
    { id: 'fifty_articles',  cond: articleCount >= 50 },
    { id: 'hundred_articles',cond: articleCount >= 100 },
    { id: 'streak_3',        cond: streak.current >= 3 },
    { id: 'streak_7',        cond: streak.current >= 7 },
    { id: 'streak_30',       cond: streak.current >= 30 },
    { id: 'level_5',         cond: maxLevel >= 5 },
    { id: 'level_10',        cond: maxLevel >= 10 },
    { id: 'level_20',        cond: maxLevel >= 20 },
    { id: 'total_xp_500',   cond: Object.values(caught).reduce((s, e) => s + e.xp, 0) >= 500 },
  ];

  for (const { id, cond } of candidates) {
    if (cond && await Store.unlockAchievement(id)) {
      unlocked.push(id);
    }
  }
  return unlocked;
}

// Suppress unused import warning
void ACHIEVEMENTS;

// ─── Pokedex ──────────────────────────────────────────────────────────────────

async function handleGetPokedex() {
  const [caught, politicians] = await Promise.all([Store.getCaught(), getPoliticiansCached()]);
  const dataMap = new Map(politicians.map(p => [p.id, p]));

  const entries: PokedexEntry[] = Object.values(caught)
    .map(c => {
      const data = dataMap.get(c.id);
      return data ? mergeEntry(c, data) : null;
    })
    .filter((e): e is PokedexEntry => e !== null)
    .sort((a, b) => b.caughtAt - a.caughtAt);

  return {
    type: 'POKEDEX_DATA',
    entries,
    totalCaught: entries.length,
  };
}

// ─── Badge ────────────────────────────────────────────────────────────────────

const BADGE_COLOR_ARTICLE = '#e94560';

function handleArticleStatus(message: ArticleStatusMessage, tabId: number | undefined) {
  if (tabId === undefined) return;
  if (message.isArticle) {
    browser.action.setBadgeText({ text: '!', tabId });
    browser.action.setBadgeBackgroundColor({ color: BADGE_COLOR_ARTICLE, tabId });
  } else {
    browser.action.setBadgeText({ text: '', tabId });
  }
}

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    browser.action.setBadgeText({ text: '', tabId });
  }
});

async function handleGetAllPoliticians(): Promise<AllPoliticiansDataMessage> {
  const politicians = await getPoliticiansCached();
  return { type: 'ALL_POLITICIANS_DATA', politicians };
}

function mergeEntry(caught: CaughtPolitician, data: PoliticianData): PokedexEntry {
  return { ...data, ...caught };
}

// ─── Game state ───────────────────────────────────────────────────────────────

async function handleGetGameState(): Promise<GameStateDataMessage> {
  const [streak, achievements] = await Promise.all([
    Store.getStreak(),
    Store.getAchievements(),
  ]);
  return { type: 'GAME_STATE_DATA', streak, achievements };
}

// ─── Sync status ──────────────────────────────────────────────────────────────

async function handleGetSyncStatus() {
  const [politicians, lastSyncAt] = await Promise.all([
    getPoliticiansCached(),
    Store.getPoliticiansUpdatedAt(),
  ]);
  return {
    type: 'SYNC_STATUS_DATA',
    politiciansCount: politicians.length,
    lastSyncAt,
    syncInProgress,
  };
}

// ─── Import collection ────────────────────────────────────────────────────────

async function handleImportCollection(message: ImportCollectionMessage) {
  try {
    const imported = await Store.importCollection(message.caught);
    return { type: 'IMPORT_RESULT', imported };
  } catch (err) {
    return { type: 'IMPORT_RESULT', imported: 0, error: String(err) };
  }
}

// ─── Data sync ────────────────────────────────────────────────────────────────

async function syncPoliticians(force = false): Promise<{ synced: number }> {
  if (syncInProgress) return { synced: 0 };

  if (!force) {
    const lastSync = await Store.getPoliticiansUpdatedAt();
    if (Date.now() - lastSync < POLITICIANS_SYNC_MIN_AGE_MS) {
      console.log('[Polidex] Data is fresh — skipping sync');
      return { synced: 0 };
    }
  }

  syncInProgress = true;
  try {
    const storedETag = await Store.getPoliticiansETag();
    const result = await fetchPoliticiansFromServer(storedETag);

    if (result === null) {
      console.log('[Polidex] Politicians up to date (304 Not Modified)');
      await Store.touchPoliticiansUpdatedAt();
      return { synced: 0 };
    }

    await Store.setPoliticians(result.politicians);
    if (result.etag) await Store.setPoliticiansETag(result.etag);
    invalidateCache();

    const { newsDomains, blockedDomains } = await fetchDomainLists(POLIDEX_SERVER_URL);
    if (newsDomains) await Store.setNewsDomains(newsDomains);
    if (blockedDomains) await Store.setBlockedDomains(blockedDomains);

    console.log(`[Polidex] Synced ${result.politicians.length} politicians from server`);
    return { synced: result.politicians.length };
  } catch (err) {
    console.error('[Polidex] Sync failed:', err);
    return { synced: 0 };
  } finally {
    syncInProgress = false;
  }
}
