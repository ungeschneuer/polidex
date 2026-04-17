/**
 * Content Script — runs on every page, only does work when the popup triggers a scan.
 *
 * Responsibilities:
 * - Extract headline and body text from the current article
 * - Detect page language
 * - Send extracted content to the background service worker
 */

import type { ArticleContent, ExtractContentResult, ScanPageMessage } from '../types/index.js';
import { isBlockedDomain, isKnownNewsDomain } from '../shared/constants.js';

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'EXTRACT_CONTENT') {
    sendResponse(extractContent());
  }
  return true;
});

// Proactively notify the background so it can update the toolbar badge.
// Runs once per page load (content scripts are injected fresh per navigation).
(function notifyArticleStatus() {
  const url = window.location.href;
  const isArticle = !isBlockedDomain(url) && isNewsArticle();
  chrome.runtime.sendMessage({ type: 'ARTICLE_STATUS', isArticle }).catch(() => {
    // Service worker may be suspended — not critical.
  });
}());

// ─── DOM extraction ───────────────────────────────────────────────────────────

function extractContent(): ExtractContentResult {
  if (isBlockedDomain(window.location.href)) return { blocked: true };
  if (!isNewsArticle()) return { notArticle: true };
  return { content: extractArticleContent() };
}

export function extractArticleContent(): ArticleContent {
  const url = window.location.href;
  const lang = detectLanguage();

  return {
    url,
    headline: extractHeadline(),
    bodyText: extractBodyText(),
    lang,
  };
}

/**
 * Returns true if the current page shows strong signals of being a news article.
 * Checks (in priority order):
 *   1. JSON-LD @type matching a NewsArticle family type
 *   2. og:type="article" + article:published_time meta tags
 *   3. Structural heuristic: <article> + (<time datetime> or byline) + <h1>
 */
function isNewsArticle(): boolean {
  // 0. Known news domain — trust it without inspecting the DOM further
  if (isKnownNewsDomain(window.location.href)) return true;

  // 1. JSON-LD
  const NEWS_TYPES = new Set([
    'NewsArticle', 'ReportageNewsArticle', 'AnalysisNewsArticle',
    'OpinionNewsArticle', 'BackgroundNewsArticle', 'ReviewNewsArticle',
    'LiveBlogPosting', 'ClaimReview',
  ]);
  for (const el of Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'))) {
    try {
      const data = JSON.parse(el.textContent ?? '') as unknown;
      const types: string[] = [];
      if (Array.isArray(data)) {
        for (const item of data) {
          const t = (item as Record<string, unknown>)['@type'];
          if (typeof t === 'string') types.push(t);
          else if (Array.isArray(t)) types.push(...(t as string[]));
        }
      } else if (data && typeof data === 'object') {
        const t = (data as Record<string, unknown>)['@type'];
        if (typeof t === 'string') types.push(t);
        else if (Array.isArray(t)) types.push(...(t as string[]));
      }
      if (types.some(t => NEWS_TYPES.has(t))) return true;
    } catch { /* malformed JSON-LD */ }
  }

  // 2. OpenGraph article + published time
  const ogType = document.querySelector<HTMLMetaElement>('meta[property="og:type"]')?.content;
  const publishedTime = document.querySelector<HTMLMetaElement>(
    'meta[property="article:published_time"], meta[name="article:published_time"], ' +
    'meta[name="pubdate"], meta[name="publish-date"], meta[name="date"]'
  )?.content;
  if (ogType === 'article' && publishedTime) return true;

  // 3. Structural heuristic
  const hasArticle = !!document.querySelector('article, [role="article"], [itemtype*="Article"]');
  const hasTime = !!document.querySelector('time[datetime], [class*="date"], [class*="byline"], [class*="author"]');
  const hasH1 = !!document.querySelector('h1');
  if (hasArticle && hasTime && hasH1) return true;

  return false;
}

/**
 * Headline extraction with fallback chain.
 * Priority: og:title > <h1> inside article (kicker-filtered) > first <h1> > document.title
 *
 * og:title is preferred because it is always clean — sites like Tagesschau embed
 * a "kicker" span (section label) inside the h1 alongside the actual headline text,
 * causing extracting h1.textContent to include irrelevant category prefixes.
 */
