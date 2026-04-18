/**
 * Popup script — orchestrates the UI.
 * Communicates with:
 *   - content script (EXTRACT_CONTENT) via chrome.tabs.sendMessage
 *   - background (SCAN_PAGE, CATCH_POLITICIAN, GET_POKEDEX, etc.) via chrome.runtime.sendMessage
 *
 * All dynamic content is inserted via DOM methods (textContent / setAttribute)
 * to prevent XSS — no innerHTML with external data.
 */

import browser from 'webextension-polyfill';
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
  Longevity,
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
  TYPE_COLORS,
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
const btnCatchAll      = el<HTMLButtonElement>('btn-catch-all');
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

const statsContent     = el('stats-content');

const helpOverlay      = el('help-overlay');
const btnHelp          = el<HTMLButtonElement>('btn-help');
const btnCloseHelp     = el<HTMLButtonElement>('btn-close-help');

const achievementToast     = el('achievement-toast');
const achievementToastName = el('achievement-toast-name');

const pinBanner        = el('pin-banner');
const btnDismissPin    = el<HTMLButtonElement>('btn-dismiss-pin');
const btnOpenWelcome   = el<HTMLButtonElement>('btn-open-welcome');

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
btnCatchAll.addEventListener('click', handleCatchAll);
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
loadPinBanner();

btnDismissPin.addEventListener('click', async () => {
  pinBanner.classList.add('hidden');
  await browser.storage.local.set({ pinReminderDismissed: true });
});

btnOpenWelcome.addEventListener('click', () => {
  browser.tabs.create({ url: browser.runtime.getURL('welcome.html') });
  window.close();
});

// ─── Pin reminder ─────────────────────────────────────────────────────────────

async function loadPinBanner() {
  const stored = await browser.storage.local.get('pinReminderDismissed') as { pinReminderDismissed?: boolean };
  if (!stored.pinReminderDismissed) {
    pinBanner.classList.remove('hidden');
  }
}

// ─── Tab navigation ───────────────────────────────────────────────────────────

function switchTab(tab: 'scan' | 'dex') {
  document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach(b => {
    const isActive = b.dataset.tab === tab;
    b.classList.toggle('active', isActive);
    b.setAttribute('aria-selected', String(isActive));
  });
  tabScan.classList.toggle('hidden', tab !== 'scan');
  tabDex.classList.toggle('hidden',  tab !== 'dex');
  if (tab === 'dex') loadDex();
}

// ─── Streak display ───────────────────────────────────────────────────────────

