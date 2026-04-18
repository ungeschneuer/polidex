# Polidex

A browser extension that turns reading German news into a collection game. Scan articles to discover Bundestag members mentioned in the text, catch them, and build your political Pokedex.

Available for Chrome and Firefox (Manifest V3).

## How it works

1. Open a German news article.
2. Click "Scan page" in the popup.
3. Polidex extracts the headline and body text, matches them against ~2,500 Bundestag members (WP16–WP21), and presents candidates.
4. Click "Catch!" to add a politician to your collection.
5. Re-scanning articles already in your index awards XP to politicians you have already caught.

Politicians are scored using a weighted signal system (full name, surname+party, headline placement, common-surname penalty) with a Levenshtein fuzzy fallback. Each politician has a media presence level (Sehr prasent / Prasent / Wenig prasent / Kaum bekannt) derived from their Abgeordnetenwatch activity count, and a longevity tier (Neuling / Routinier / Veteran / Urgestein) based on how many Wahlperioden they served.

## Features

- Matches politicians across all Wahlperioden since WP16 (2005)
- Portrait images from Wikidata (P18)
- XP and level system: +10 per first catch, +5 per re-scan multi-mention
- Article deduplication via SHA-256 hash of URL + title
- Types derived from committee memberships (Economy, Defense, Green, etc.)
- No backend — all data lives in `browser.storage.local`
- Chrome Web Store and Firefox Add-ons compatible

## Data sources

| Source | Used for |
|---|---|
| [Abgeordnetenwatch API v2](https://www.abgeordnetenwatch.de/api) | Politician metadata, activity counts |
| [Wikidata](https://www.wikidata.org/) P18 | Portrait images |

No API keys required. Both APIs are public.

## Development

```
npm install
```

Build for both browsers (production):
```
npm run build
```

Watch mode during development:
```
npm run dev:chrome
# or
npm run dev:firefox
```

Type check without emitting:
```
npm run type-check
```

Package for release (creates zip files in `releases/`):
```
npm run release
```

### Syncing politician data

The `server/sync.ts` script fetches fresh data from Abgeordnetenwatch and writes `politicians.json`. Run it once before the first build or when you want to update the dataset:

```
npm run server:sync
```

### Loading the extension locally

**Chrome:** Go to `chrome://extensions`, enable Developer mode, click "Load unpacked", and select `dist/chrome/`.

**Firefox:** Go to `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on", and select any file in `dist/firefox/`.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full data flow, data model, scoring tables, and component diagram.

## License

MIT. See [LICENSE](LICENSE).