function extractHeadline(): string {
  // 1. OpenGraph title — most reliable, always kicker-free
  const ogTitle = document.querySelector<HTMLMetaElement>('meta[property="og:title"]');
  if (ogTitle?.content?.trim()) return ogTitle.content.trim();

  // 2. <h1> inside article, with kicker/topline child spans filtered out
  const articleH1 = document.querySelector('article h1, [role="article"] h1, main h1');
  if (articleH1) {
    const text = cleanH1Text(articleH1);
    if (text) return text;
  }

  // 3. First <h1> on page, kicker-filtered
  const h1 = document.querySelector('h1');
  if (h1) {
    const text = cleanH1Text(h1);
    if (text) return text;
  }

  // 4. Twitter title
  const twitterTitle = document.querySelector<HTMLMetaElement>('meta[name="twitter:title"]');
  if (twitterTitle?.content) return twitterTitle.content.trim();

  return document.title.trim();
}

/**
 * Extracts the main headline text from an h1 element, skipping any child elements
 * that look like kickers, section labels, or toplines (common in German news sites).
 */
function cleanH1Text(h1: Element): string {
  const KICKER_PATTERN = /topline|kicker|rubrik|label|category|dachzeile|overline|eyebrow|supertitle/i;
  const children = Array.from(h1.children);

  if (children.length > 0) {
    // Find the first child that does NOT look like a kicker
    const headlineChild = children.find(c => !KICKER_PATTERN.test(c.className));
    if (headlineChild?.textContent?.trim()) return headlineChild.textContent.trim();
  }

  return h1.textContent?.trim() ?? '';
}

/**
 * Body text extraction.
 *
 * Strategy:
 * 1. Look for article body selectors used by major German news sites
 * 2. Fall back to generic semantic elements
 * 3. Strip boilerplate (nav, footer, aside, ads)
 * 4. Deduplicate whitespace
 */
function extractBodyText(): string {
  // Selectors for major German and international news sites
  const ARTICLE_SELECTORS = [
    // Generic semantic
    'article',
    '[role="article"]',
    '[itemprop="articleBody"]',
    // Common CMS class patterns
    '.article-body',
    '.article__body',
    '.article-content',
    '.story-body',
    '.entry-content',
    '.post-content',
    // Site-specific (non-exhaustive)
    '.RichTextArticle',         // Spiegel
    '.article__text',           // Zeit
    '.content__article-body',   // Guardian
    '.c-article-body',          // various
    '#article-body',
  ];

  // Nodes to exclude from text extraction
  const EXCLUDE_SELECTORS = [
    'nav', 'header', 'footer', 'aside',
    '.ad', '.advertisement', '.banner',
    '.social-share', '.share-buttons',
    '.related-articles', '.recommendations',
    'script', 'style', 'noscript',
    '[aria-hidden="true"]',
    '.paywall', '.subscription-wall',
  ];

  let container: Element | null = null;
  for (const selector of ARTICLE_SELECTORS) {
    container = document.querySelector(selector);
    if (container) break;
  }

  if (!container) {
    // Last resort: use body but be aggressive about stripping boilerplate
    container = document.body;
  }

  // Clone to avoid mutating the DOM
  const clone = container.cloneNode(true) as Element;

  // Remove boilerplate nodes from clone
  for (const selector of EXCLUDE_SELECTORS) {
    clone.querySelectorAll(selector).forEach(el => el.remove());
  }

  // Extract text, preserving paragraph breaks
  const paragraphs = clone.querySelectorAll('p, h2, h3, h4, li, blockquote');
  if (paragraphs.length > 0) {
    return Array.from(paragraphs)
      .map(el => el.textContent?.trim() ?? '')
      .filter(t => t.length > 20) // skip very short fragments
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 50_000); // cap at 50k chars to avoid huge storage entries
  }

  return (clone.textContent ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50_000);
}

/**
 * Detects page language from HTML lang attribute or meta tags.
 * Returns 'de', 'en', or 'unknown'.
 */
function detectLanguage(): 'de' | 'en' | 'unknown' {
  const lang = (
    document.documentElement.lang ||
    document.querySelector<HTMLMetaElement>('meta[http-equiv="content-language"]')?.content ||
    document.querySelector<HTMLMetaElement>('meta[name="language"]')?.content ||
    ''
  ).toLowerCase().trim();

  if (lang.startsWith('de')) return 'de';
  if (lang.startsWith('en')) return 'en';
  return 'unknown';
}

// ─── Manual scan trigger (called from popup via chrome.tabs.sendMessage) ──────

export async function triggerScan(): Promise<void> {
  const content = extractArticleContent();
  const message: ScanPageMessage = { type: 'SCAN_PAGE', content };
  chrome.runtime.sendMessage(message);
}