async function loadStreak() {
  const state = await browser.runtime.sendMessage({ type: 'GET_GAME_STATE' }) as GameStateDataMessage;
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
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab');

    const extracted = await browser.tabs.sendMessage(tab.id, { type: 'EXTRACT_CONTENT' }) as ExtractContentResult;

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

    const [result, dexData] = (await Promise.all([
      browser.runtime.sendMessage({ type: 'SCAN_PAGE', content }),
      browser.runtime.sendMessage({ type: 'GET_POKEDEX' }),
    ])) as [ScanResultMessage, PokedexDataMessage];

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
        browser.action.setBadgeText({ text: '', tabId: tab.id });
      } else if (newCatches > 0) {
        browser.action.setBadgeText({ text: String(newCatches), tabId: tab.id });
        browser.action.setBadgeBackgroundColor({ color: '#ed4560', tabId: tab.id });
      } else {
        browser.action.setBadgeText({ text: String(result.candidates.length), tabId: tab.id });
        browser.action.setBadgeBackgroundColor({ color: '#4caf50', tabId: tab.id });
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
    btnCatchAll.classList.add('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  resultsEl.classList.remove('hidden');

  resultsCount.textContent = `${result.candidates.length} gefunden`;
  articleBadge.textContent = result.alreadyScanned ? 'bereits gescannt' : 'neuer Artikel';
  articleBadge.className = `badge ${result.alreadyScanned ? 'seen' : 'new'}`;

  const hasUncaught = result.candidates.some(c => !caughtIds.has(c.politician.id));
  btnCatchAll.classList.toggle('hidden', !hasUncaught);

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
  dot.setAttribute('aria-hidden', 'true');
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
    lbl.textContent = 'GESAMMELT';
    actions.appendChild(lbl);
  } else {
    const catchBtn = document.createElement('button');
    catchBtn.className = 'btn btn-catch';
    catchBtn.textContent = 'SAMMELN!';
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
  const result = await browser.runtime.sendMessage({
    type: 'CATCH_POLITICIAN',
    politicianId,
    articleHash:  currentArticleHash,
    articleUrl:   currentArticleUrl,
    articleTitle: currentArticleTitle,
    inHeadline,
  }) as CatchResultMessage;

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

async function handleCatchAll() {
  btnCatchAll.disabled = true;
  for (const candidate of currentCandidates) {
    const item = candidateList.querySelector<HTMLElement>(`[data-id="${candidate.politician.id}"]`);
    if (!item?.classList.contains('caught')) {
      await handleCatch(candidate.politician.id, candidate.inHeadline);
    }
  }
  btnCatchAll.disabled = false;
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
    lbl.textContent = 'GESAMMELT';
    actions.appendChild(lbl);
  }
  const allCaught = !candidateList.querySelector('.candidate-item:not(.caught)');
  if (allCaught) btnCatchAll.classList.add('hidden');
}

// ─── Dex ──────────────────────────────────────────────────────────────────────

async function loadDex() {
  const [result, syncStatus, allData, gameState] = (await Promise.all([
    browser.runtime.sendMessage({ type: 'GET_POKEDEX' }),
    browser.runtime.sendMessage({ type: 'GET_SYNC_STATUS' }),
    browser.runtime.sendMessage({ type: 'GET_ALL_POLITICIANS' }),
    browser.runtime.sendMessage({ type: 'GET_GAME_STATE' }),
  ])) as [PokedexDataMessage, SyncStatusDataMessage, AllPoliticiansDataMessage, GameStateDataMessage];
  dexEntries = result.entries;
  allPoliticians = allData.politicians;
  totalPoliticians = syncStatus.politiciansCount || allPoliticians.length;
  updateDexProgress(result.totalCaught);
  renderFactionStats();
  renderAchievements(gameState.achievements);
  renderStats();
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
    icon.textContent = isUnlocked ? (def.icon ?? '\u{1F3C6}') : '\u{1F512}';

    const name = document.createElement('span');
    name.className = 'achievement-name';
    name.textContent = def.name;

    chip.appendChild(icon);
    chip.appendChild(name);
    achievementsGrid.appendChild(chip);
  }
}

// ─── Statistics ───────────────────────────────────────────────────────────────

