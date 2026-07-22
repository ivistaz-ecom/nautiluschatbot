/**
 * Build "Did you mean" / "Are you looking for" suggestions when a query
 * is misspelled or weakly matched to the knowledge base.
 */

type Candidate = { text: string; score: number; kind: 'faq' | 'title' | 'spelling' | 'topic' };

const STOP = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'what', 'how', 'when',
  'where', 'why', 'who', 'which', 'this', 'that', 'and', 'or', 'of', 'in', 'for',
  'to', 'with', 'on', 'at', 'by', 'from', 'do', 'does', 'did', 'please', 'tell',
  'give', 'explain', 'describe', 'about', 'into', 'can', 'could', 'should',
]);

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text: string): string[] {
  return normalize(text)
    .split(' ')
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = cur;
    }
  }
  return row[b.length];
}

function tokenOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let hits = 0;
  for (const t of a) if (setB.has(t)) hits++;
  return hits / Math.max(a.length, b.length);
}

function scoreCandidate(question: string, candidate: string): number {
  const q = normalize(question);
  const c = normalize(candidate);
  if (!c || c === q) return 0;

  const qTokens = tokens(question);
  const cTokens = tokens(candidate);
  const overlap = tokenOverlap(qTokens, cTokens);

  // Whole-string edit distance as a fraction for near-miss spellings.
  const maxLen = Math.max(q.length, c.length) || 1;
  const editFrac = 1 - Math.min(levenshtein(q, c), maxLen) / maxLen;

  // Prefer candidates that share topic words and are not huge.
  const lengthPenalty = c.length > 120 ? 0.7 : 1;
  return (overlap * 0.7 + editFrac * 0.3) * lengthPenalty;
}

/** Suggest a spelling-corrected version of the question using a vocabulary. */
function spellingSuggestion(question: string, vocabulary: string[]): string | null {
  const words = normalize(question).split(' ').filter(Boolean);
  if (!words.length || !vocabulary.length) return null;

  const vocab = Array.from(
    new Set(
      vocabulary
        .flatMap((v) => tokens(v))
        .filter((w) => w.length >= 4)
    )
  );

  let changed = false;
  const fixed = words.map((word) => {
    if (word.length < 4 || STOP.has(word)) return word;
    if (vocab.includes(word)) return word;

    let best = word;
    let bestDist = Infinity;
    for (const v of vocab) {
      if (Math.abs(v.length - word.length) > 2) continue;
      const d = levenshtein(word, v);
      const maxAllowed = word.length >= 8 ? 2 : 1;
      if (d > 0 && d <= maxAllowed && d < bestDist) {
        bestDist = d;
        best = v;
      }
    }
    if (best !== word) changed = true;
    return best;
  });

  if (!changed) return null;
  const suggestion = fixed.join(' ');
  if (normalize(suggestion) === normalize(question)) return null;
  return suggestion;
}

function uniqueTop(candidates: Candidate[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates.sort((a, b) => b.score - a.score)) {
    const key = normalize(c.text);
    if (!key || seen.has(key) || c.score < 0.18) continue;
    seen.add(key);
    out.push(c.text.trim());
    if (out.length >= limit) break;
  }
  return out;
}

export type SuggestionBundle = {
  /** Near-miss spelling of the whole query */
  did_you_mean?: string | null;
  /** Related topics / FAQ-style questions */
  looking_for: string[];
};

/**
 * Build suggestions from FAQs, document titles, and optional topic hints
 * (section headings / strong phrases from retrieval).
 */
