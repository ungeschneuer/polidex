import type { Faction, PolidexType, MediaPresence, Longevity } from '../types/index.js';

// ─── Matching thresholds ──────────────────────────────────────────────────────

export const MATCH_THRESHOLD = 30;

export const SCORE_FULL_NAME = 50;
export const SCORE_SURNAME_PARTY = 20;
export const SCORE_SURNAME_ROLE = 15;
export const SCORE_COMMON_SURNAME_PENALTY = -40;
export const SCORE_HEADLINE_BONUS = 25;
export const SCORE_MULTI_MENTION_BONUS = 5; // per mention after first, capped

// Surnames that appear frequently in German population and cause false positives
export const COMMON_SURNAMES = new Set([
  'Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner',
  'Becker', 'Schulz', 'Hoffmann', 'Schäfer', 'Koch', 'Bauer', 'Richter',
  'Klein', 'Wolf', 'Schröder', 'Neumann', 'Schwarz', 'Zimmermann',
  'Braun', 'Krüger', 'Hofmann', 'Hartmann', 'Lange', 'Schmitt', 'Werner',
  'Schmitz', 'Krause', 'Meier',
]);

// ─── XP / Level ───────────────────────────────────────────────────────────────

export const XP_PER_ARTICLE = 10;
export const XP_MULTI_MENTION_BONUS = 5;

/** Level = floor(sqrt(xp)) */
export function calcLevel(xp: number): number {
  return Math.floor(Math.sqrt(xp));
}

/** XP required to reach a given level. */
export function xpForLevel(level: number): number {
  return level * level;
}

/**
 * XP multiplier based on consecutive scan streak.
 * Increases by 0.1 every 3 days, capped at 2.0.
 * Day 1: 1.0x  |  Day 3: 1.1x  |  Day 6: 1.2x  |  Day 30+: 2.0x
 */
export function getStreakMultiplier(streak: number): number {
  return Math.min(2.0, 1.0 + Math.floor(streak / 3) * 0.1);
}

// ─── Media presence ───────────────────────────────────────────────────────────

/**
 * Media presence is inversely proportional to the politician's activity count.
 * mediaScore is the politician's approximate question count from the API.
 */
export function calcMediaPresence(mediaScore: number): MediaPresence {
  if (mediaScore > 150) return 'PROMINENT';
  if (mediaScore > 40)  return 'NOTABLE';
  if (mediaScore > 10)  return 'MINOR';
  return 'OBSCURE';
}

export const PRESENCE_LABELS: Record<MediaPresence, string> = {
  PROMINENT: 'Sehr präsent',
  NOTABLE:   'Präsent',
  MINOR:     'Wenig präsent',
  OBSCURE:   'Kaum bekannt',
};

export const TYPE_LABELS: Record<PolidexType, string> = {
  Economy:        'Wirtschaft',
  Green:          'Umwelt',
  Defense:        'Verteidigung',
  Justice:        'Recht',
  Health:         'Gesundheit',
  Diplomat:       'Außenpolitik',
  Tech:           'Digital',
  Social:         'Soziales',
  Infrastructure: 'Infrastruktur',
};

export const PRESENCE_COLORS: Record<MediaPresence, string> = {
  PROMINENT: '#9e9e9e',
  NOTABLE:   '#4caf50',
  MINOR:     '#2196f3',
  OBSCURE:   '#9c27b0',
};

// ─── Longevity ────────────────────────────────────────────────────────────────

/**
 * Longevity is based on the number of Wahlperioden a politician was active in.
 * Covers WP16–WP21 (6 periods available via Abgeordnetenwatch).
 */
export function calcLongevity(periodsActive: number[]): Longevity {
  const n = periodsActive.length;
  if (n >= 6) return 'LEGEND';
  if (n >= 4) return 'VETERAN';
  if (n >= 2) return 'EXPERIENCED';
  return 'NEWCOMER';
}