function renderStats(): void {
  statsContent.textContent = '';
  if (dexEntries.length === 0) return;

  // Block A — Übersicht
  const overviewBlock = makeStatsBlock('ÜBERSICHT');
  const totalXp       = dexEntries.reduce((s, e) => s + e.xp, 0);
  const totalArticles = dexEntries.reduce((s, e) => s + e.articleCount, 0);
  const maxLevel      = dexEntries.reduce((m, e) => Math.max(m, e.level), 0);
  const grid = document.createElement('div');
  grid.className = 'stats-overview-grid';
  for (const [k, v] of [
    ['Gesammelt',      `${dexEntries.length} / ${totalPoliticians}`],
    ['Gesamt-XP',      String(totalXp)],
    ['Gesamtartikel',  String(totalArticles)],
    ['Höchstes Lv.',   String(maxLevel)],
  ] as [string, string][]) {
    const cell = document.createElement('div');
    cell.className = 'stats-kv';
    const kEl = document.createElement('span'); kEl.className = 'stats-k'; kEl.textContent = k;
    const vEl = document.createElement('span'); vEl.className = 'stats-v'; vEl.textContent = v;
    cell.appendChild(kEl); cell.appendChild(vEl);
    grid.appendChild(cell);
  }
  overviewBlock.appendChild(grid);
  statsContent.appendChild(overviewBlock);

  // Block B — Wahlperioden
  const PERIOD_LABELS: Record<number, string> = {
    16: 'WP16  2005–09',
    17: 'WP17  2009–13',
    18: 'WP18  2013–17',
    19: 'WP19  2017–21',
    20: 'WP20  2021–25',
    21: 'WP21  2025–',
  };
  const periodsBlock = makeStatsBlock('FORTSCHRITT JE WAHLPERIODE');
  const wpTotals = new Map<number, number>();
  const wpCaught = new Map<number, number>();
  for (const p of allPoliticians) {
    for (const wp of p.periodsActive) wpTotals.set(wp, (wpTotals.get(wp) ?? 0) + 1);
  }
  for (const e of dexEntries) {
    for (const wp of e.periodsActive) wpCaught.set(wp, (wpCaught.get(wp) ?? 0) + 1);
  }
  for (const wp of [...wpTotals.keys()].sort((a, b) => b - a)) {
    const tot = wpTotals.get(wp) ?? 0;
    const c   = wpCaught.get(wp) ?? 0;
    const pct = tot > 0 ? Math.round((c / tot) * 100) : 0;
    periodsBlock.appendChild(buildStatsBar(PERIOD_LABELS[wp] ?? `WP${wp}`, c, pct, '#607d8b', `${c} / ${tot}`));
  }
  statsContent.appendChild(periodsBlock);

  // Block C — Medienpräsenz
  const presenceBlock  = makeStatsBlock('MEDIENPRÄSENZ');
  const presenceCounts = new Map<string, number>();
  for (const e of dexEntries) {
    const tier = calcMediaPresence(e.mediaScore);
    presenceCounts.set(tier, (presenceCounts.get(tier) ?? 0) + 1);
  }
  const total = dexEntries.length;
  for (const tier of ['OBSCURE', 'MINOR', 'NOTABLE', 'PROMINENT'] as const) {
    const count = presenceCounts.get(tier) ?? 0;
    presenceBlock.appendChild(buildStatsBar(PRESENCE_LABELS[tier], count, total > 0 ? Math.round((count / total) * 100) : 0, PRESENCE_COLORS[tier]));
  }
  statsContent.appendChild(presenceBlock);

  // Block D — Typenverteilung
  const typeBlock  = makeStatsBlock('TYPEN');
  const typeCounts = new Map<string, number>();
  for (const e of dexEntries) {
    for (const t of e.types) typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
  }
  const maxTypeCount = Math.max(...typeCounts.values(), 1);
  for (const [type, count] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const label = TYPE_LABELS[type as keyof typeof TYPE_LABELS] ?? type;
    const color = TYPE_COLORS[type as keyof typeof TYPE_COLORS] ?? '#888';
    typeBlock.appendChild(buildStatsBar(label, count, Math.round((count / maxTypeCount) * 100), color));
  }
  statsContent.appendChild(typeBlock);

  // Block E — Sammelaktivität
  const heatBlock = makeStatsBlock('SAMMELAKTIVITÄT');
  heatBlock.appendChild(buildHeatmap());
  statsContent.appendChild(heatBlock);
}

function makeStatsBlock(title: string): HTMLDivElement {
  const block = document.createElement('div');
  block.className = 'stats-block';
  const titleEl = document.createElement('div');
  titleEl.className = 'stats-block-title';
  titleEl.textContent = title;
  block.appendChild(titleEl);
  return block;
}

function buildStatsBar(label: string, count: number, pct: number, color: string, countText?: string): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'stats-bar-row';
  const lbl = document.createElement('span'); lbl.className = 'stats-bar-label'; lbl.textContent = label;
  const wrap = document.createElement('div'); wrap.className = 'stats-bar-wrap';
  const bar = document.createElement('div');  bar.className  = 'stats-bar';
  bar.style.width = `${pct}%`; bar.style.backgroundColor = color;
  wrap.appendChild(bar);
  const cnt = document.createElement('span'); cnt.className = 'stats-bar-count'; cnt.textContent = countText ?? String(count);
  row.appendChild(lbl); row.appendChild(wrap); row.appendChild(cnt);
  return row;
}

function buildHeatmap(): HTMLDivElement {
  const dayCounts = new Map<string, number>();
  for (const e of dexEntries) {
    const day = new Date(e.caughtAt).toISOString().slice(0, 10);
    dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
  }
  const grid = document.createElement('div');
  grid.className = 'heat-grid';
  const today = new Date();
  for (let i = 83; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key   = d.toISOString().slice(0, 10);
    const count = dayCounts.get(key) ?? 0;
    const cell  = document.createElement('div');
    const level = count === 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : 3;
    cell.className = `heat-cell heat-${level}`;
    cell.title = `${key}: ${count} gesammelt`;
    grid.appendChild(cell);
  }
  return grid;
}