export function buildSuggestionBundle(
  question: string,
  options: {
    faqs?: Array<{ canonical_question?: string }>;
    documentTitles?: string[];
    topicHints?: string[];
    limit?: number;
  }
): SuggestionBundle {
  const limit = options.limit ?? 4;
  const qNorm = normalize(question);
  const pool: string[] = [];

  for (const f of options.faqs ?? []) {
    const t = String(f.canonical_question || '').trim();
    if (t) pool.push(t);
  }
  for (const t of options.documentTitles ?? []) {
    const s = String(t || '').trim();
    if (s) pool.push(s);
  }
  for (const t of options.topicHints ?? []) {
    const s = String(t || '').trim();
    if (s && s.length >= 8 && s.length <= 100) pool.push(s);
  }

  const didYouMean = spellingSuggestion(question, pool);

  const candidates: Candidate[] = [];
  for (const text of pool) {
    if (normalize(text) === qNorm) continue;
    // Skip doc titles that are just filenames unless they look like topics
    const score = scoreCandidate(question, text);
    if (score <= 0) continue;
    const kind: Candidate['kind'] = options.faqs?.some(
      (f) => normalize(String(f.canonical_question || '')) === normalize(text)
    )
      ? 'faq'
      : options.topicHints?.some((h) => normalize(h) === normalize(text))
        ? 'topic'
        : 'title';
    candidates.push({ text, score, kind });
  }

  // Prefer FAQ/topic wording over raw document filenames.
  for (const c of candidates) {
    if (c.kind === 'faq') c.score *= 1.25;
    if (c.kind === 'topic') c.score *= 1.15;
    if (c.kind === 'title' && /\.pdf$/i.test(c.text)) c.score *= 0.5;
  }

  let lookingFor = uniqueTop(candidates, limit);
  if (didYouMean) {
    lookingFor = lookingFor.filter((s) => normalize(s) !== normalize(didYouMean));
  }

  return {
    did_you_mean: didYouMean,
    looking_for: lookingFor,
  };
}

export async function fetchSuggestionInputs(
  auth: string,
  apiBase: string,
  categoryIds?: number[]
): Promise<{ faqs: Array<{ canonical_question?: string }>; documentTitles: string[] }> {
  const headers: HeadersInit = auth ? { Authorization: auth } : {};
  const faqs: Array<{ canonical_question?: string }> = [];
  const documentTitles: string[] = [];

  try {
    const faqUrl = new URL(`${apiBase.replace(/\/$/, '')}/chat/faqs`);
    faqUrl.searchParams.set('limit', '40');
    if (categoryIds?.length === 1) {
      faqUrl.searchParams.set('category_id', String(categoryIds[0]));
    }
    const res = await fetch(faqUrl.toString(), { headers, cache: 'no-store' });
    if (res.ok) {
      const json = await res.json();
      if (Array.isArray(json?.data)) {
        for (const row of json.data) faqs.push(row);
      }
    }
  } catch {
    // ignore
  }

  try {
    const params = new URLSearchParams({ status: 'ready' });
    if (categoryIds?.length === 1) {
      params.set('category_id', String(categoryIds[0]));
    } else if (categoryIds && categoryIds.length > 1) {
      params.set('category_ids', categoryIds.join(','));
    }
    const res = await fetch(`${apiBase.replace(/\/$/, '')}/chat/documents?${params}`, {
      headers,
      cache: 'no-store',
    });
    if (res.ok) {
      const json = await res.json();
      if (Array.isArray(json?.data)) {
        for (const doc of json.data) {
          const title = String(doc.title || doc.original_filename || '').trim();
          if (title) documentTitles.push(title.replace(/\.pdf$/i, ''));
        }
      }
    }
  } catch {
    // ignore
  }

  // Admin fallback for titles when chat/documents is unavailable.
  if (documentTitles.length === 0) {
    try {
      const res = await fetch(
        `${apiBase.replace(/\/$/, '')}/admin/documents?status=ready&per_page=100`,
        { headers, cache: 'no-store' }
      );
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json?.data)) {
          for (const doc of json.data) {
            const title = String(doc.title || doc.original_filename || '').trim();
            if (title) documentTitles.push(title.replace(/\.pdf$/i, ''));
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return { faqs, documentTitles };
}
