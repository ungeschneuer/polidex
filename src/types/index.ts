// ─── Politician data (from Bundestag API) ────────────────────────────────────

export type Faction =
  | 'SPD' | 'CDU' | 'CSU' | 'CDU/CSU'
  | 'GRÜNE' | 'FDP' | 'AfD' | 'BSW'
  | 'Die Linke' | 'fraktionslos';

export type PolidexType =
  | 'Economy'    // Finanzausschuss, Wirtschaft
  | 'Green'      // Umwelt, Klimaschutz
  | 'Defense'    // Verteidigung, Sicherheit
  | 'Justice'    // Recht, Verfassung
  | 'Health'     // Gesundheit, Familie
  | 'Diplomat'   // Auswärtiges, Europa
  | 'Tech'       // Digitales, Forschung
  | 'Social'     // Soziales, Arbeit, Bildung
  | 'Infrastructure'; // Bau, Verkehr, Energie

export type MediaPresence = 'PROMINENT' | 'NOTABLE' | 'MINOR' | 'OBSCURE';

export type Longevity = 'NEWCOMER' | 'EXPERIENCED' | 'VETERAN' | 'LEGEND';

/** Raw data fetched from the Bundestag API and stored locally. */
export interface PoliticianData {
  id: string;                    // DIP person ID
  firstName: string;
  lastName: string;
  title?: string;                // "Dr.", "Prof. Dr.", etc.
  faction: Faction;
  types: PolidexType[];
  committees: string[];          // raw committee names from API
  imageUrl?: string;             // Wikipedia fallback
  // Common surnames get a scoring penalty applied during matching
  isCommonSurname: boolean;
  // Approximate media presence score derived from API activity count
  mediaScore: number;
  // Wahlperiode numbers this politician was active in, e.g. [18, 19, 20, 21]
  periodsActive: number[];
}

// ─── Game state ───────────────────────────────────────────────────────────────

export interface CaughtPolitician {
  id: string;
  xp: number;
  level: number;
  caughtAt: number;              // Unix timestamp
  articleCount: number;          // total articles this politician appeared in
  lastSeenAt: number;            // Unix timestamp of last article
  caughtUrl?: string;            // URL of the article where first caught
  caughtTitle?: string;          // Headline of that article
  caughtInHeadline?: boolean;    // Whether caught from a headline mention
}

/** Keyed by politician ID. */
export type PokedexEntry = CaughtPolitician & PoliticianData;

// ─── Streak ───────────────────────────────────────────────────────────────────

export interface StreakData {
  current: number;               // current consecutive day streak
  longest: number;               // all-time longest streak
  lastScanDate: string;          // YYYY-MM-DD of last productive scan
}

// ─── Article tracking ─────────────────────────────────────────────────────────

export interface ScannedArticle {
  hash: string;                  // SHA-256 of (url + title)
  url: string;
  title: string;
  scannedAt: number;
  politicianIds: string[];       // politicians found in this article
}

// ─── Matching ─────────────────────────────────────────────────────────────────

export interface ArticleContent {
  url: string;
  headline: string;
  bodyText: string;
  lang: 'de' | 'en' | 'unknown';
}

export interface MatchCandidate {
  politician: PoliticianData;
  score: number;
  matchedName: string;
  inHeadline: boolean;
  mentionCount: number;
}

// ─── Messaging (content <-> background) ──────────────────────────────────────

export type MessageType =
  | 'SCAN_PAGE'
  | 'SCAN_RESULT'
  | 'CATCH_POLITICIAN'
  | 'CATCH_RESULT'
  | 'GET_POKEDEX'
  | 'POKEDEX_DATA'
  | 'GET_ALL_POLITICIANS'
  | 'ALL_POLITICIANS_DATA'
  | 'SYNC_POLITICIANS'
  | 'GET_SYNC_STATUS'
  | 'SYNC_STATUS_DATA'
  | 'IMPORT_COLLECTION'
  | 'IMPORT_RESULT'
  | 'ARTICLE_STATUS'
  | 'GET_GAME_STATE'
  | 'GAME_STATE_DATA';

export interface SyncPoliticiansMessage { type: 'SYNC_POLITICIANS'; }

export interface ScanPageMessage {
  type: 'SCAN_PAGE';
  content: ArticleContent;
}

export interface ScanResultMessage {
  type: 'SCAN_RESULT';
  candidates: MatchCandidate[];
  alreadyScanned: boolean;
  articleHash: string;
  newAchievements?: string[];    // IDs of achievements unlocked during this scan
  streak?: StreakData;
}

export interface CatchPoliticianMessage {
  type: 'CATCH_POLITICIAN';
  politicianId: string;
  articleHash: string;
  articleUrl?: string;
  articleTitle?: string;
  inHeadline?: boolean;
}

export interface ExtractContentResult {
  content?: ArticleContent;
  blocked?: true;
  notArticle?: true;
}

export interface CatchResultMessage {
  type: 'CATCH_RESULT';
  success: boolean;
  alreadyCaught: boolean;
  entry?: PokedexEntry;
  xpGained?: number;
  newAchievements?: string[];    // IDs of achievements unlocked on this catch
}

export interface GetPokedexMessage {
  type: 'GET_POKEDEX';
}

export interface PokedexDataMessage {
  type: 'POKEDEX_DATA';
  entries: PokedexEntry[];
  totalCaught: number;
}

export interface GetAllPoliticiansMessage { type: 'GET_ALL_POLITICIANS'; }

export interface AllPoliticiansDataMessage {
  type: 'ALL_POLITICIANS_DATA';
  politicians: PoliticianData[];
}

export interface GetSyncStatusMessage { type: 'GET_SYNC_STATUS'; }

export interface SyncStatusDataMessage {
  type: 'SYNC_STATUS_DATA';
  politiciansCount: number;
  lastSyncAt: number;        // Unix timestamp, 0 if never synced
  syncInProgress: boolean;
}

export interface ImportCollectionMessage {
  type: 'IMPORT_COLLECTION';
  /** Serialized caught map, as produced by the export feature. */
  caught: Record<string, CaughtPolitician>;
}

export interface ImportResultMessage {
  type: 'IMPORT_RESULT';
  imported: number;   // number of entries written
  error?: string;
}

export interface ArticleStatusMessage {
  type: 'ARTICLE_STATUS';
  isArticle: boolean;
}

export interface GetGameStateMessage { type: 'GET_GAME_STATE'; }

export interface GameStateDataMessage {
  type: 'GAME_STATE_DATA';
  streak: StreakData;
  achievements: Record<string, number>; // achievement id -> unlock timestamp
}

export type ExtensionMessage =
  | ArticleStatusMessage
  | ScanPageMessage
  | ScanResultMessage
  | CatchPoliticianMessage
  | CatchResultMessage
  | GetPokedexMessage
  | PokedexDataMessage
  | GetAllPoliticiansMessage
  | AllPoliticiansDataMessage
  | SyncPoliticiansMessage
  | GetSyncStatusMessage
  | SyncStatusDataMessage
  | ImportCollectionMessage
  | ImportResultMessage
  | GetGameStateMessage
  | GameStateDataMessage;

// ─── Storage schema ───────────────────────────────────────────────────────────

export interface StorageSchema {
  politicians: PoliticianData[];             // master data from API
  politiciansUpdatedAt: number;              // last sync timestamp
  politiciansETag: string;                   // ETag from server for conditional GET
  caught: Record<string, CaughtPolitician>;  // id -> game state
  articles: Record<string, ScannedArticle>; // hash -> article record
  streak: StreakData;                        // daily scan streak
  achievements: Record<string, number>;      // achievement id -> unlock timestamp
}
