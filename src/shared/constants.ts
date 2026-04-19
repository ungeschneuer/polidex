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
  Budget:         'Haushalt',
  Green:          'Umwelt',
  Defense:        'Verteidigung',
  Justice:        'Recht',
  Health:         'Gesundheit',
  Diplomat:       'Außenpolitik',
  Tech:           'Digital',
  Social:         'Soziales',
  Infrastructure: 'Infrastruktur',
  Agriculture:    'Landwirtschaft',
  Culture:        'Kultur',
};

export const TYPE_COLORS: Record<PolidexType, string> = {
  Economy:        '#f5a623',
  Budget:         '#607d8b',
  Green:          '#46962b',
  Defense:        '#5c6bc0',
  Justice:        '#ef5350',
  Health:         '#ec407a',
  Diplomat:       '#26a69a',
  Tech:           '#29b6f6',
  Social:         '#ff7043',
  Infrastructure: '#8d6e63',
  Agriculture:    '#8bc34a',
  Culture:        '#ab47bc',
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
  NEWCOMER:    '#a0a0c0',
  EXPERIENCED: '#4caf50',
  VETERAN:     '#f5a623',
  LEGEND:      '#ed4560',
};

// ─── Type mapping ─────────────────────────────────────────────────────────────

/**
 * Maps committee name fragments (lowercase) to PolidexTypes.
 * Order matters: first match wins for the primary type.
 */
export const COMMITTEE_TYPE_MAP: Array<{ keywords: string[]; type: PolidexType }> = [
  { keywords: ['haushalt', 'finanzen', 'finance', 'budget'],                          type: 'Budget' },
  { keywords: ['wirtschaft', 'handel', 'mittelstand', 'industrie', 'economy'],        type: 'Economy' },
  { keywords: ['umwelt', 'klima', 'naturschutz', 'environment', 'climate'],           type: 'Green' },
  { keywords: ['verteidigung', 'sicherheit', 'defence', 'defense'],                   type: 'Defense' },
  { keywords: ['recht', 'verfassung', 'justiz', 'justice', 'legal'],                  type: 'Justice' },
  { keywords: ['gesundheit', 'familie', 'health', 'family'],                          type: 'Health' },
  { keywords: ['auswärtig', 'europa', 'außenpolitik', 'foreign', 'europe'],           type: 'Diplomat' },
  { keywords: ['digital', 'forschung', 'technologie', 'innovation', 'research'],     type: 'Tech' },
  { keywords: ['sozial', 'arbeit', 'bildung', 'labour', 'education', 'welfare'],     type: 'Social' },
  { keywords: ['bau', 'verkehr', 'energie', 'infrastructure', 'transport', 'energy'], type: 'Infrastructure' },
  { keywords: ['landwirtschaft', 'ernährung', 'forst', 'ländlich', 'agrar'],          type: 'Agriculture' },
  { keywords: ['kultur', 'medien', 'sport', 'tourismus', 'kirchlich', 'kreativ'],     type: 'Culture' },
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
  icon?: string;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first_catch',       name: 'Erste Sammlung',        description: 'Sammle deine*n erste*n Politiker*in.' },
  { id: 'ten_caught',        name: 'Sammler*in',            description: 'Sammle 10 Politiker*innen.' },
  { id: 'fifty_caught',      name: 'Volksvertreter*in',     description: 'Sammle 50 Politiker*innen.' },
  { id: 'hundred_caught',    name: 'Parlamentarier*in',     description: 'Sammle 100 Politiker*innen.' },
  { id: 'two_hundred_caught',name: 'Bundestagskenner*in',   description: 'Sammle 200 Politiker*innen.' },
  { id: 'ten_articles',      name: 'Fleißige*r Leser*in',   description: 'Scanne 10 Artikel mit Ergebnissen.' },
  { id: 'fifty_articles',    name: 'Nachrichtenfan',        description: 'Scanne 50 Artikel mit Ergebnissen.' },
  { id: 'hundred_articles',  name: 'Medienexpert*in',       description: 'Scanne 100 Artikel mit Ergebnissen.' },
  { id: 'streak_3',          name: 'Tagesroutine',          description: 'Erreiche eine 3-Tage-Scan-Serie.' },
  { id: 'streak_7',          name: 'Wochenlauf',            description: 'Erreiche eine 7-Tage-Scan-Serie.' },
  { id: 'streak_30',         name: 'Monatsserie',           description: 'Erreiche eine 30-Tage-Scan-Serie.' },
  { id: 'catch_epic',        name: 'Randfigur',             description: 'Sammle eine*n Politiker*in mit sehr geringer Medienpräsenz.' },
  { id: 'catch_headline',    name: 'Schlagzeilensammler*in',description: 'Sammle eine*n Politiker*in aus einer Schlagzeile.' },
  { id: 'level_5',           name: 'Aufsteiger*in',         description: 'Bringe eine*n Politiker*in auf Level 5.' },
  { id: 'level_10',          name: 'Meister*in',            description: 'Bringe eine*n Politiker*in auf Level 10.' },
  { id: 'catch_veteran',     name: 'Parlamentsveteran*in',  description: 'Sammle eine*n Politiker*in, die*der mindestens 4 Wahlperioden aktiv war.' },
  { id: 'catch_legend',      name: 'Urgestein',             description: 'Sammle eine*n Politiker*in, die*der mindestens 6 Wahlperioden aktiv war.' },
  { id: 'catch_historical',  name: 'Zeitreisende*r',        description: 'Sammle eine*n Politiker*in aus einer vergangenen Wahlperiode (vor WP21).' },
  { id: 'all_periods',       name: 'Alle Generationen',     description: 'Sammle Politiker*innen aus allen 6 verfügbaren Wahlperioden (WP16–WP21).' },
  { id: 'type_collector',   name: 'Typenforscher*in',       description: 'Sammle Politiker*innen mit mindestens 8 verschiedenen Typen.', icon: '\u{1F52C}' },
  { id: 'faction_sweep',    name: 'Querdenker*in',          description: 'Sammle mindestens eine*n Politiker*in aus jeder aktiven Fraktion.', icon: '\u{1F308}' },
  { id: 'five_obscure',     name: 'Schattensucher*in',      description: 'Sammle 5 Politiker*innen mit sehr geringer Medienpräsenz.', icon: '\u{1F47B}' },
  { id: 'level_20',         name: 'Stammgast',              description: 'Bringe eine*n Politiker*in auf Level 20.', icon: '\u2B50' },
  { id: 'total_xp_500',     name: 'Erfahrene*r Sammler*in', description: 'Sammle insgesamt 500 XP über alle Politiker*innen.', icon: '\u{1F4AA}' },
];

