const TURKEY_TERMS = ['turkey', 'türkiye'];
const DESTINATION_TERMS = ['antalya', 'istanbul', 'cappadocia', 'pamukkale', 'ephesus', 'bodrum'];

/**
 * Score relevance from combined page text. +2 Turkey/Türkiye, +1 per destination, -2 if unrelated.
 * @param {string} combinedText - All page text concatenated (or per-domain)
 * @param {string[]} unrelatedKeywords - Blocklist (e.g. casino, real estate)
 * @returns {{ relevanceScore: number, matchedTerms: string[] }}
 */
export function scoreRelevance(combinedText, unrelatedKeywords = []) {
  const text = (combinedText || '').toLowerCase();
  let score = 0;
  const matched = [];

  if (TURKEY_TERMS.some((t) => text.includes(t))) {
    score += 2;
    matched.push('Turkey/Türkiye');
  }
  for (const term of DESTINATION_TERMS) {
    if (text.includes(term)) {
      score += 1;
      matched.push(term);
    }
  }
  const block = (unrelatedKeywords || []).map((k) => k.toLowerCase());
  if (block.some((k) => text.includes(k))) {
    score -= 2;
    matched.push('unrelated');
  }

  return { relevanceScore: score, matchedTerms: matched };
}

export default scoreRelevance;