export const LONGEVITY_LABELS: Record<Longevity, string> = {
  NEWCOMER:    'Neuling',
  EXPERIENCED: 'Routinier',
  VETERAN:     'Veteran',
  LEGEND:      'Urgestein',
};

export const LONGEVITY_COLORS: Record<Longevity, string> = {
  NEWCOMER:    '#8888aa',
  EXPERIENCED: '#4caf50',
  VETERAN:     '#f5a623',
  LEGEND:      '#e94560',
};

// ─── Type mapping ─────────────────────────────────────────────────────────────

/**
 * Maps committee name fragments (lowercase) to PolidexTypes.
 * Order matters: first match wins for the primary type.
 */
export const COMMITTEE_TYPE_MAP: Array<{ keywords: string[]; type: PolidexType }> = [
  { keywords: ['finanzen', 'haushalt', 'wirtschaft', 'finance', 'budget'],            type: 'Economy' },
  { keywords: ['umwelt', 'klima', 'naturschutz', 'environment', 'climate'],           type: 'Green' },
  { keywords: ['verteidigung', 'sicherheit', 'defence', 'defense'],                   type: 'Defense' },
  { keywords: ['recht', 'verfassung', 'justiz', 'justice', 'legal'],                  type: 'Justice' },
  { keywords: ['gesundheit', 'familie', 'health', 'family'],                          type: 'Health' },
  { keywords: ['auswärtig', 'europa', 'außenpolitik', 'foreign', 'europe'],           type: 'Diplomat' },
  { keywords: ['digital', 'forschung', 'technologie', 'innovation', 'research'],     type: 'Tech' },
  { keywords: ['sozial', 'arbeit', 'bildung', 'labour', 'education', 'welfare'],     type: 'Social' },
  { keywords: ['bau', 'verkehr', 'energie', 'infrastructure', 'transport', 'energy'], type: 'Infrastructure' },
];

export function committeesToTypes(committees: string[]): PolidexType[] {
  const types = new Set<PolidexType>();
  for (const committee of committees) {
    const lower = committee.toLowerCase();
    for (const { keywords, type } of COMMITTEE_TYPE_MAP) {
      if (keywords.some(kw => lower.includes(kw))) {
        types.add(type);
      }
    }
  }
  return types.size > 0 ? Array.from(types) : ['Social']; // default fallback
}

// ─── Achievements ─────────────────────────────────────────────────────────────

export interface AchievementDef {
  id: string;
  name: string;
  description: string;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first_catch',       name: 'Erster Fang',        description: 'Fange deinen ersten Politiker.' },
  { id: 'ten_caught',        name: 'Sammler',             description: 'Fange 10 Politiker.' },
  { id: 'fifty_caught',      name: 'Volksvertreter',      description: 'Fange 50 Politiker.' },
  { id: 'hundred_caught',    name: 'Parlamentarier',      description: 'Fange 100 Politiker.' },
  { id: 'two_hundred_caught',name: 'Bundestagskenner',    description: 'Fange 200 Politiker.' },
  { id: 'ten_articles',      name: 'Fleißiger Leser',     description: 'Scanne 10 Artikel mit Ergebnissen.' },
  { id: 'fifty_articles',    name: 'Nachrichtenfan',      description: 'Scanne 50 Artikel mit Ergebnissen.' },
  { id: 'hundred_articles',  name: 'Medienexperte',       description: 'Scanne 100 Artikel mit Ergebnissen.' },
  { id: 'streak_3',          name: 'Tagesroutine',        description: 'Erreiche eine 3-Tage-Scan-Serie.' },
  { id: 'streak_7',          name: 'Wochenlauf',          description: 'Erreiche eine 7-Tage-Scan-Serie.' },
  { id: 'streak_30',         name: 'Monatsserie',         description: 'Erreiche eine 30-Tage-Scan-Serie.' },
  { id: 'catch_epic',        name: 'Randfigur',            description: 'Fange einen Politiker mit sehr geringer Medienpräsenz.' },
  { id: 'catch_headline',    name: 'Schlagzeilenjäger',   description: 'Fange einen Politiker aus einer Schlagzeile.' },
  { id: 'level_5',           name: 'Aufsteiger',          description: 'Bringe einen Politiker auf Level 5.' },
  { id: 'level_10',          name: 'Meister',             description: 'Bringe einen Politiker auf Level 10.' },
  { id: 'catch_veteran',     name: 'Parlamentsveteran',   description: 'Fange einen Politiker, der mindestens 4 Wahlperioden aktiv war.' },
  { id: 'catch_legend',      name: 'Urgestein',           description: 'Fange einen Politiker, der mindestens 6 Wahlperioden aktiv war.' },
  { id: 'catch_historical',  name: 'Zeitreisender',       description: 'Fange einen Politiker aus einer vergangenen Wahlperiode (vor WP21).' },
  { id: 'all_periods',       name: 'Alle Generationen',   description: 'Fange Politiker aus allen 6 verfügbaren Wahlperioden (WP16–WP21).' },
];

