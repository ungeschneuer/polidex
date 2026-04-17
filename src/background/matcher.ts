/**
 * Politician matching engine.
 *
 * Strategy:
 * 1. Headline scan:  surname-only trigger (fast path)
 * 2. Body scan:      disambiguation via full name, party, role context
 * 3. Fuzzy matching: Levenshtein distance for typo/OCR tolerance
 * 4. Scoring:        weighted signals → accept only above threshold
 */

import type { PoliticianData, ArticleContent, MatchCandidate } from '../types/index.js';
import {
  MATCH_THRESHOLD,
  SCORE_FULL_NAME,
  SCORE_SURNAME_PARTY,
  SCORE_SURNAME_ROLE,
  SCORE_COMMON_SURNAME_PENALTY,
  SCORE_HEADLINE_BONUS,
  SCORE_MULTI_MENTION_BONUS,
} from '../shared/constants.js';

// ─── Public API ───────────────────────────────────────────────────────────────

export function findMatches(
  politicians: PoliticianData[],
  article: ArticleContent
): MatchCandidate[] {
  const headlineLower = article.headline.toLowerCase();
  const bodyLower    = article.bodyText.toLowerCase();

  // Pre-filter: only consider politicians whose surname appears somewhere
  const candidates = politicians.filter(p => {
    const surname = p.lastName.toLowerCase();
    return headlineLower.includes(surname) || bodyLower.includes(surname);
  });

  const results: MatchCandidate[] = [];

  for (const politician of candidates) {
    const candidate = scorePolitician(politician, article, headlineLower, bodyLower);
    if (candidate.score >= MATCH_THRESHOLD) {
      results.push(candidate);
    }
  }

  // Sort by score descending
  return results.sort((a, b) => b.score - a.score);
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

function scorePolitician(
  politician: PoliticianData,
  article: ArticleContent,
  headlineLower: string,
  bodyLower: string
): MatchCandidate {
  let score = 0;
  let matchedName = politician.lastName;
  const inHeadline = headlineLower.includes(politician.lastName.toLowerCase());
  let mentionCount = 0;

  // 1. Full name in body (most reliable signal)
  const fullName = buildFullName(politician);
  const fullNameLower = fullName.toLowerCase();
  if (bodyLower.includes(fullNameLower)) {
    score += SCORE_FULL_NAME;
    matchedName = fullName;
    mentionCount = countOccurrences(bodyLower, fullNameLower);
  }

  // 2. Surname + party name in body
  const surnameLower = politician.lastName.toLowerCase();
  const factionLower = politician.faction.toLowerCase();
  if (bodyLower.includes(surnameLower) && bodyLower.includes(factionLower)) {
    score += SCORE_SURNAME_PARTY;
    mentionCount = mentionCount || countOccurrences(bodyLower, surnameLower);
  }

  // 3. Surname + role keywords in body
  const roleKeywords = getRoleKeywords(article.lang);
  if (bodyLower.includes(surnameLower) && roleKeywords.some(kw => bodyLower.includes(kw))) {
    score += SCORE_SURNAME_ROLE;
  }

  // 4. Common surname penalty
  if (politician.isCommonSurname) {
    score += SCORE_COMMON_SURNAME_PENALTY;
  }

  // 5. Headline bonus
  if (inHeadline) {
    score += SCORE_HEADLINE_BONUS;
  }

  // 6. Multiple body mentions bonus (capped at 3 extra)
  if (mentionCount > 1) {
    score += Math.min(mentionCount - 1, 3) * SCORE_MULTI_MENTION_BONUS;
  }

  // 7. Fuzzy matching for near-misses (only if score is still low)
  if (score < MATCH_THRESHOLD) {
    const fuzzyScore = fuzzyMatchScore(politician, headlineLower, bodyLower);
    score += fuzzyScore;
  }

  return { politician, score, matchedName, inHeadline, mentionCount: mentionCount || 1 };
}

function buildFullName(p: PoliticianData): string {
  const parts = [p.title, p.firstName, p.lastName].filter(Boolean);
  return parts.join(' ');
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

function getRoleKeywords(lang: 'de' | 'en' | 'unknown'): string[] {
  if (lang === 'en') {
    return ['member of parliament', 'politician', 'bundestag', 'minister', 'chancellor'];
  }
  return ['mdb', 'abgeordnete', 'bundestag', 'minister', 'bundeskanzler', 'bundesminister', 'fraktion'];
}

// ─── Fuzzy matching ───────────────────────────────────────────────────────────

/**
 * Scores fuzzy near-matches for a politician's name in the text.
 * Uses a sliding window over tokens and checks Levenshtein distance.
 * Returns a bonus score [0..20] if a close-enough match is found.
 */
function fuzzyMatchScore(
  politician: PoliticianData,
  headlineLower: string,
  bodyLower: string
): number {
  const target = politician.lastName.toLowerCase();
  if (target.length < 4) return 0; // skip very short names (too many false positives)

  const MAX_DISTANCE = Math.floor(target.length * 0.2); // 20% edit distance tolerance
  const text = `${headlineLower} ${bodyLower}`;
  const tokens = text.split(/\s+/);

  for (const token of tokens) {
    // Strip punctuation from token
    const clean = token.replace(/[^a-zäöüß]/g, '');
    if (Math.abs(clean.length - target.length) > MAX_DISTANCE) continue;
    const dist = levenshtein(clean, target);
    if (dist > 0 && dist <= MAX_DISTANCE) {
      return 10; // small bonus for near-miss
    }
  }
  return 0;
}

/**
 * Iterative Levenshtein distance with early exit for performance.
 * O(n*m) time but typically fast for short surname strings.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const maxDist = Math.floor(Math.max(a.length, b.length) * 0.3);

  const prev = new Uint16Array(b.length + 1);
  const curr = new Uint16Array(b.length + 1);

  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];

    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,       // insertion
        prev[j] + 1,           // deletion
        prev[j - 1] + cost     // substitution
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }

    // Early exit if entire row exceeds threshold
    if (rowMin > maxDist) return maxDist + 1;

    prev.set(curr);
  }

  return prev[b.length];
}