export const ACHIEVEMENT_MAP = new Map(ACHIEVEMENTS.map(a => [a.id, a]));

// ─── API ──────────────────────────────────────────────────────────────────────

// ─── Server ───────────────────────────────────────────────────────────────────

declare const __POLIDEX_SERVER_URL__: string | undefined;

/** Base URL of the Polidex data server. Injected at build time via webpack DefinePlugin. */
export const POLIDEX_SERVER_URL: string = typeof __POLIDEX_SERVER_URL__ !== 'undefined' ? __POLIDEX_SERVER_URL__ : '';

export const POLITICIANS_SYNC_INTERVAL_MS   = 24 * 60 * 60 * 1000; // 24 hours base interval
/** Sync is skipped (unless forced) when data is fresher than this. */
export const POLITICIANS_SYNC_MIN_AGE_MS    = 12 * 60 * 60 * 1000; // 12 hours
/** Maximum additional random jitter added to each sync delay. */
export const POLITICIANS_SYNC_JITTER_MS     =  2 * 60 * 60 * 1000; //  2 hours max jitter

// ─── Known news domains ───────────────────────────────────────────────────────
// Pages on these domains are treated as news articles without requiring
// structured-data heuristics. Subdomain-aware: "ndr.de" also matches "sport.ndr.de".

