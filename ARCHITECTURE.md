# Polidex — Technical Architecture

## Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  Browser Extension (Manifest V3)                                     │
│                                                                      │
│  ┌─────────────┐  EXTRACT_CONTENT  ┌──────────────────────────────┐ │
│  │             │ ────────────────> │                              │ │
│  │   POPUP     │                   │   CONTENT SCRIPT             │ │
│  │  popup.ts   │ <──────────────── │   content/index.ts           │ │
│  │             │  ArticleContent   │                              │ │
│  │  [Scan btn] │                   │   - extractHeadline()        │ │
│  │  [Dex view] │                   │   - extractBodyText()        │ │
│  │  [Card UI]  │                   │   - detectLanguage()         │ │
│  └──────┬──────┘                   └──────────────────────────────┘ │
│         │                                                            │
│    SCAN_PAGE / CATCH / GET_POKEDEX (chrome.runtime.sendMessage)      │
│         │                                                            │
│         v                                                            │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  BACKGROUND SERVICE WORKER  background/index.ts              │   │
│  │                                                              │   │
│  │  ┌────────────┐   ┌────────────────┐   ┌─────────────────┐  │   │
│  │  │  matcher   │   │   storage      │   │   api           │  │   │
│  │  │            │   │                │   │                 │  │   │
│  │  │ findMatch()│   │ getPolitician()│   │ fetchAllMdBs()  │  │   │
│  │  │ levenshtein│   │ saveCaught()   │   │ enrichImages()  │  │   │
│  │  │ scoring    │   │ saveArticle()  │   │ enrichMedia()   │  │   │
│  │  └────────────┘   └───────┬────────┘   └────────┬────────┘  │   │
│  │                           │                     │            │   │
│  └───────────────────────────┼─────────────────────┼────────────┘   │
│                              │                     │                │
│                              v                     v                │
│  ┌────────────────────────────────┐   ┌────────────────────────┐   │
│  │  browser.storage.local         │   │  External APIs         │   │
│  │                                │   │                        │   │
│  │  politicians[]   (weekly sync) │   │  abgeordnetenwatch.de  │   │
│  │  caught{}        (game state)  │   │  /api/v2/ (WP16–WP21+) │   │
│  │  articles{}      (hash index)  │   │                        │   │
│  └────────────────────────────────┘   │  www.wikidata.org/     │   │
│                                       │  w/api.php (P18 imgs)  │   │
│                                       └────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

## Data flow for a scan

```
User clicks "SCAN PAGE"
  → popup sends EXTRACT_CONTENT to content script
  → content script returns { headline, bodyText, url, lang }
  → popup sends SCAN_PAGE to background
  → background hashes article (SHA-256 of normalizedUrl + title)
  → background checks articles{} — if seen: flag alreadyScanned
  → background runs findMatches(politicians, content)
      for each politician:
        1. pre-filter: surname must appear in headline or body
        2. score: fullName (+50), surname+party (+20), surname+role (+15)
                  common surname (-40), headline (+25), multi-mention (+5)
        3. fuzzy match on tokens if score still low
        4. accept if score >= 30
  → background awards XP to already-caught politicians in this article
  → background returns ScanResult { candidates, alreadyScanned, hash }
  → popup renders candidate cards
User clicks "CATCH!"
  → popup sends CATCH_POLITICIAN { id, articleHash }
  → background checks caught{} — if present: return alreadyCaught
  → background creates CaughtPolitician { xp: 10, level: floor(sqrt(10)) }
  → background saves to caught{} and articles{}
  → popup plays catch animation, updates card state
```

## Data model

```typescript
// Master data (from Abgeordnetenwatch API, synced across all Wahlperioden)
interface PoliticianData {
  id: string;
  firstName: string;
  lastName: string;
  title?: string;
  faction: Faction;
  types: PolidexType[];     // derived from WP21 committee memberships
  committees: string[];
  imageUrl?: string;        // from Wikidata P18 portrait
  isCommonSurname: boolean; // pre-computed for scoring penalty
  mediaScore: number;       // statistic_questions count → media presence
  periodsActive: number[];  // Wahlperiode numbers, e.g. [18, 19, 20, 21]
}

// Game state (grows as user catches politicians)
interface CaughtPolitician {
  id: string;
  xp: number;               // 10 base + 5 multi-mention per article
  level: number;            // floor(sqrt(xp))
  caughtAt: number;
  articleCount: number;
  lastSeenAt: number;
}

// Article deduplication index
interface ScannedArticle {
  hash: string;             // SHA-256(normalizeUrl(url) + "|" + title.lower)
  url: string;
  title: string;
  scannedAt: number;
  politicianIds: string[];
}
```

