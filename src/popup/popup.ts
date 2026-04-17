/**
 * Popup script — orchestrates the UI.
 * Communicates with:
 *   - content script (EXTRACT_CONTENT) via chrome.tabs.sendMessage
 *   - background (SCAN_PAGE, CATCH_POLITICIAN, GET_POKEDEX, etc.) via chrome.runtime.sendMessage
 *
 * All dynamic content is inserted via DOM methods (textContent / setAttribute)
 * to prevent XSS — no innerHTML with external data.
 */

import './popup.css';
import type {
  ExtractContentResult,
  MatchCandidate,
  PokedexEntry,
  PoliticianData,
  ScanResultMessage,
  CatchResultMessage,
  PokedexDataMessage,
  AllPoliticiansDataMessage,
  SyncStatusDataMessage,
  ImportResultMessage,
  GameStateDataMessage,
  StreakData,
} from '../types/index.js';
import {
  calcLevel,
  xpForLevel,
  calcMediaPresence,
  PRESENCE_COLORS,
  PRESENCE_LABELS,
  calcLongevity,
  LONGEVITY_LABELS,
  LONGEVITY_COLORS,
  TYPE_LABELS,
  FACTION_COLORS,
  ACHIEVEMENT_MAP,
} from '../shared/constants.js';

// ─── State ────────────────────────────────────────────────────────────────────

let currentCandidates: MatchCandidate[] = [];
let currentArticleHash = '';
let currentArticleUrl = '';
let currentArticleTitle = '';
let dexEntries: PokedexEntry[] = [];
let allPoliticians: PoliticianData[] = [];
let totalPoliticians = 0;

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const btnScan          = el<HTMLButtonElement>('btn-scan');
const scanStatus       = el('scan-status');
const resultsEl        = el('results');
const resultsCount     = el('results-count');
const articleBadge     = el('article-badge');
const candidateList    = el('candidate-list');
const emptyState       = el('empty-state');
const streakDisplay    = el('streak-display');
const streakCount      = el('streak-count');

const syncLabel        = el('sync-label');
const btnSync          = el<HTMLButtonElement>('btn-sync');

const tabScan          = el('tab-scan');
const tabDex           = el('tab-dex');
const dexCount         = el('dex-count');
const dexProgressBar   = el('dex-progress-bar');
const dexSearch        = el<HTMLInputElement>('dex-search');
const dexSort          = el<HTMLSelectElement>('dex-sort');
const dexList          = el('dex-list');
const dexEmpty         = el('dex-empty');
const dexNoResults     = el('dex-no-results');
const factionStatsEl   = el('faction-stats');
const achievementsGrid = el('achievements-grid');
const btnExport        = el<HTMLButtonElement>('btn-export');
const btnImport        = el<HTMLButtonElement>('btn-import');
const importFile       = el<HTMLInputElement>('import-file');

const cardOverlay      = el('card-overlay');
const detailCard       = el('detail-card');
const btnCloseCard     = el<HTMLButtonElement>('btn-close-card');

const helpOverlay      = el('help-overlay');
const btnHelp          = el<HTMLButtonElement>('btn-help');
const btnCloseHelp     = el<HTMLButtonElement>('btn-close-help');

const achievementToast     = el('achievement-toast');
const achievementToastName = el('achievement-toast-name');

// ─── Init ─────────────────────────────────────────────────────────────────────

document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab as 'scan' | 'dex'));
});

btnScan.addEventListener('click', handleScan);
btnCloseCard.addEventListener('click', () => cardOverlay.classList.add('hidden'));
btnHelp.addEventListener('click', () => helpOverlay.classList.remove('hidden'));
btnCloseHelp.addEventListener('click', () => helpOverlay.classList.add('hidden'));
btnSync.addEventListener('click', handleSyncNow);
btnExport.addEventListener('click', handleExport);
btnImport.addEventListener('click', () => importFile.click());
importFile.addEventListener('change', handleImport);
dexSearch.addEventListener('input', renderDex);
dexSort.addEventListener('change', renderDex);

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    cardOverlay.classList.add('hidden');
    helpOverlay.classList.add('hidden');
  }
});