// ─── Dex rendering ────────────────────────────────────────────────────────────

function renderDex() {
  const query   = dexSearch.value.trim().toLowerCase();
  const sortKey = dexSort.value as 'recent' | 'level' | 'name' | 'uncaught' | 'longevity' | 'articles' | 'rarity' | 'type';

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
    if (sortKey === 'articles') return b.articleCount - a.articleCount || b.xp - a.xp;
    if (sortKey === 'rarity') {
      const RARITY_ORDER: Record<string, number> = { OBSCURE: 0, PROMINENT: 1, NOTABLE: 2, MINOR: 3 };
      return (RARITY_ORDER[calcMediaPresence(a.mediaScore)] ?? 4) - (RARITY_ORDER[calcMediaPresence(b.mediaScore)] ?? 4) || b.caughtAt - a.caughtAt;
    }
    if (sortKey === 'type') {
      const ta = TYPE_LABELS[a.types[0] as keyof typeof TYPE_LABELS] ?? 'Z';
      const tb = TYPE_LABELS[b.types[0] as keyof typeof TYPE_LABELS] ?? 'Z';
      return ta.localeCompare(tb, 'de') || buildDisplayName(a).localeCompare(buildDisplayName(b), 'de');
    }
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
  li.className = entry.isArchived ? 'dex-item archived' : 'dex-item';

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
  const rarityHint = document.createElement('span');
  rarityHint.className = 'sr-only';
  rarityHint.textContent = ` (${PRESENCE_LABELS[rarity]})`;
  name.appendChild(rarityHint);

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
  if (entry.isArchived) {
    const archivedTag = document.createElement('span');
    archivedTag.className = 'archived-tag';
    archivedTag.textContent = 'ehem.';
    sub.appendChild(archivedTag);
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
    levelUp:     false,
    isArchived:  entry.isArchived,
    longevity:   calcLongevity(entry.periodsActive ?? []),
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
  isArchived?: boolean;
  longevity?: Longevity;
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

  if (cfg.isArchived) {
    const archivedEl = document.createElement('div');
    archivedEl.className = 'card-archived-badge';
    archivedEl.textContent = 'Ehemaliger MdB';
    detailCard.appendChild(archivedEl);
  }

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

  if (cfg.longevity) {
    const longevityEl = document.createElement('div');
    longevityEl.className = 'card-longevity';
    longevityEl.style.color = LONGEVITY_COLORS[cfg.longevity];
    longevityEl.textContent = LONGEVITY_LABELS[cfg.longevity].toUpperCase();
    detailCard.appendChild(longevityEl);
  }

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
    label.textContent = 'Gesammelt in ';
    caughtEl.appendChild(label);

    const link = document.createElement('a');
    link.className = 'card-caught-link';
    link.textContent = cfg.caughtTitle;
    link.title = cfg.caughtUrl;
    link.addEventListener('click', e => {
      e.preventDefault();
      try {
        const parsed = new URL(cfg.caughtUrl!);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
          browser.tabs.create({ url: cfg.caughtUrl });
        }
      } catch { /* invalid URL */ }
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
  const status = await browser.runtime.sendMessage({ type: 'GET_SYNC_STATUS' }) as SyncStatusDataMessage;

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
  await browser.runtime.sendMessage({ type: 'SYNC_POLITICIANS' });
  await loadSyncStatus();
  setTimeout(() => { btnSync.disabled = false; }, 60_000);
}

// ─── Export / Import ──────────────────────────────────────────────────────────

async function handleExport() {
  const result = await browser.runtime.sendMessage({ type: 'GET_POKEDEX' }) as PokedexDataMessage;
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

  if (file.size > 2_000_000) {
    showStatus('Datei zu groß (max. 2 MB).');
    return;
  }

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

    const result = await browser.runtime.sendMessage({
      type: 'IMPORT_COLLECTION',
      caught: parsed.caught,
    }) as ImportResultMessage;

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
  const r = await browser.runtime.sendMessage({ type: 'GET_POKEDEX' }) as PokedexDataMessage;
  updateDexProgress(r.totalCaught);
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

void currentCandidates;
void calcLevel;