export const KNOWN_NEWS_DOMAINS: ReadonlySet<string> = new Set([
  '1815.ch', '20min.ch', '90min.de',
  'aachener-nachrichten.de', 'aachener-zeitung.de', 'aargauerzeitung.ch', 'abendblatt-berlin.de',
  'abendblatt.de', 'abendzeitung-muenchen.de', 'adz.ro', 'aegidienberger-bote.de',
  'afp.com', 'africalog.com', 'aichacher-zeitung.de', 'aktien-portal.at',
  'aktiv-online.de', 'aktuell.com', 'aktuell.ru', 'alanyabote.com',
  'alfelder-zeitung.de', 'all-in.de', 'allgaeuer-anzeigeblatt.de', 'alpenpost.at',
  'alsdorf-aktuell.com', 'alsfelder-allgemeine.de', 'altona.info', 'andelfinger.ch',
  'anzeigen-echo.de', 'anzeiger.biz', 'apa.at', 'appenzell24.ch',
  'appenzellerzeitung.ch', 'ard-text.de', 'ard.de', 'askonline.ch',
  'augsburger-allgemeine.de', 'az-online.de', 'az.com.na', 'azertag.az', 'azonline.de',
  'badenerzeitung.at', 'badische-zeitung.de', 'badisches-tagblatt.de', 'baltische-rundschau.eu',
  'basellandschaftlichezeitung.ch', 'bauernzeitung.ch', 'bayerische-staatszeitung.de', 'bazonline.ch',
  'bb-live.de', 'bbv-net.de', 'beobachter-online.de', 'beobachter.ch',
  'berchtesgadener-anzeiger.de', 'bergedorfer-zeitung.de', 'bergisches-handelsblatt.de', 'bergisches-sonntagsblatt.de',
  'berlin-nachrichten.de', 'berliner-kurier.de', 'berliner-zeitung.de', 'berlinerumschau.com',
  'bernerzeitung.ch', 'bielerpresse.ch', 'bielertagblatt.ch', 'bilanz.ch',
  'bild.de', 'binningeranzeiger.ch', 'bkz-online.de', 'bleckederzeitung.de',
  'blick.ch', 'blickamabend.ch', 'blickpunkt-brandenburg.de', 'blickpunkt-euskirchen.de',
  'blickpunkt-godesberg.de', 'blickpunkt-meckenheim.de', 'blitz-world.de', 'blizzaktuell.de',
  'bnn.de', 'bnr.bg', 'bo.bernerzeitung.ch', 'bo.de',
  'boehme-zeitung.de', 'boerse-online.de', 'boersen-zeitung.de', 'borkenerzeitung.de',
  'borkumer-zeitung.de', 'bote.ch', 'br.de', 'br24.de',
  'brandenburg-abc.de', 'braunschweiger-zeitung.de', 'brf.be', 'brilon-totallokal.de',
  'brixner.info', 'brugg-online.ch', 'brv-zeitung.de', 'budapester.hu',
  'buerstaedter-zeitung.de', 'burgenland.orf.at', 'bvz.at', 'bz-berlin.de',
  'cafebabel.de', 'cannstatter-zeitung.de', 'cash.ch', 'cbz.es',
  'cellesche-zeitung.de', 'christundwelt.de', 'cicero.de', 'cn-online.de',
  'cnddeutsch.com', 'come-on.de', 'condor.cl', 'correctiv.org',
  'corcas.com', 'cordis.europa.eu', 'cosmopolis.ch', 'costanachrichten.com',
  'cubaheute.de', 'das-blaettchen.de', 'dattelner-morgenpost.de',
  'de.euronews.com', 'de.granma.cu', 'de.nachrichten.yahoo.com', 'de.reuters.com',
  'de.ria.ru', 'de.rusbiznews.com', 'de.zenit.org', 'der-blitz.de',
  'der-kurier.de', 'der-reporter.de', 'derbrienzer.ch', 'derbund.ch',
  'deredactie.be', 'derennstaler.at', 'deroberhasler.ch', 'derpatriot.de',
  'derstandard.at', 'dervinschger.it', 'derwesten.de', 'deu.belta.by',
  'deutsche-allgemeine-zeitung.de', 'deutschlandfunk.de', 'deutschlandfunknova.de', 'deutschlandradio.de',
  'dewezet.de', 'die-glocke.de', 'dieharke.de', 'diepresse.com',
  'dill.de', 'dk-online.de', 'dnn-online.de', 'domrep-magazin.de',
  'donaukurier.de', 'dorfposcht.ch', 'dpa.de', 'dresden-news.com', 'dzonline.de',
  'eberbacher-zeitung.de', 'echo-nord.de', 'echo-online.de', 'echovongrindelwald.ch',
  'eifel-journal.de', 'eifelzeitung.de', 'einbecker-morgenpost.de', 'ejz.de',
  'ekapija.com', 'elbe-wochenblatt.de', 'elgger.ch', 'emderzeitung.de',
  'emsdettenervolkszeitung.de', 'engadinerpost.ch', 'ennsseiten.at', 'entlebucher-anzeiger.ch',
  'epochtimes.de', 'esslinger-zeitung.de', 'euractiv.de', 'eurotopics.net',
  'express.de', 'extra-blatt.de', 'facts.ch', 'falkenseer-kurier.info',
  'falter.at', 'faz.net', 'feierkrop.lu', 'ff-online.com',
  'fides.org', 'finanznachrichten.de', 'fnp.de', 'fnweb.de',
  'focus.de', 'fr-online.de', 'fr.de', 'frankenpost.de',
  'freiburger-nachrichten.ch', 'freiepresse.de', 'freitag.de', 'fridolin.ch',
  'friebo.de', 'fuldaerzeitung.de', 'fuw.ch', 'ga-online.de',
  'gaeubote.de', 'gandersheimer-kreisblatt.de', 'gea.de', 'gelnhaeuser-tageblatt.de',
  'gemeindezeitung.de', 'general-anzeiger-bonn.de', 'georgien-nachrichten.de', 'german.beijingreview.com.cn',
  'german.pnn.ps', 'germannews.com', 'gewinn.com', 'giessener-allgemeine.de',
  'giessener-anzeiger.de', 'gmuender-tagespost.de', 'gn-online.de', 'gnz.de',
  'goettinger-tageblatt.de', 'golem.de', 'goslarsche.de', 'goyax.de',
  'grazer.at', 'grenchnerstadtanzeiger.ch', 'grenchnertagblatt.ch', 'grenzecho.be',
  'hafencitynews.de', 'hall1.de', 'haller-kreisblatt.de', 'hallo-nachbar-online.de',
  'hamburg-zwei.de', 'hamburger-allgemeine.de', 'hanauer.de', 'handelsblatt.com',
  'handelszeitung.ch', 'harburg-aktuell.de', 'harlinger-online.de', 'havelstadt-brandenburg.de',
  'haz.de', 'heide-kurier.de', 'heise.de', 'heimatzeitung.de',
  'hellerthaler-zeitung.de', 'hellwegeranzeiger.de', 'hermannstaedter.ro', 'hersfelder-zeitung.de',
  'hertener-allgemeine.de', 'hessenschau.de', 'heute.at', 'heute.de',
  'hildesheimer-allgemeine.de', 'hitradio.com.na', 'hna.de', 'hnp-online.de',
  'hoefner.ch', 'hz-online.de', 'idowa.de', 'industriemagazin.at',
  'inforadio.de', 'infowilplus.ch', 'infranken.de', 'inka-magazin.de',
  'inmadeira.de', 'insuedthueringen.de', 'ipsnews.de', 'istanbulpost.net',
  'ivz-aktuell.de', 'jeversches-wochenblatt.de', 'journal.lu', 'jungefreiheit.de',
  'jungewelt.de', 'jungfrauzeitung.ch', 'jungle-world.com', 'kaernten.orf.at',
  'kanarenexpress.com', 'kettwig-today.de', 'kevelaerer-blatt.de', 'khovar.tj',
  'kitzanzeiger.at', 'kleinezeitung.at', 'kloteneranzeiger.ch', 'kn-online.de',
  'koenigsberger-express.com', 'kosova-info-line.de', 'kraichgau-magazin.de', 'krautreporter.de',
  'kreis-anzeiger.de', 'kreisanzeiger.de', 'kreisblatt.de', 'kreiszeitung.de',
  'krone.at', 'ksta.de', 'kurier.at', 'lagazettedeberlin.com',
  'landbote.ch', 'landes-zeitung.de', 'landeszeitung.cz', 'landeszeitung.de',
  'lausitzecho.de', 'lauterbacher-anzeiger.de', 'lbn.at', 'leipzig-news.com',
  'lelac.ch', 'leonberger-kreiszeitung.de', 'lessentiel.lu', 'lippe.newsowl.de',
  'ln-online.de', 'lokalanzeiger.de', 'lokale-informationen.de', 'lol.li',
  'lr-online.de', 'lux-post.lu', 'luxprivat.lu', 'luzernerzeitung.ch',
  'lvz-online.de', 'lz.de', 'main-netz.de', 'mainpost.de',
  'mallorcazeitung.es', 'manager-magazin.de', 'marbacher-zeitung.de', 'marktspiegel.de',
  'marler-zeitung.de', 'maurmer-post.ch', 'maz-online.de', 'mdr.de',
  'mdz-moskau.eu', 'meerbuscher-nachrichten.de', 'meileneranzeiger.ch', 'meingeld-magazin.de',
  'mendenerzeitung.de', 'merkur-online.de', 'mittelbayerische.de', 'mittelhessen.de',
  'monde-diplomatique.de', 'monstersandcritics.de', 'mopo.de', 'morgenpost.de',
  'morgenweb.de', 'moz.de', 'mt-news.de', 'mt.de',
  'muehlacker-tagblatt.de', 'muenster-am-sonntag.de', 'muensterschezeitung.de', 'murtenbieter.ch',
  'mv-online.de', 'mvpo.de', 'mz-web.de', 'n-land.de',
  'n-tv.de', 'n24.de', 'nachrichten.at', 'nachrichten.de',
  'namibiafocus.com', 'nbt.ch', 'ndr.de', 'ndz.de',
  'net-news-global.de', 'neue.at', 'neueooe.at', 'neuepresse.de',
  'neueregionale.com', 'neues-deutschland.de', 'neueveldenerzeitung.at', 'news.at',
  'news.ch', 'news.de', 'newsdeutschland.com', 'nfz.ch',
  'nidwaldnerzeitung.ch', 'nnn.de', 'nnp.de', 'noe.orf.at',
  'noen.at', 'noows.de', 'nordbayerischer-kurier.de', 'nordbayern.de',
  'nordkurier.de', 'nordschleswiger.dk', 'nordsee-zeitung.de', 'noz-oberaargau.ch',
  'noz.ch', 'noz.de', 'np-coburg.de', 'nq-online.de',
  'ntv.de', 'ntz.de', 'nw-news.de', 'nwzonline.de', 'nzz.ch',
  'obermain.de', 'oberpfalznetz.de', 'obersteirische.at', 'obwaldnerzeitung.ch',
  'oderbruch-rundschau.de', 'oe-journal.at', 'oe24.at', 'oltnertagblatt.ch',
  'on-online.de', 'oneworld.at', 'ooe.orf.at', 'op-marburg.de',
  'op-online.de', 'orf.at', 'osservatoreromano.va', 'ostsee-zeitung.de',
  'osttirolerbote.at', 'otz.de', 'ov-online.de', 'ovb-online.de', 'oz-online.de',
  'p3tv.at', 'pattayablatt.com', 'paz-online.de', 'pesterlloyd.net',
  'phoenix.de', 'pirmasenser-zeitung.de', 'pnn.de', 'pnp.de',
  'postillon.com', 'pragerzeitung.cz', 'pressetext.com', 'preussische-allgemeine.de',
  'prignitzer.de', 'profil.at', 'pyrmonter-nachrichten.de', 'pz-news.de', 'pzpz.it',
  'quartierecho.ch', 'radio-plassenburg.de', 'radio.cz', 'radio.li',
  'radiobremen.de', 'radiohamburg.de', 'radioukr.com.ua', 'rbb-online.de', 'rbb24.de',
  'rczeitung.com', 'recklinghaeuser-zeitung.de', 'regioblick.de', 'remszeitung.de',
  'revue.lu', 'rga-online.de', 'rha.de', 'rheiderland.de',
  'rhein-main.net', 'rhein-zeitung.de', 'rheinpfalz.de', 'rheintaler.ch',
  'riffreporter.de', 'riehener-zeitung.ch', 'rnd.de', 'rnz.de',
  'rotenburger-rundschau.de', 'rp-online.de', 'rro.ch', 'rtl.de',
  'rueganer-anzeiger.de', 'ruhrnachrichten.de', 'rundschau-online.de', 'rz-online.ch',
  'saarbruecker-zeitung.de', 'sachsen-sonntag.de', 'sahara-online.net', 'salzburg.com',
  'salzburg.orf.at', 'salzburg24.at', 'salzburger-fenster.at', 'salzgitter-zeitung.de',
  'samstagsblatt.de', 'sat1.de', 'sauerlandkurier.de', 'saz-aktuell.com',
  'schaumburger-zeitung.de', 'schladmingerpost.at', 'schlossbote.de', 'schwaebische-post.de',
  'schwaebische.de', 'schwarzwaelder-bote.de', 'schweizerzeit.ch', 'schwerinonline.de',
  'sda.ch', 'selezione.ch', 'sempacherwoche.ch', 'shz.de',
  'siegener-zeitung.de', 'siegerlandkurier.de', 'sn-online.de', 'soester-anzeiger.de',
  'soj.at', 'solidaritaet.com', 'solinger-tageblatt.de', 'solothurnerzeitung.ch',
  'sonntags-post.de', 'sonntags-rundblick.de', 'sonntagsnachrichten.de', 'sonntagszeitung.ch',
  'sowo.ch', 'spiegel.de', 'sport1.de', 'srf.ch',
  'stadi-online.ch', 'stadtanzeiger-im-netz.de', 'stadtkurier.de', 'stadtzeitung.luebeck.de',
  'steiermark.orf.at', 'steinheimer-blickpunkt.de', 'stern.de', 'stimberg-zeitung.de',
  'stimme.de', 'stol.it', 'stuttgart-journal.de', 'stuttgarter-nachrichten.de',
  'stuttgarter-wochenblatt.de', 'stuttgarter-zeitung.de', 'sueddeutsche.de', 'suedkurier.de',
  'suedostschweiz.ch', 'suedtirolernachrichten.it', 'suite101.de', 'supersonntag-web.de',
  'svz.de', 'swa-wwa.de', 'swp.de', 'swr.de', 'sz-online.de', 'szbz.de',
  't-online.de', 'tachles.ch', 'tagblatt.ch', 'tagblatt.de',
  'tagblattzuerich.ch', 'tageblatt.com.ar', 'tageblatt.de', 'tageblatt.lu',
  'tagesanzeiger.ch', 'tagesschau.de', 'tagesspiegel.de', 'tageswoche.ch',
  'tah.de', 'tamurt.info', 'tangrintler-nachrichten.de', 'taunus-zeitung.de',
  'taz.de', 'teckbote.de', 'teletext.ch', 'teletext.orf.at',
  'teltower-stadtblatt.de', 'terz.org', 'tessinerzeitung.ch', 'thalwileranzeiger.ch',
  'thueringer-allgemeine.de', 'thurgauerzeitung.ch', 'tip-berlin.de', 'tirol.orf.at',
  'tiroltv.at', 'tlz.de', 'toggenburgernachrichten.ch', 'toggenburgertagblatt.ch',
  'traunsteiner-tagblatt.de', 'trend.at', 'tschechien-online.org', 'tt.bernerzeitung.ch',
  'tt.com', 'tuerkei-zeitung.de', 'tz.de', 'uckermarkkurier.de',
  'uena.de', 'ukrainianjournal.com', 'unterkaerntner.at', 'urnerwochenblatt.ch',
  'urnerzeitung.ch', 'usinger-anzeiger.de', 'uza.uz', 'vaterland.li',
  'vaticannews.va', 'verlagshaus-jaumann.de', 'visiontimes.net', 'vogtland-anzeiger.de',
  'vol.at', 'volksblatt.at', 'volksblatt.li', 'volksfreund.de',
  'volksstimme.de', 'vorarlberg.orf.at', 'vorarlbergernachrichten.at', 'vorwaerts.ch',
  'voxeurop.eu', 'wa.de', 'waltroper-zeitung.de', 'wannundwo.at',
  'watson.de', 'waz-online.de', 'wdr.de', 'welt.de',
  'weltexpress.de', 'weltwoche.ch', 'werra-rundschau.de', 'weser-kurier.de',
  'westallgaeuer-zeitung.de', 'westline.de', 'wien.orf.at', 'wienerbezirksblatt.at',
  'wienerzeitung.at', 'wiesbadener-kurier.de', 'winterthurer-zeitung.ch', 'wirtschaftsblatt-bg.com',
  'wirtschaftsblatt.at', 'wirtschaftsspiegel-thueringen.com', 'wirtschaftsspiegel.com', 'wiwo.de',
  'wlz-fz.de', 'wn.de', 'wochen-zeitung.ch', 'wochenanzeiger.de',
  'wochenblatt.cc', 'wochenblatt.net', 'wochenende-frechen.de', 'wochenkurier.info',
  'wolfsburger-nachrichten.de', 'wormser-zeitung.de', 'wort.lu', 'woxx.lu',
  'woz.ch', 'wsj.de', 'wsrw.org', 'wuermtaler-nachrichten.de',
  'wundo.ch', 'www1.wdr.de', 'www2.shn.ch', 'wz-net.de',
  'wz-newsline.de', 'wzonline.de', 'zdf.de', 'zdfheute.de',
  'zeit-fragen.ch', 'zeit.de', 'zeitungen.boyens-medien.de', 'zitty.de',
  'zlv.lu', 'zofingertagblatt.ch', 'zol.ch', 'zollernalbkurier.de',
  'zsz.ch', 'zugerzeitung.ch', 'zuonline.ch', 'zvw.de',
]);

export function isKnownNewsDomain(
  url: string,
  domains: ReadonlySet<string> = KNOWN_NEWS_DOMAINS
): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    for (const domain of domains) {
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

export function isBlockedDomain(
  url: string,
  domains: ReadonlySet<string> = BLOCKED_DOMAINS
): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    for (const domain of domains) {
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