loadDex();
loadSyncStatus();
loadStreak();

// ─── Tab navigation ───────────────────────────────────────────────────────────

function switchTab(tab: 'scan' | 'dex') {
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', (b as HTMLButtonElement).dataset.tab === tab);
  });
  tabScan.classList.toggle('hidden', tab !== 'scan');
  tabDex.classList.toggle('hidden',  tab !== 'dex');
  if (tab === 'dex') loadDex();
}

// ─── Streak display ───────────────────────────────────────────────────────────

async function loadStreak() {
  const state = await chrome.runtime.sendMessage<unknown, GameStateDataMessage>({
    type: 'GET_GAME_STATE',
  });
  renderStreak(state.streak);
  renderAchievements(state.achievements);
}

function renderStreak(streak: StreakData) {
  if (streak.current >= 2) {
    streakDisplay.classList.remove('hidden');
    streakCount.textContent = `${streak.current} Tage`;
    streakDisplay.title = `Längste Serie: ${streak.longest} Tage`;
  } else {
    streakDisplay.classList.add('hidden');
  }
}

// ─── Scan flow ────────────────────────────────────────────────────────────────

async function handleScan() {
  setScanState('scanning');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab');

    const extracted = await chrome.tabs.sendMessage<unknown, ExtractContentResult>(
      tab.id, { type: 'EXTRACT_CONTENT' }
    );

    if (extracted?.blocked) {
      setScanState('idle');
      showStatus('Partei- und Regierungswebsites werden nicht gescannt.');
      return;
    }
    if (extracted?.notArticle) {
      setScanState('idle');
      showStatus('Kein Nachrichtenartikel auf dieser Seite erkannt.');
      return;
    }

    const content = extracted?.content;
    if (!content?.headline) {
      setScanState('idle');
      showStatus('Artikelinhalt konnte nicht extrahiert werden.');
      return;
    }

    const [result, dexData] = await Promise.all([
      chrome.runtime.sendMessage<unknown, ScanResultMessage>({ type: 'SCAN_PAGE', content }),
      chrome.runtime.sendMessage<unknown, PokedexDataMessage>({ type: 'GET_POKEDEX' }),
    ]);

    currentCandidates = result.candidates;
    currentArticleHash = result.articleHash;
    currentArticleUrl = content.url;
    currentArticleTitle = content.headline;

    const caughtIds = new Set(dexData.entries.map(e => e.id));
    renderResults(result, caughtIds);
    setScanState('idle');

    if (result.streak) renderStreak(result.streak);
    if (result.newAchievements?.length) showAchievementToasts(result.newAchievements);

    if (tab.id !== undefined) {
      const newCatches = result.candidates.filter(c => !caughtIds.has(c.politician.id)).length;
      if (result.candidates.length === 0) {
        chrome.action.setBadgeText({ text: '', tabId: tab.id });
      } else if (newCatches > 0) {
        chrome.action.setBadgeText({ text: String(newCatches), tabId: tab.id });
        chrome.action.setBadgeBackgroundColor({ color: '#e94560', tabId: tab.id });
      } else {
        chrome.action.setBadgeText({ text: String(result.candidates.length), tabId: tab.id });
        chrome.action.setBadgeBackgroundColor({ color: '#4caf50', tabId: tab.id });
      }
    }
  } catch (err) {
    console.error('[Polidex popup] Scan error:', err);
    setScanState('idle');
    showStatus('Fehler beim Scannen. Bitte eine Artikelseite öffnen.');
  }
}

function setScanState(state: 'idle' | 'scanning') {
  btnScan.disabled = state === 'scanning';
  btnScan.classList.toggle('scanning', state === 'scanning');
  showStatus(state === 'scanning' ? 'Scanne...' : '');
}

function showStatus(msg: string) { scanStatus.textContent = msg; }

// ─── Achievement toasts ───────────────────────────────────────────────────────

let toastQueue: string[] = [];
let toastRunning = false;

function showAchievementToasts(ids: string[]) {
  toastQueue.push(...ids);
  if (!toastRunning) drainToastQueue();
}

