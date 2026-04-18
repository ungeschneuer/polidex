/**
 * Typed wrapper around browser.storage.local.
 * All reads/writes go through this module so the schema stays consistent.
 */

import browser from 'webextension-polyfill';
import type {
  StorageSchema,
  PoliticianData,
  CaughtPolitician,
  ScannedArticle,
  StreakData,
} from '../types/index.js';

const storage = browser.storage;

// ─── Generic helpers ──────────────────────────────────────────────────────────

async function get<K extends keyof StorageSchema>(key: K): Promise<StorageSchema[K] | undefined> {
  const result = await storage.local.get(key);
  return result[key] as StorageSchema[K] | undefined;
}

async function set<K extends keyof StorageSchema>(key: K, value: StorageSchema[K]): Promise<void> {
  await storage.local.set({ [key]: value });
}

// ─── Politicians (master data) ────────────────────────────────────────────────

export async function getPoliticians(): Promise<PoliticianData[]> {
  return (await get('politicians')) ?? [];
}

export async function setPoliticians(politicians: PoliticianData[]): Promise<void> {
  await set('politicians', politicians);
  await set('politiciansUpdatedAt', Date.now());
}

export async function getPoliticiansUpdatedAt(): Promise<number> {
  return (await get('politiciansUpdatedAt')) ?? 0;
}

export async function touchPoliticiansUpdatedAt(): Promise<void> {
  await set('politiciansUpdatedAt', Date.now());
}

export async function getPoliticiansETag(): Promise<string> {
  return (await get('politiciansETag')) ?? '';
}

export async function setPoliticiansETag(etag: string): Promise<void> {
  await set('politiciansETag', etag);
}

// ─── Caught politicians (game state) ─────────────────────────────────────────

export async function getCaught(): Promise<Record<string, CaughtPolitician>> {
  return (await get('caught')) ?? {};
}

export async function getCaughtById(id: string): Promise<CaughtPolitician | undefined> {
  const caught = await getCaught();
  return caught[id];
}

export async function saveCaught(entry: CaughtPolitician): Promise<void> {
  const caught = await getCaught();
  caught[entry.id] = entry;
  await set('caught', caught);
}

export async function isCaught(id: string): Promise<boolean> {
  const caught = await getCaught();
  return id in caught;
}

// ─── Scanned articles ─────────────────────────────────────────────────────────

export async function getArticles(): Promise<Record<string, ScannedArticle>> {
  return (await get('articles')) ?? {};
}

export async function getArticleByHash(hash: string): Promise<ScannedArticle | undefined> {
  const articles = await getArticles();
  return articles[hash];
}

export async function saveArticle(article: ScannedArticle): Promise<void> {
  const articles = await getArticles();
  articles[article.hash] = article;
  await set('articles', articles);
}

export async function isArticleScanned(hash: string): Promise<boolean> {
  const articles = await getArticles();
  return hash in articles;
}

export async function getArticleCount(): Promise<number> {
  const articles = await getArticles();
  return Object.keys(articles).length;
}

// ─── Streak ───────────────────────────────────────────────────────────────────

const DEFAULT_STREAK: StreakData = { current: 0, longest: 0, lastScanDate: '' };

export async function getStreak(): Promise<StreakData> {
  return (await get('streak')) ?? DEFAULT_STREAK;
}

export async function setStreak(streak: StreakData): Promise<void> {
  await set('streak', streak);
}

// ─── Achievements ─────────────────────────────────────────────────────────────

export async function getAchievements(): Promise<Record<string, number>> {
  return (await get('achievements')) ?? {};
}

/**
 * Unlocks an achievement if not already unlocked.
 * Returns true if it was newly unlocked, false if already present.
 */
export async function unlockAchievement(id: string): Promise<boolean> {
  const achievements = await getAchievements();
  if (id in achievements) return false;
  achievements[id] = Date.now();
  await set('achievements', achievements);
  return true;
}

// ─── Domain lists ────────────────────────────────────────────────────────────

export async function getNewsDomains(): Promise<string[]> {
  return (await get('newsDomains')) ?? [];
}

export async function setNewsDomains(domains: string[]): Promise<void> {
  await set('newsDomains', domains);
}

export async function getBlockedDomains(): Promise<string[]> {
  return (await get('blockedDomains')) ?? [];
}

export async function setBlockedDomains(domains: string[]): Promise<void> {
  await set('blockedDomains', domains);
}

// ─── Storage usage ────────────────────────────────────────────────────────────

/** Returns approximate used bytes and the 5MB quota. */
export async function getStorageStats(): Promise<{ usedBytes: number; quotaBytes: number }> {
  const bytesInUse = await storage.local.getBytesInUse?.() ?? 0;
  return {
    usedBytes: bytesInUse,
    quotaBytes: 5_242_880,
  };
}

function isValidCaughtEntry(entry: unknown): entry is CaughtPolitician {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.xp === 'number' && e.xp >= 0 &&
    typeof e.level === 'number' && e.level >= 0 &&
    typeof e.caughtAt === 'number' &&
    typeof e.articleCount === 'number' && e.articleCount >= 0 &&
    typeof e.lastSeenAt === 'number'
  );
}

/**
 * Merges imported caught data into existing storage.
 * New entries are added; existing entries are kept as-is (local progress wins).
 * Invalid entries are skipped. Returns the number of newly imported entries.
 */
export async function importCollection(
  incoming: Record<string, CaughtPolitician>
): Promise<number> {
  const caught = await getCaught();
  let count = 0;
  for (const [id, entry] of Object.entries(incoming)) {
    if (!(id in caught) && isValidCaughtEntry(entry)) {
      caught[id] = entry;
      count++;
    }
  }
  if (count > 0) {
    await set('caught', caught);
  }
  return count;
}

/** Prunes the oldest articles if storage exceeds 80% of quota. */
export async function pruneOldArticles(): Promise<void> {
  const { usedBytes, quotaBytes } = await getStorageStats();
  if (usedBytes < quotaBytes * 0.8) return;

  const articles = await getArticles();
  const sorted = Object.values(articles).sort((a, b) => a.scannedAt - b.scannedAt);
  const toRemove = sorted.slice(0, Math.floor(sorted.length * 0.3));

  for (const article of toRemove) {
    delete articles[article.hash];
  }
  await set('articles', articles);
}