export const ACHIEVEMENT_MAP = new Map(ACHIEVEMENTS.map(a => [a.id, a]));

// ─── API ──────────────────────────────────────────────────────────────────────

// ─── Server ───────────────────────────────────────────────────────────────────

/** Base URL of the Polidex data server. Overridable at build time via webpack DefinePlugin. */
export const POLIDEX_SERVER_URL: string =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  typeof (globalThis as any).__POLIDEX_SERVER_URL__ === 'string'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? (globalThis as any).__POLIDEX_SERVER_URL__
    : 'http://localhost:3000';

export const POLITICIANS_SYNC_INTERVAL_MS   = 24 * 60 * 60 * 1000; // 24 hours base interval
/** Sync is skipped (unless forced) when data is fresher than this. */
export const POLITICIANS_SYNC_MIN_AGE_MS    = 12 * 60 * 60 * 1000; // 12 hours
/** Maximum additional random jitter added to each sync delay. */
export const POLITICIANS_SYNC_JITTER_MS     =  2 * 60 * 60 * 1000; //  2 hours max jitter

// ─── Known news domains ───────────────────────────────────────────────────────
// Pages on these domains are treated as news articles without requiring
// structured-data heuristics. Subdomain-aware: "ndr.de" also matches "sport.ndr.de".

export const KNOWN_NEWS_DOMAINS: ReadonlySet<string> = new Set([
  // ── German national ──
  'tagesschau.de', 'ard.de', 'zdf.de', 'zdfheute.de', 'sportschau.de',
  'deutschlandfunk.de', 'deutschlandradio.de', 'deutschlandradiokultur.de', 'deutschlandfunknova.de',
  'spiegel.de', 'zeit.de', 'faz.net', 'sueddeutsche.de', 'sz.de',
  'welt.de', 'focus.de', 'stern.de', 'bild.de',
  'handelsblatt.com', 'wiwo.de', 'manager-magazin.de', 'capital.de',
  'ntv.de', 'n-tv.de', 't-online.de', 'watson.de',
  'tagesspiegel.de', 'morgenpost.de', 'fr.de', 'taz.de',
  'heise.de', 'golem.de', 'rnd.de', 'dpa.de', 'afp.com',
  'correctiv.org', 'riffreporter.de', 'krautreporter.de',
  // ── German public broadcasters ──
  'ndr.de', 'wdr.de', 'mdr.de', 'swr.de', 'rbb24.de', 'br24.de',
  'hessenschau.de', 'swp.de',
  // ── German regional ──
  'abendblatt.de', 'mopo.de', 'rp-online.de', 'ksta.de', 'haz.de',
  'noz.de', 'shz.de', 'merkur.de', 'tz.de', 'augsburger-allgemeine.de',
  'stuttgarter-zeitung.de', 'stuttgarter-nachrichten.de',
  'lvz.de', 'mz.de', 'saechsische.de', 'freiepresse.de',
  'volksstimme.de', 'moz.de', 'nordkurier.de', 'ostsee-zeitung.de',
  'weser-kurier.de', 'nw.de', 'westfalen-blatt.de', 'wa.de',
  'mainpost.de', 'nordbayern.de', 'inFranken.de',
  // ── UK ──
  'bbc.com', 'bbc.co.uk', 'theguardian.com', 'thetimes.co.uk',
  'telegraph.co.uk', 'independent.co.uk', 'mirror.co.uk',
  'thesun.co.uk', 'dailymail.co.uk', 'ft.com', 'economist.com',
  'news.sky.com', 'itv.com', 'channel4.com', 'standard.co.uk',
  'spectator.co.uk', 'newstatesman.com', 'politico.eu',
  'inews.co.uk', 'express.co.uk', 'heraldscotland.com', 'scotsman.com',
  'theconversation.com', 'bylinetimes.com', 'opendemocracy.net',
  // ── US ──
  'nytimes.com', 'washingtonpost.com', 'wsj.com', 'apnews.com',
  'reuters.com', 'cnn.com', 'foxnews.com', 'nbcnews.com',
  'abcnews.go.com', 'cbsnews.com', 'npr.org',
  'politico.com', 'thehill.com', 'bloomberg.com',
  'businessinsider.com', 'axios.com', 'vox.com',
  'theatlantic.com', 'newyorker.com', 'time.com', 'newsweek.com',
  'usatoday.com', 'latimes.com', 'nypost.com',
  'sfchronicle.com', 'seattletimes.com', 'chicagotribune.com',
  'bostonglobe.com', 'miamiherald.com', 'dallasnews.com',
  'huffpost.com', 'slate.com', 'propublica.org', 'theintercept.com',
  'semafor.com', 'thedailybeast.com',
]);