function drainToastQueue() {
  const id = toastQueue.shift();
  if (!id) { toastRunning = false; return; }
  toastRunning = true;

  const def = ACHIEVEMENT_MAP.get(id);
  if (!def) { drainToastQueue(); return; }

  achievementToastName.textContent = def.name;
  achievementToast.classList.remove('hidden');
  achievementToast.classList.add('toast-in');

  setTimeout(() => {
    achievementToast.classList.remove('toast-in');
    achievementToast.classList.add('toast-out');
    setTimeout(() => {
      achievementToast.classList.add('hidden');
      achievementToast.classList.remove('toast-out');
      drainToastQueue();
    }, 400);
  }, 2500);
}

// ─── Results rendering ────────────────────────────────────────────────────────

function renderResults(result: ScanResultMessage, caughtIds: Set<string>) {
  candidateList.textContent = '';

  if (result.candidates.length === 0) {
    resultsEl.classList.add('hidden');
    emptyState.classList.remove('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  resultsEl.classList.remove('hidden');

  resultsCount.textContent = `${result.candidates.length} gefunden`;
  articleBadge.textContent = result.alreadyScanned ? 'bereits gescannt' : 'neuer Artikel';
  articleBadge.className = `badge ${result.alreadyScanned ? 'seen' : 'new'}`;

  for (const candidate of result.candidates) {
    candidateList.appendChild(
      buildCandidateItem(candidate, caughtIds.has(candidate.politician.id))
    );
  }
}

function buildCandidateItem(candidate: MatchCandidate, isCaught: boolean): HTMLLIElement {
  const p = candidate.politician;
  const rarity = calcMediaPresence(p.mediaScore);

  const li = document.createElement('li');
  li.className = `candidate-item${isCaught ? ' caught' : ''}`;
  li.dataset.id = p.id;

  const avatar = document.createElement('div');
  avatar.className = 'candidate-avatar';
  if (p.imageUrl) {
    const img = document.createElement('img');
    img.src = p.imageUrl;
    img.alt = '';
    img.width = 40;
    img.height = 40;
    img.onerror = () => { avatar.textContent = '\u{1F464}'; };
    avatar.appendChild(img);
  } else {
    avatar.textContent = '\u{1F464}';
  }

  const info = document.createElement('div');
  info.className = 'candidate-info';

  const nameEl = document.createElement('div');
  nameEl.className = 'candidate-name';
  nameEl.textContent = buildDisplayName(p);

  const meta = document.createElement('div');
  meta.className = 'candidate-meta';

  const dot = document.createElement('span');
  dot.style.color = PRESENCE_COLORS[rarity];
  dot.textContent = '\u25CF';
  meta.appendChild(dot);
  meta.append(' ');

  const factionSpan = document.createElement('span');
  factionSpan.style.color = FACTION_COLORS[p.faction] ?? 'inherit';
  factionSpan.textContent = p.faction;
  meta.appendChild(factionSpan);
  meta.append(` \u00B7 ${PRESENCE_LABELS[rarity]}`);

  const longevity = calcLongevity(p.periodsActive ?? []);
  if (longevity !== 'NEWCOMER') {
    meta.append(' \u00B7 ');
    const longevitySpan = document.createElement('span');
    longevitySpan.style.color = LONGEVITY_COLORS[longevity];
    longevitySpan.textContent = LONGEVITY_LABELS[longevity];
    meta.appendChild(longevitySpan);
  }

  if (candidate.inHeadline) {
    const hl = document.createElement('b');
    hl.textContent = ' \u00B7 SCHLAGZEILE';
    meta.appendChild(hl);
  }

  info.appendChild(nameEl);
  info.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'candidate-actions';
  if (isCaught) {
    const lbl = document.createElement('span');
    lbl.className = 'btn btn-secondary';
    lbl.style.cssText = 'font-size:10px;padding:3px 6px';
    lbl.textContent = 'GEFANGEN';
    actions.appendChild(lbl);
  } else {
    const catchBtn = document.createElement('button');
    catchBtn.className = 'btn btn-catch';
    catchBtn.textContent = 'FANGEN!';
    catchBtn.addEventListener('click', async e => {
      e.stopPropagation();
      await handleCatch(p.id, candidate.inHeadline);
    });
    actions.appendChild(catchBtn);
  }

  li.appendChild(avatar);
  li.appendChild(info);
  li.appendChild(actions);
  li.addEventListener('click', () => showCandidateDetail(candidate));

  return li;
}

// ─── Catch ────────────────────────────────────────────────────────────────────

async function handleCatch(politicianId: string, inHeadline = false) {
  const result = await chrome.runtime.sendMessage<unknown, CatchResultMessage>({
    type: 'CATCH_POLITICIAN',
    politicianId,
    articleHash:  currentArticleHash,
    articleUrl:   currentArticleUrl,
    articleTitle: currentArticleTitle,
    inHeadline,
  });

  if (result.success && result.entry) {
    animateItem(politicianId, 'catch-anim');
    markItemCaught(politicianId);
    updateDexCount();
    if (result.newAchievements?.length) showAchievementToasts(result.newAchievements);
  } else if (result.alreadyCaught) {
    candidateList.querySelector<HTMLElement>(`[data-id="${politicianId}"]`)
      ?.classList.add('caught');
  }
}

function animateItem(id: string, cls: string) {
  const item = candidateList.querySelector<HTMLElement>(`[data-id="${id}"]`);
  if (!item) return;
  item.classList.add(cls);
  setTimeout(() => item.classList.remove(cls), 700);
}

function markItemCaught(id: string) {
  const item = candidateList.querySelector<HTMLElement>(`[data-id="${id}"]`);
  if (!item) return;
  item.classList.add('caught');
  const actions = item.querySelector('.candidate-actions');
  if (actions) {
    actions.textContent = '';
    const lbl = document.createElement('span');
    lbl.className = 'btn btn-secondary';
    lbl.style.cssText = 'font-size:10px;padding:3px 6px';
    lbl.textContent = 'GEFANGEN';
    actions.appendChild(lbl);
  }
}

// ─── Dex ──────────────────────────────────────────────────────────────────────

async function loadDex() {
  const [result, syncStatus, allData, gameState] = await Promise.all([
    chrome.runtime.sendMessage<unknown, PokedexDataMessage>({ type: 'GET_POKEDEX' }),
    chrome.runtime.sendMessage<unknown, SyncStatusDataMessage>({ type: 'GET_SYNC_STATUS' }),
    chrome.runtime.sendMessage<unknown, AllPoliticiansDataMessage>({ type: 'GET_ALL_POLITICIANS' }),
    chrome.runtime.sendMessage<unknown, GameStateDataMessage>({ type: 'GET_GAME_STATE' }),
  ]);
  dexEntries = result.entries;
  allPoliticians = allData.politicians;
  totalPoliticians = syncStatus.politiciansCount || allPoliticians.length;
  updateDexProgress(result.totalCaught);
  renderFactionStats();
  renderAchievements(gameState.achievements);
  renderDex();
}

function updateDexProgress(caught: number) {
  const total = totalPoliticians || caught;
  const pct = total > 0 ? Math.round((caught / total) * 100) : 0;
  dexCount.textContent = `${caught} / ${total}`;
  dexProgressBar.style.width = `${pct}%`;
  dexProgressBar.title = `${pct}% vollständig`;
}

// ─── Faction stats ────────────────────────────────────────────────────────────

function renderFactionStats() {
  factionStatsEl.textContent = '';

  const caughtIds = new Set(dexEntries.map(e => e.id));

  // Count caught and total per faction
  const stats = new Map<string, { caught: number; total: number }>();
  for (const p of allPoliticians) {
    const f = p.faction;
    if (!stats.has(f)) stats.set(f, { caught: 0, total: 0 });
    stats.get(f)!.total++;
    if (caughtIds.has(p.id)) stats.get(f)!.caught++;
  }

  // Sort factions by total descending
  const sorted = Array.from(stats.entries()).sort((a, b) => b[1].total - a[1].total);

  for (const [faction, { caught, total }] of sorted) {
    const row = document.createElement('div');
    row.className = 'faction-row';

    const label = document.createElement('span');
    label.className = 'faction-label';
    label.style.color = FACTION_COLORS[faction as keyof typeof FACTION_COLORS] ?? 'inherit';
    label.textContent = faction;

    const count = document.createElement('span');
    count.className = 'faction-count';
    count.textContent = `${caught} / ${total}`;

    const barWrap = document.createElement('div');
    barWrap.className = 'faction-bar-wrap';
    const bar = document.createElement('div');
    bar.className = 'faction-bar';
    const pct = total > 0 ? Math.round((caught / total) * 100) : 0;
    bar.style.width = `${pct}%`;
    bar.style.backgroundColor = FACTION_COLORS[faction as keyof typeof FACTION_COLORS] ?? '#555';
    barWrap.appendChild(bar);

    row.appendChild(label);
    row.appendChild(barWrap);
    row.appendChild(count);
    factionStatsEl.appendChild(row);
  }
}

// ─── Achievements ─────────────────────────────────────────────────────────────

function renderAchievements(unlocked: Record<string, number>) {
  achievementsGrid.textContent = '';

  for (const def of ACHIEVEMENT_MAP.values()) {
    const isUnlocked = def.id in unlocked;

    const chip = document.createElement('div');
    chip.className = `achievement-chip${isUnlocked ? ' unlocked' : ''}`;
    chip.title = def.description;

    const icon = document.createElement('span');
    icon.className = 'achievement-icon';
    icon.textContent = isUnlocked ? '\u{1F3C6}' : '\u{1F512}';

    const name = document.createElement('span');
    name.className = 'achievement-name';
    name.textContent = def.name;

    chip.appendChild(icon);
    chip.appendChild(name);
    achievementsGrid.appendChild(chip);
  }
}

// ─── Dex rendering ────────────────────────────────────────────────────────────

function renderDex() {
  const query   = dexSearch.value.trim().toLowerCase();
  const sortKey = dexSort.value as 'recent' | 'level' | 'name' | 'uncaught' | 'longevity';

  dexList.textContent = '';

  if (sortKey === 'uncaught') {
    renderUncaughtDex(query);
    return;
  }

  if (dexEntries.length === 0) {
    dexEmpty.classList.remove('hidden');
    dexNoResults.classList.add('hidden');
    return;
  }
  dexEmpty.classList.add('hidden');

  let filtered = dexEntries;
  if (query) {
    filtered = filtered.filter(e =>
      buildDisplayName(e).toLowerCase().includes(query) ||
      e.faction.toLowerCase().includes(query)
    );
  }

  const sorted = [...filtered].sort((a, b) => {
    if (sortKey === 'level')    return b.level - a.level || b.xp - a.xp;
    if (sortKey === 'name')     return buildDisplayName(a).localeCompare(buildDisplayName(b), 'de');
    if (sortKey === 'longevity') return (b.periodsActive ?? []).length - (a.periodsActive ?? []).length || b.level - a.level;
    return b.caughtAt - a.caughtAt;
  });

  if (sorted.length === 0) {
    dexNoResults.classList.remove('hidden');
    return;
  }
  dexNoResults.classList.add('hidden');

  for (const entry of sorted) {
    dexList.appendChild(buildDexItem(entry));
  }
}

function renderUncaughtDex(query: string) {
  const caughtIds = new Set(dexEntries.map(e => e.id));
  let uncaught = allPoliticians.filter(p => !caughtIds.has(p.id));

  if (query) {
    uncaught = uncaught.filter(p =>
      buildDisplayName(p).toLowerCase().includes(query) ||
      p.faction.toLowerCase().includes(query)
    );
  }

  uncaught.sort((a, b) => buildDisplayName(a).localeCompare(buildDisplayName(b), 'de'));

  if (uncaught.length === 0 && allPoliticians.length === 0) {
    dexEmpty.classList.remove('hidden');
    dexNoResults.classList.add('hidden');
    return;
  }
  dexEmpty.classList.add('hidden');

  if (uncaught.length === 0) {
    dexNoResults.classList.remove('hidden');
    return;
  }
  dexNoResults.classList.add('hidden');

  for (const p of uncaught) {
    dexList.appendChild(buildUncaughtDexItem(p));
  }
}

function buildDexItem(entry: PokedexEntry): HTMLLIElement {
  const rarity = calcMediaPresence(entry.mediaScore);
  const xpToNext = xpForLevel(entry.level + 1);
  const xpBase   = xpForLevel(entry.level);
  const pct = Math.min(100, Math.round(((entry.xp - xpBase) / (xpToNext - xpBase)) * 100));

  const li = document.createElement('li');
  li.className = 'dex-item';

  const avatar = document.createElement('div');
  avatar.className = 'dex-avatar';
  if (entry.imageUrl) {
    const img = document.createElement('img');
    img.src = entry.imageUrl;
    img.alt = '';
    img.width = 32;
    img.height = 32;
    img.onerror = () => { avatar.textContent = '\u{1F464}'; };
    avatar.appendChild(img);
  } else {
    avatar.textContent = '\u{1F464}';
  }

  const info = document.createElement('div');
  info.className = 'dex-info';

  const name = document.createElement('div');
  name.className = 'dex-name';
  name.style.color = PRESENCE_COLORS[rarity];
  name.textContent = buildDisplayName(entry);

  const sub = document.createElement('div');
  sub.className = 'dex-sub';
  const factionSpan = document.createElement('span');
  factionSpan.style.color = FACTION_COLORS[entry.faction] ?? 'inherit';
  factionSpan.textContent = entry.faction;
  sub.appendChild(factionSpan);
  sub.append(` \u00B7 ${entry.articleCount} Artikel`);
  if ((entry.periodsActive ?? []).length > 0) {
    sub.append(` \u00B7 ${entry.periodsActive.length}\u00A0WP`);
  }

  info.appendChild(name);
  info.appendChild(sub);

  const barWrap = document.createElement('div');
  barWrap.className = 'xp-bar-wrap';
  barWrap.title = `${entry.xp} XP`;
  const bar = document.createElement('div');
  bar.className = 'xp-bar';
  bar.style.width = `${pct}%`;
  barWrap.appendChild(bar);

  const lvl = document.createElement('div');
  lvl.className = 'level-badge';
  lvl.textContent = `Lv.${entry.level}`;

  li.appendChild(avatar);
  li.appendChild(info);
  li.appendChild(barWrap);
  li.appendChild(lvl);
  li.addEventListener('click', () => showDexDetail(entry));

  return li;
}

function buildUncaughtDexItem(p: PoliticianData): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'dex-item uncaught';

  const avatar = document.createElement('div');
  avatar.className = 'dex-avatar';
  if (p.imageUrl) {
    const img = document.createElement('img');
    img.src = p.imageUrl;
    img.alt = '';
    img.width = 32;
    img.height = 32;
    img.onerror = () => { avatar.textContent = '\u{1F464}'; };
    avatar.appendChild(img);
  } else {
    avatar.textContent = '\u{1F464}';
  }

  const info = document.createElement('div');
  info.className = 'dex-info';

  const name = document.createElement('div');
  name.className = 'dex-name';
  name.textContent = buildDisplayName(p);

  const sub = document.createElement('div');
  sub.className = 'dex-sub';
  const factionSpan = document.createElement('span');
  factionSpan.style.color = FACTION_COLORS[p.faction] ?? 'inherit';
  factionSpan.textContent = p.faction;
  sub.appendChild(factionSpan);

  info.appendChild(name);
  info.appendChild(sub);

  const badge = document.createElement('div');
  badge.className = 'level-badge';
  badge.style.opacity = '0.4';
  badge.textContent = '?';

  li.appendChild(avatar);
  li.appendChild(info);
  li.appendChild(badge);

  return li;
}

// ─── Detail card ──────────────────────────────────────────────────────────────

function showCandidateDetail(candidate: MatchCandidate) {
  const p = candidate.politician;
  showCard({
    name: buildDisplayName(p),
    faction: p.faction,
    types: p.types,
    imageUrl: p.imageUrl,
    rarity: calcMediaPresence(p.mediaScore),
    periodsActive: p.periodsActive ?? [],
    stats: [
      { label: 'Treffer-Score', value: String(candidate.score) },
      { label: 'Erwähnungen',   value: String(candidate.mentionCount) },
      { label: 'Schlagzeile',   value: candidate.inHeadline ? 'Ja' : 'Nein' },
    ],
  });
}

function showDexDetail(entry: PokedexEntry) {
  showCard({
    name: buildDisplayName(entry),
    faction: entry.faction,
    types: entry.types,
    imageUrl: entry.imageUrl,
    rarity: calcMediaPresence(entry.mediaScore),
    periodsActive: entry.periodsActive ?? [],
    stats: [
      { label: 'Level',   value: String(entry.level) },
      { label: 'XP',      value: String(entry.xp) },
      { label: 'Artikel', value: String(entry.articleCount) },
    ],
    caughtUrl:   entry.caughtUrl,
    caughtTitle: entry.caughtTitle,
    levelUp: false,
  });
}

interface CardConfig {
  name: string;
  faction: string;
  types: string[];
  imageUrl?: string;
  rarity: import('../types/index.js').MediaPresence;
  periodsActive: number[];
  stats: Array<{ label: string; value: string }>;
  caughtUrl?: string;
  caughtTitle?: string;
  levelUp?: boolean;
}

function showCard(cfg: CardConfig) {
  detailCard.textContent = '';

  if (cfg.imageUrl) {
    const img = document.createElement('img');
    img.className = 'card-img';
    img.src = cfg.imageUrl;
    img.alt = '';
    img.onerror = () => {
      const ph = document.createElement('div');
      ph.className = 'card-img-placeholder';
      ph.textContent = '\u{1F464}';
      img.replaceWith(ph);
    };
    detailCard.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className = 'card-img-placeholder';
    ph.textContent = '\u{1F464}';
    detailCard.appendChild(ph);
  }

  const nameEl = document.createElement('div');
  nameEl.className = 'card-name';
  nameEl.textContent = cfg.name;
  detailCard.appendChild(nameEl);

  const factionEl = document.createElement('div');
  factionEl.className = 'card-faction';
  factionEl.style.color = FACTION_COLORS[cfg.faction as keyof typeof FACTION_COLORS] ?? '';
  factionEl.textContent = cfg.faction;
  detailCard.appendChild(factionEl);

  const typesEl = document.createElement('div');
  typesEl.className = 'card-types';
  for (const t of cfg.types) {
    const chip = document.createElement('span');
    chip.className = 'type-chip';
    chip.textContent = TYPE_LABELS[t as keyof typeof TYPE_LABELS] ?? t;
    typesEl.appendChild(chip);
  }
  detailCard.appendChild(typesEl);

  if (cfg.periodsActive.length > 0) {
    const periodsEl = document.createElement('div');
    periodsEl.className = 'card-periods';
    for (const wp of cfg.periodsActive) {
      const badge = document.createElement('span');
      badge.className = 'period-badge';
      badge.textContent = `WP${wp}`;
      periodsEl.appendChild(badge);
    }
    detailCard.appendChild(periodsEl);
  }

  const rarityEl = document.createElement('div');
  rarityEl.className = 'card-rarity';
  rarityEl.style.color = PRESENCE_COLORS[cfg.rarity];
  rarityEl.textContent = PRESENCE_LABELS[cfg.rarity].toUpperCase();
  detailCard.appendChild(rarityEl);

  const statsEl = document.createElement('div');
  statsEl.className = 'card-stats';
  for (const s of cfg.stats) {
    const row = document.createElement('div');
    row.className = 'stat-row';
    const lbl = document.createElement('span');
    lbl.className = 'stat-label';
    lbl.textContent = s.label;
    const val = document.createElement('span');
    val.className = 'stat-value';
    val.textContent = s.value;
    row.appendChild(lbl);
    row.appendChild(val);
    statsEl.appendChild(row);
  }
  detailCard.appendChild(statsEl);

  if (cfg.caughtUrl && cfg.caughtTitle) {
    const caughtEl = document.createElement('div');
    caughtEl.className = 'card-caught-in';

    const label = document.createElement('span');
    label.className = 'stat-label';
    label.textContent = 'Gefangen in ';
    caughtEl.appendChild(label);

    const link = document.createElement('a');
    link.className = 'card-caught-link';
    link.textContent = cfg.caughtTitle;
    link.title = cfg.caughtUrl;
    link.addEventListener('click', e => {
      e.preventDefault();
      chrome.tabs.create({ url: cfg.caughtUrl });
    });
    caughtEl.appendChild(link);

    detailCard.appendChild(caughtEl);
  }

  if (cfg.levelUp) {
    detailCard.classList.add('level-up-anim');
    setTimeout(() => detailCard.classList.remove('level-up-anim'), 700);
  }

  cardOverlay.classList.remove('hidden');
}

// ─── Sync status ──────────────────────────────────────────────────────────────

async function loadSyncStatus() {
  const status = await chrome.runtime.sendMessage<unknown, SyncStatusDataMessage>({
    type: 'GET_SYNC_STATUS',
  });

  if (status.syncInProgress) {
    syncLabel.textContent = 'Daten werden synchronisiert...';
    syncLabel.className = 'sync-label';
    btnSync.classList.add('hidden');
    return;
  }

  if (status.politiciansCount === 0) {
    syncLabel.textContent = 'Keine Daten geladen';
    syncLabel.className = 'sync-label warn';
    btnSync.classList.remove('hidden');
    return;
  }

  const days = status.lastSyncAt
    ? Math.floor((Date.now() - status.lastSyncAt) / 86_400_000)
    : null;
  const age = days === null ? '' : days === 0 ? ' (heute)' : ` (vor ${days}T.)`;

  syncLabel.textContent = `${status.politiciansCount} Politiker${age}`;
  syncLabel.className = 'sync-label';

  if (days !== null && days > 2) {
    btnSync.classList.remove('hidden');
  } else {
    btnSync.classList.add('hidden');
  }
}

async function handleSyncNow() {
  btnSync.disabled = true;
  syncLabel.textContent = 'Synchronisiere...';
  syncLabel.className = 'sync-label';
  await chrome.runtime.sendMessage({ type: 'SYNC_POLITICIANS' });
  btnSync.disabled = false;
  await loadSyncStatus();
}

// ─── Export / Import ──────────────────────────────────────────────────────────

async function handleExport() {
  const result = await chrome.runtime.sendMessage<unknown, PokedexDataMessage>({ type: 'GET_POKEDEX' });
  if (result.entries.length === 0) {
    showStatus('Noch nichts zum Exportieren.');
    return;
  }

  const caught: Record<string, object> = {};
  for (const entry of result.entries) {
    caught[entry.id] = {
      id: entry.id,
      xp: entry.xp,
      level: entry.level,
      caughtAt: entry.caughtAt,
      articleCount: entry.articleCount,
      lastSeenAt: entry.lastSeenAt,
    };
  }

  const blob = new Blob(
    [JSON.stringify({ version: 1, caught }, null, 2)],
    { type: 'application/json' }
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `polidex-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function handleImport() {
  const file = importFile.files?.[0];
  if (!file) return;
  importFile.value = '';

  try {
    const text = await file.text();
    const parsed = JSON.parse(text) as { version?: number; caught?: unknown };

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.caught !== 'object' ||
      parsed.caught === null
    ) {
      showStatus('Ungültige Exportdatei.');
      return;
    }

    const result = await chrome.runtime.sendMessage<unknown, ImportResultMessage>({
      type: 'IMPORT_COLLECTION',
      caught: parsed.caught,
    });

    if (result.error) {
      showStatus(`Import fehlgeschlagen: ${result.error}`);
    } else {
      showStatus(`${result.imported} neue Einträge importiert.`);
      await loadDex();
    }
  } catch {
    showStatus('Datei konnte nicht gelesen werden.');
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildDisplayName(p: { title?: string; firstName: string; lastName: string }): string {
  return [p.title, p.firstName, p.lastName].filter(Boolean).join(' ');
}

async function updateDexCount() {
  const r = await chrome.runtime.sendMessage<unknown, PokedexDataMessage>({ type: 'GET_POKEDEX' });
  updateDexProgress(r.totalCaught);
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

void currentCandidates;
void calcLevel;