## Scoring system

| Signal                        | Score |
|-------------------------------|-------|
| Full name in body             |  +50  |
| Surname + party in body       |  +20  |
| Surname + role keyword in body|  +15  |
| In headline                   |  +25  |
| Multi-mention (per extra, x3) |   +5  |
| Common surname penalty        |  -40  |
| Fuzzy near-miss               |  +10  |
| **Acceptance threshold**      |  ≥ 30 |

## Media presence (statistic_questions count from AW API)

| mediaScore (questions answered) | MediaPresence |
|---------------------------------|---------------|
| > 150                           | PROMINENT     |
| 40 – 150                        | NOTABLE       |
| 10 – 40                         | MINOR         |
| < 10                            | OBSCURE       |

## Longevity (number of Wahlperioden active)

| periodsActive.length | Longevity    | Label       |
|----------------------|--------------|-------------|
| 1                    | NEWCOMER     | Neuling     |
| 2 – 3                | EXPERIENCED  | Routinier   |
| 4 – 5                | VETERAN      | Veteran     |
| 6+                   | LEGEND       | Urgestein   |

Wahlperioden covered: WP16 (2005) through WP21 (2025–present), plus any
future periods auto-discovered via the Abgeordnetenwatch parliament-periods
endpoint. Total: ~2,500 unique politicians across ~3,900 mandates.

## Type mapping (committee → PolidexType)

| Committee keywords              | Type           |
|---------------------------------|----------------|
| finanzen, haushalt, wirtschaft  | Economy        |
| umwelt, klima                   | Green          |
| verteidigung, sicherheit        | Defense        |
| recht, verfassung, justiz       | Justice        |
| gesundheit, familie             | Health         |
| auswärtig, europa               | Diplomat       |
| digital, forschung, technologie | Tech           |
| sozial, arbeit, bildung         | Social         |
| bau, verkehr, energie           | Infrastructure |

A politician can have multiple types.

## Build output (dist/)

```
dist/
├── manifest.json
├── background.js   (service worker, ~9 KB minified)
├── content.js      (~2 KB)
├── popup.js        (~8 KB)
├── popup.css       (~12 KB)
└── popup.html
```

## Scaling suggestions

1. **NER upgrade**: Replace the token-based fuzzy match with a WASM-compiled
   NLP model (e.g. compromise.js) bundled into the extension for higher
   precision Named Entity Recognition without any server round-trip.

2. **Offline-first data**: Bundle a snapshot of current MdB data as
   `politicians.json` in the extension package. The API sync then only
   needs to fetch diffs, reducing cold-start time.

3. **Import / export**: Add a JSON export of the `caught` map so users
   can back up their collection (serialize to a Blob download).

4. **Trading cards**: Generate a shareable PNG card using the OffscreenCanvas
   API in the service worker — no server required.

5. **Multi-language body heuristics**: For English articles about German
   politics, add an English committee→type keyword mapping and English
   role keywords ("member of parliament", "foreign minister").

6. **Deduplication refinement**: The current hash uses URL + title. A
   content-hash (first 500 chars of body) could additionally detect
   republished articles with different URLs.

## Known limitations & ambiguity handling

- **Homonyms**: The scoring system's context signals (party, role) are the
  primary disambiguation mechanism. The -40 penalty for common surnames
  means a bare "Fischer" in a sports article won't trigger a match.

- **Name variants**: Politicians sometimes appear as "Scholz" vs
  "Bundeskanzler Scholz" vs "Olaf Scholz" — all three paths are covered
  by the scoring tiers.

- **Paywall content**: The extractor only sees DOM text; paywalled articles
  return limited content. The headline-only path still works for these.

- **API key**: The Abgeordnetenwatch API v2 is public and requires no key.
  Wikidata is also public. No API credentials are needed.