export function isKnownNewsDomain(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    for (const domain of KNOWN_NEWS_DOMAINS) {
      if (host === domain || host.endsWith('.' + domain)) return true;
    }
  } catch { /* invalid URL */ }
  return false;
}

// ─── Blocked domains ─────────────────────────────────────────────────────────
// Matches exact hostname or any subdomain (e.g. "nrw.spd.de" matches "spd.de").
// www. is stripped before comparison.

export const BLOCKED_DOMAINS: ReadonlySet<string> = new Set([
  // Party headquarters
  'spd.de', 'cdu.de', 'csu.de', 'gruene.de', 'fdp.de', 'afd.de',
  'buendnis-sahra-wagenknecht.de', 'bsw-vg.de', 'die-linke.de',
  'ssw.de', 'voltdeutschland.org', 'piratenpartei.de', 'freiewaehler.eu',
  // Fraktionen / parliamentary groups
  'spdfraktion.de', 'cducsu.de', 'afdbundestag.de',
  'gruene-bundestag.de', 'linksfraktion.de', 'fdpbt.de', 'bsw-gruppe.de',
  // Federal parliament & government
  'bundestag.de', 'bundesregierung.de', 'bundesrat.de',
  'bpb.de', 'bundeswahlleiterin.de',
  // Political foundations
  'fes.de', 'kas.de', 'hss.de', 'fnf.de', 'boell.de', 'rosalux.de', 'des-stiftung.de',
  // Political monitoring / tracking
  'abgeordnetenwatch.de', 'wahlrecht.de', 'wahl.de',
]);

export function isBlockedDomain(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    for (const domain of BLOCKED_DOMAINS) {
      if (host === domain || host.endsWith('.' + domain)) return true;
    }
  } catch { /* invalid URL */ }
  return false;
}

// ─── Faction colors ───────────────────────────────────────────────────────────

export const FACTION_COLORS: Partial<Record<Faction, string>> = {
  'SPD':       '#e3000f',
  'CDU':       '#cccccc',
  'CSU':       '#008ac5',
  'CDU/CSU':   '#cccccc',
  'GRÜNE':     '#46962b',
  'FDP':       '#d4c800',
  'AfD':       '#009ee0',
  'BSW':       '#c87820',
  'Die Linke': '#be3075',
};
