import { API_BACKEND_URL, DOCUMENT_API_URL } from './api-config';
import { cachePdfPages, extractPdfPages, getCachedPdfPages } from './pdf-pages';
import { synthesizeAnswerFromPassages } from './pdf-llm-answer';

export type SourceLike = Record<string, unknown>;

/** Per-request cache so one session load does not re-download the same PDF. */
const pdfPagesCache = new Map<number, string[]>();

function isHeadingStyleQuestion(question: string): boolean {
  const q = question.trim();
  return q.length > 0 && q.length < 100 && !q.endsWith('?');
}

function sourceFromHit(hit: AnswerHit): SourceLike {
  const pageLabel = buildPageLabel(hit.physicalPage);
  const excerpt = hit.sentence.trim().slice(0, 280);
  return {
    document_id: hit.fileId,
    document_title: hit.fileName,
    page_number: hit.physicalPage,
    pageNumber: hit.physicalPage,
    page_label: pageLabel,
    pageLabel,
    printed_page: hit.printedPage,
    physical_page: hit.physicalPage,
    fileId: hit.fileId,
    fileName: hit.fileName,
    mime_type: 'application/pdf',
    relevance_rank: 1,
    excerpt,
    snippet: excerpt,
  };
}

export function getFileId(source: SourceLike): number {
  return Number(source.fileId ?? source.document_id ?? 0);
}

export function getPage(source: SourceLike): number | null {
  const raw = source.pageNumber ?? source.page_number;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** One card per document — keep the best page when duplicates exist. */
export function dedupeSources(sources: SourceLike[]): SourceLike[] {
  const byFile = new Map<number, SourceLike>();

  for (const src of sources) {
    const fileId = getFileId(src);
    if (fileId <= 0) continue;

    const existing = byFile.get(fileId);
    if (!existing) {
      byFile.set(fileId, src);
      continue;
    }

    const existingPage = getPage(existing) ?? 0;
    const nextPage = getPage(src) ?? 0;
    if (existingPage <= 1 && nextPage > 1) {
      byFile.set(fileId, src);
    }
  }

  return Array.from(byFile.values());
}

function isNotFoundAnswer(answer: string): boolean {
  return /could not find|not found in the (available )?documents|not found in the knowledge base/i.test(answer);
}

/** Build PDF deep links from existing page numbers — never re-scan the PDF. */
export function finalizeSourceLinks(auth: string, sources: SourceLike[]): SourceLike[] {
  const token = auth.replace(/^Bearer\s+/i, '');

  return sources.map((source) => {
    const fileId = getFileId(source);
    const pageNumber = getPage(source);
    const fileName = String(source.fileName ?? source.document_title ?? 'Document');
    const mime = String(source.mime_type || 'application/pdf');
    const pageLabel =
      (source.pageLabel ?? source.page_label) || (pageNumber ? buildPageLabel(pageNumber) : null);

    let pdfUrl = `${DOCUMENT_API_URL}/chat/documents/${fileId}/file?token=${encodeURIComponent(token)}`;
    if (pageNumber) {
      pdfUrl = `${pdfUrl}#page=${pageNumber}`;
    }

    return {
      ...source,
      document_id: fileId,
      document_title: fileName,
      fileId,
      fileName,
      page_number: pageNumber,
      pageNumber,
      page_label: pageLabel,
      pageLabel,
      mime_type: mime,
      pdfUrl,
      pdf_url: pdfUrl,
    };
  });
}

function looksLikeRawDump(answer: string): boolean {
  return /document number|electronic copy|uncontrolled if printed/i.test(answer);
}

type PageLocation = {
  physicalPage: number;
  printedPage: number | null;
  score: number;
};

/** Detect when the question matches a section heading on this PDF page. */
function scoreSectionHeadingMatch(pageText: string, question: string): number {
  const q = question.trim();
  if (q.length < 5) return 0;

  const qUpper = q.toUpperCase();
  const content = stripBoilerplate(pageText);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 160) continue;

    const upper = trimmed.toUpperCase();
    if (!upper.includes(qUpper)) continue;

    // Skip index/TOC lines like "OIL RECORD BOOK .... 14"
    if (/[\s\.]{2,}\d{1,4}\s*$/.test(trimmed)) continue;

    // "4.2.22 OIL RECORD BOOK ENTRIES (ORB - Part 1)"
    if (/\d+\.\d+(\.\d+)?\s+/.test(trimmed)) return 0.9;
    if (upper === qUpper) return 0.85;
    if (trimmed.length < 90) return 0.7;
  }

  return 0;
}

function looksLikeTocPage(content: string): boolean {
  const lower = content.toLowerCase();
  if (lower.includes('table of contents')) return true;

  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 4) return false;

  let tocLines = 0;
  for (const line of lines) {
    if (/\.{3,}\s*\d+\s*$/.test(line) || /\s{3,}\d{1,4}\s*$/.test(line)) {
      tocLines++;
    }
  }
  return tocLines / lines.length >= 0.35;
}

function isIndexEntryForQuestion(pageText: string, question: string): boolean {
  const qUpper = question.trim().toUpperCase();
  if (qUpper.length < 5) return false;

  for (const line of pageText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.toUpperCase().includes(qUpper)) continue;
    if (/[\s\.]{2,}\d{1,4}\s*$/.test(trimmed) && trimmed.length < 120) return true;
  }
  return false;
}

/**
 * Authoritative page lookup via indexed document_chunks (pdftotext page numbers).
 * Requires GET /chat/locate-source on the live API.
 */
async function locateSourcesFromChunks(
  auth: string,
  question: string,
  answer: string,
  documentId?: number
): Promise<SourceLike[] | null> {
  if (!auth || !question.trim()) return null;

  const params = new URLSearchParams({ q: question });
  if (answer.trim()) params.set('answer', answer.slice(0, 800));
  if (documentId && documentId > 0) params.set('document_id', String(documentId));

  try {
    const res = await fetch(`${API_BACKEND_URL}/chat/locate-source?${params}`, {
      headers: { Authorization: auth },
      cache: 'no-store',
    });
    if (res.status === 404 || res.status === 405) return null;
    if (!res.ok) return null;

    const json = await res.json();
    const sources = json?.data?.sources;
    return Array.isArray(sources) && sources.length > 0 ? sources : null;
  } catch {
    return null;
  }
}

/** Score how well a PDF page explains the answer / question. */
function scorePageForAttribution(pageText: string, answer: string, question: string): number {
  const content = stripBoilerplate(pageText);
  if (content.length < 30) return 0;
  if (looksLikeTocPage(content)) return 0;
  if (isIndexEntryForQuestion(pageText, question)) return 0;

  let score = scorePageAgainstAnswer(content, significantTokens(answer), answer, question);
  score += scoreSectionHeadingMatch(pageText, question);

  return Math.min(score, 1.5);
}

/** Find the physical PDF page where the answer content actually lives. */
async function locateAnswerPageInDocument(
  auth: string,
  fileId: number,
  answer: string,
  question: string
): Promise<PageLocation | null> {
  const pages = await loadPdfPages(fileId, auth);
  if (!pages?.length) return null;

  let best: PageLocation | null = null;

  pages.forEach((pageText, index) => {
    const physicalPage = index + 1;
    const score = scorePageForAttribution(pageText, answer, question);
    if (score < 0.18) return;

    if (!best || score > best.score) {
      best = {
        physicalPage,
        printedPage: extractPrintedPageNumber(pageText),
        score,
      };
    }
  });

  return best;
}

function buildPageLabel(physicalPage: number): string {
  return `Page ${physicalPage}`;
}

/** Re-scan cited PDFs and fix page numbers using answer + question overlap. */
async function verifyAndCorrectSourcePages(
  auth: string,
  answer: string,
  question: string,
  sources: SourceLike[]
): Promise<SourceLike[]> {
  if (!auth || !answer.trim() || sources.length === 0) return sources;

  const corrected: SourceLike[] = [];

  for (const source of sources) {
    const fileId = getFileId(source);
    if (fileId <= 0) {
      corrected.push(source);
      continue;
    }

    const located = await locateAnswerPageInDocument(auth, fileId, answer, question);
    if (!located || located.score < 0.2) {
      // Drop weak citations when the API attached extra documents with no real overlap.
      if (sources.length > 1) continue;
      corrected.push(source);
      continue;
    }

    const claimedPage = getPage(source);
    const shouldReplace =
      claimedPage == null ||
      located.score >= 0.35 ||
      claimedPage <= 10 ||
      Math.abs(claimedPage - located.physicalPage) > 2;

    if (!shouldReplace) {
      corrected.push({
        ...source,
        page_label: buildPageLabel(claimedPage),
        pageLabel: buildPageLabel(claimedPage),
        physical_page: claimedPage,
      });
      continue;
    }

    corrected.push({
      ...source,
      page_number: located.physicalPage,
      pageNumber: located.physicalPage,
      page_label: buildPageLabel(located.physicalPage),
      pageLabel: buildPageLabel(located.physicalPage),
      physical_page: located.physicalPage,
    });
  }

  return corrected;
}

/**
 * Ground source pages in document content (PDF scan).
 * Never trust page numbers returned by the upstream ask API alone.
 */
export async function locateSourcesForQuestion(
  auth: string,
  question: string,
  answer: string,
  documentId?: number
): Promise<SourceLike[]> {
  if (!auth || !question.trim()) return [];

  const hits = await findTopAnswerHits(auth, question, documentId);
  if (hits.length === 0) return [];

  // Heading-style queries: only cite when we found the real section page.
  if (isHeadingStyleQuestion(question)) {
    const headingHits = hits.filter((h) => h.headingScore >= 0.65);
    if (headingHits.length === 0) return [];
    return headingHits.map((h, index) => ({
      ...sourceFromHit(h),
      relevance_rank: index + 1,
    }));
  }

  return hits
    .filter((h) => h.score >= MIN_HIT_SCORE)
    .map((h, index) => ({
      ...sourceFromHit(h),
      relevance_rank: index + 1,
    }));
}

async function finalizeVerifiedSources(
  auth: string,
  question: string,
  answer: string,
  sources: SourceLike[]
): Promise<SourceLike[]> {
  const located = await locateSourcesForQuestion(auth, question, answer);
  if (located.length > 0) {
    return finalizeSourceLinks(auth, located);
  }

  if (sources.length > 0) {
    const verified = await verifyAndCorrectSourcePages(auth, answer, question, sources);
    if (verified.length > 0) {
      return finalizeSourceLinks(auth, verified);
    }
  }

  return [];
}

/**
 * Fast path for reloading saved chats — uses DB + cached sources only.
 * Never re-scans PDFs when opening history (that made old chats take 20s+).
 */
export async function resolveSessionMessage(
  auth: string,
  question: string,
  answer: string,
  isAnswered: boolean,
  rawSources: SourceLike[] | null | undefined
): Promise<{ answer: string; is_answered: boolean; sources: SourceLike[] }> {
  const answered = isAnswered && Boolean(answer) && !isNotFoundAnswer(answer);
  const sources = Array.isArray(rawSources) ? dedupeSources(rawSources) : [];

  if (!answered) {
    return {
      answer,
      is_answered: false,
      sources: auth && sources.length ? finalizeSourceLinks(auth, sources) : [],
    };
  }

  return {
    answer,
    is_answered: true,
    sources: auth && sources.length ? finalizeSourceLinks(auth, sources) : [],
  };
}

/**
 * Resolve one assistant turn: recover missed answers from documents,
 * always ground source pages in PDF content, then attach deep links.
 */
export async function resolveAssistantTurn(
  auth: string,
  question: string,
  answer: string,
  isAnswered: boolean,
  rawSources: SourceLike[] | null | undefined
): Promise<{ answer: string; is_answered: boolean; sources: SourceLike[] }> {
  if (!auth || !question.trim()) {
    return { answer, is_answered: isAnswered, sources: [] };
  }

  const hits = await findTopAnswerHits(auth, question);
  const hit = hits[0] ?? null;
  const needsBetterAnswer =
    !isAnswered || isNotFoundAnswer(answer) || looksLikeRawDump(answer);

  // Even when the API returns an answer, prefer a strong PDF topic match
  // (e.g. "superintendent inspections") over a weak keyword hit
  // (e.g. "annual inspection").
  const strongPdfHit =
    Boolean(hit) &&
    (phraseMatchScore(hit!.sentence + ' ' + hit!.pageText, question) >= 0.65 ||
      hit!.score >= 0.85);

  const apiTopicWeak =
    Boolean(answer) &&
    !isNotFoundAnswer(answer) &&
    phraseMatchScore(answer, question) < 0.5 &&
    topicCoverage(answer, question) < 0.6;

  let finalAnswer = answer;
  let finalAnswered = isAnswered && !isNotFoundAnswer(answer);

  if ((needsBetterAnswer || (strongPdfHit && apiTopicWeak)) && hits.length > 0) {
    const llmPassages = hits.slice(0, 3).map((h) => ({
      fileName: h.fileName,
      page: h.physicalPage,
      text: h.pageText,
    }));
    const synthesized = await synthesizeAnswerFromPassages(question, llmPassages);
    const extracted = buildConciseAnswer(hit!.sentence);
    const candidate = synthesized || extracted;

    if (candidate && candidate.length >= 15 && !isNotFoundAnswer(candidate)) {
      finalAnswer = candidate;
      finalAnswered = true;
    }
  }

  // PDF hit with no API answer — still answer from the matched passage.
  if (!finalAnswered && hit && hit.score >= MIN_HIT_SCORE) {
    const extracted = buildConciseAnswer(hit.sentence);
    if (extracted && extracted.length >= 15) {
      finalAnswer = extracted;
      finalAnswered = true;
    }
  }

  if (!finalAnswered) {
    return { answer: finalAnswer || answer, is_answered: false, sources: [] };
  }

  let sources: SourceLike[] = [];

  if (hits.length > 0) {
    const grounded = hits.filter(
      (h) =>
        h.score >= MIN_HIT_SCORE &&
        (!isHeadingStyleQuestion(question) || h.headingScore >= 0.65)
    );
    if (grounded.length > 0) {
      sources = finalizeSourceLinks(
        auth,
        grounded.map((h, index) => ({
          ...sourceFromHit(h),
          relevance_rank: index + 1,
        }))
      );
    }
  }

  if (!sources.length) {
    const chunkSources = await locateSourcesFromChunks(auth, question, finalAnswer);
    if (chunkSources?.length) {
      sources = finalizeSourceLinks(auth, dedupeSources(chunkSources));
    }
  }

  if (!sources.length) {
    const fallback = Array.isArray(rawSources) ? dedupeSources(rawSources) : [];
    sources = await finalizeVerifiedSources(auth, question, finalAnswer, fallback);
  }

  if (!sources.length && Array.isArray(rawSources) && rawSources.length > 0) {
    sources = finalizeSourceLinks(auth, dedupeSources(rawSources));
  }

  return {
    answer: finalAnswer,
    is_answered: true,
    sources,
  };
}

/** @deprecated Use resolveAssistantTurn — kept for imports that only need link finalization. */
export async function enrichAnswerSources(
  auth: string,
  question: string,
  answer: string,
  rawSources: SourceLike[] | null | undefined
): Promise<SourceLike[]> {
  const resolved = await resolveAssistantTurn(auth, question, answer, true, rawSources);
  return resolved.sources;
}

async function loadPdfPages(fileId: number, auth: string): Promise<string[] | null> {
  const cached = getCachedPdfPages(fileId) ?? pdfPagesCache.get(fileId);
  if (cached) return cached;

  const res = await fetch(`${API_BACKEND_URL}/chat/documents/${fileId}/file`, {
    headers: { Authorization: auth },
    cache: 'no-store',
  });
  if (!res.ok) return null;

  const buffer = new Uint8Array(await res.arrayBuffer());
  if (buffer.byteLength < 100) return null;

  try {
    const pages = await extractPdfPages(buffer);
    cachePdfPages(fileId, pages);
    pdfPagesCache.set(fileId, pages);
    return pages;
  } catch (err) {
    console.warn('[chat-source-attribution] PDF extract failed for doc', fileId, err);
    return null;
  }
}

/** Question filler words that should not drive retrieval alone. */
const QUESTION_STOP = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'are', 'was', 'were',
  'have', 'has', 'had', 'will', 'shall', 'must', 'can', 'may', 'also', 'into',
  'based', 'provided', 'sources', 'following', 'involves', 'process',
  'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'why', 'how',
  'does', 'do', 'did', 'is', 'it', 'its', 'them', 'they', 'their', 'there',
  'about', 'happen', 'happens', 'happening', 'occur', 'occurs', 'much', 'many',
  'often', 'please', 'tell', 'give', 'need', 'know', 'find', 'show', 'explain',
]);

/** Normalize plurals / light stemming so inspection ≈ inspections. */
function normalizeToken(token: string): string {
  const t = token.toLowerCase();
  if (t.length <= 4) return t;
  if (t.endsWith('ies') && t.length > 5) return `${t.slice(0, -3)}y`;
  if (t.endsWith('sses')) return t.slice(0, -2);
  if (t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us') && !t.endsWith('is')) {
    return t.slice(0, -1);
  }
  return t;
}

function significantTokens(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !QUESTION_STOP.has(w))
        .map(normalizeToken)
    )
  );
}

/** Core topic tokens excluding pure frequency/time words. */
function topicTokens(question: string): string[] {
  const frequencyish = new Set([
    'often', 'frequency', 'interval', 'period', 'annual', 'yearly', 'monthly',
    'weekly', 'daily', 'quarterly', 'times', 'year', 'years', 'month', 'months',
  ]);
  return significantTokens(question).filter((t) => !frequencyish.has(t));
}

/**
 * Multi-word topic phrases from the question
 * e.g. "superintendent inspections" from
 * "How often do superintendent inspections happen?"
 */
function extractTopicPhrases(question: string): string[] {
  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !QUESTION_STOP.has(w) && !/^\d+$/.test(w));

  const phrases: string[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    phrases.push(`${words[i]} ${words[i + 1]}`);
  }
  for (let i = 0; i < words.length - 2; i++) {
    phrases.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  return Array.from(new Set(phrases));
}

function textHasNormalizedToken(haystack: string, token: string): boolean {
  const lower = haystack.toLowerCase();
  if (lower.includes(token)) return true;
  const hayTokens = new Set(significantTokens(haystack));
  return hayTokens.has(normalizeToken(token));
}

function phraseMatchScore(text: string, question: string): number {
  const lower = text.toLowerCase();
  const phrases = extractTopicPhrases(question);
  if (phrases.length === 0) return 0;

  let best = 0;
  for (const phrase of phrases) {
    if (lower.includes(phrase)) {
      best = Math.max(best, phrase.split(' ').length >= 3 ? 1 : 0.85);
      continue;
    }
    // Plural/stem tolerant: "superintendent inspection" ≈ "superintendent inspections"
    const parts = phrase.split(' ').map(normalizeToken);
    if (parts.every((p) => textHasNormalizedToken(lower, p))) {
      // consecutive-ish presence of both topic words
      const idxs = parts.map((p) => {
        const re = new RegExp(`\\b${p}s?\\b`, 'i');
        const m = lower.match(re);
        return m?.index ?? -1;
      });
      if (idxs.every((i) => i >= 0)) {
        const span = Math.max(...idxs) - Math.min(...idxs);
        if (span <= 40) best = Math.max(best, 0.7);
      }
    }
  }
  return best;
}

function topicCoverage(text: string, question: string): number {
  const topics = topicTokens(question);
  if (topics.length === 0) return 1;
  let hits = 0;
  for (const token of topics) {
    if (textHasNormalizedToken(text, token)) hits++;
  }
  return hits / topics.length;
}

function scorePageAgainstAnswer(pageText: string, answerTokens: string[], answer: string, question: string): number {
  const pageLower = pageText.toLowerCase();
  const pageTokens = new Set(significantTokens(pageText));

  let hits = 0;
  for (const token of answerTokens) {
    if (pageTokens.has(normalizeToken(token)) || pageLower.includes(token)) hits++;
  }
  const tokenScore = answerTokens.length > 0 ? hits / answerTokens.length : 0;

  const questionTokens = significantTokens(question);
  let questionHits = 0;
  for (const token of questionTokens) {
    if (pageTokens.has(token) || pageLower.includes(token)) questionHits++;
  }
  const questionScore = questionTokens.length > 0 ? questionHits / questionTokens.length : 0;

  const words = answer.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 4);
  let phraseHits = 0;
  let phraseTotal = 0;
  for (let i = 0; i < words.length - 3; i++) {
    const phrase = words.slice(i, i + 4).join(' ');
    phraseTotal++;
    if (pageLower.includes(phrase)) phraseHits++;
  }
  const phraseScore = phraseTotal > 0 ? phraseHits / phraseTotal : 0;
  const topicPhrase = phraseMatchScore(pageText, question);
  const coverage = topicCoverage(pageText, question);

  // Topic phrase + coverage dominate so "superintendent inspections" beats
  // unrelated "annual inspection" pages that only share the word inspection.
  return (
    tokenScore * 0.15 +
    questionScore * 0.2 +
    phraseScore * 0.1 +
    topicPhrase * 0.35 +
    coverage * 0.2
  );
}

type ReadyPdfDoc = {
  id: number;
  title: string;
  original_filename?: string;
};

async function listReadyPdfDocuments(auth: string): Promise<ReadyPdfDoc[]> {
  try {
    const res = await fetch(`${API_BACKEND_URL}/admin/documents?per_page=50&status=ready`, {
      headers: { Authorization: auth },
      cache: 'no-store',
    });
    if (!res.ok) return [];

    const json = await res.json();
    const docs: Array<Record<string, unknown>> = Array.isArray(json?.data) ? json.data : [];

    return docs
      .map((doc) => ({
        id: Number(doc.id),
        title: String(doc.title || doc.original_filename || 'Document'),
        original_filename: doc.original_filename ? String(doc.original_filename) : undefined,
        mime: String(doc.mime_type || ''),
        name: String(doc.original_filename || '').toLowerCase(),
      }))
      .filter(
        (doc) =>
          doc.id > 0 &&
          (doc.mime === 'application/pdf' || doc.name.endsWith('.pdf'))
      )
      .map(({ id, title, original_filename }) => ({ id, title, original_filename }));
  } catch {
    return [];
  }
}

function isBoilerplateLine(line: string): boolean {
  const l = line.toLowerCase().trim();
  if (!l) return true;
  return (
    l.includes('nautilus shipping') ||
    l.includes('document number') ||
    l.includes('electronic copy') ||
    l.includes('uncontrolled if printed') ||
    l.includes('section revision') ||
    l.includes('revision number') ||
    /^page\s+number\s*:/i.test(l) ||
    /^section\s+\d+/i.test(l) ||
    /^>{1,2}\s/.test(line.trim())
  );
}

function stripBoilerplate(pageText: string): string {
  return String(pageText)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !isBoilerplateLine(l))
    .join('\n');
}

/** Printed page label inside the PDF body (e.g. "Page 63 of 93"). */
function extractPrintedPageNumber(pageText: string): number | null {
  const patterns = [
    /Page\s+Number\s*:\s*Page\s*(\d+)\s+of\s+\d+/i,
    /Page\s+Number\s*:\s*(\d+)/i,
    /Page\s+(\d+)\s+of\s+\d+/i,
  ];
  for (const pattern of patterns) {
    const match = pageText.match(pattern);
    if (match) {
      const n = parseInt(match[1], 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

function scoreSentence(sentence: string, question: string): number {
  const cleaned = sentence.replace(/^[\d•\-\s]+/, '').trim();
  if (cleaned.length < 35 || isBoilerplateLine(cleaned)) return 0;
  if (/^[A-Z0-9\s\-–—.]{0,40}$/.test(cleaned)) return 0;
  if ((cleaned.match(/•/g) || []).length >= 2) return 0;

  const tokens = significantTokens(question);
  let score = scorePageAgainstAnswer(cleaned, tokens, '', question);

  const lower = cleaned.toLowerCase();
  const qLower = question.toLowerCase();
  const phraseBoost = phraseMatchScore(cleaned, question);
  const coverage = topicCoverage(cleaned, question);

  // Strong boost for exact topic phrase match — this is the key signal.
  score += phraseBoost * 0.55;

  // Frequency / schedule cues only count when the topic is also present.
  // Otherwise "ANNUAL INSPECTION" wins for "superintendent inspections" questions.
  const topicPresent = coverage >= 0.5 || phraseBoost >= 0.65;
  if (topicPresent) {
    if (/at least once|once in a year|12 months|every year|per year|once a year/i.test(lower)) {
      score += 0.35;
    }
    if (/\b(how often|frequency)\b/i.test(qLower)) {
      if (/\b(months?|years?|annual|quarterly|weekly|daily|times)\b/i.test(lower)) {
        score += 0.25;
      }
    }
  } else if (tokens.length >= 2 && coverage < 0.4) {
    // Hard penalty for answers that miss most of the topic words.
    score *= 0.25;
  }

  return score;
}

/** Turn the best matching sentence into a short chat reply. */
function buildConciseAnswer(sentence: string): string {
  let text = sentence
    .replace(/^[\d•\-\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Keep only the first sentence if multiple were joined
  const firstEnd = text.search(/[.!?](?:\s|$)/);
  if (firstEnd > 80) {
    text = text.slice(0, firstEnd + 1);
  }

  if (text.length > 280) {
    const cut = text.slice(0, 277);
    const lastSpace = cut.lastIndexOf(' ');
    text = `${(lastSpace > 120 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
  }

  if (text && !/[.!?]$/.test(text)) text += '.';
  return text;
}

function splitSentences(text: string): string[] {
  return stripBoilerplate(text)
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 25);
}

type AnswerHit = {
  fileId: number;
  fileName: string;
  physicalPage: number;
  printedPage: number | null;
  sentence: string;
  pageText: string;
  score: number;
  headingScore: number;
};

const MAX_ANSWER_HITS = 5;
const MIN_HIT_SCORE = 0.35;

function considerHit(hits: AnswerHit[], candidate: AnswerHit): void {
  if (candidate.score < MIN_HIT_SCORE) return;

  // Prefer the best page within the same document.
  const existingIdx = hits.findIndex((h) => h.fileId === candidate.fileId);
  if (existingIdx >= 0) {
    if (candidate.score > hits[existingIdx].score) {
      hits[existingIdx] = candidate;
    }
    return;
  }

  hits.push(candidate);
  hits.sort((a, b) => b.score - a.score);
  if (hits.length > MAX_ANSWER_HITS) hits.length = MAX_ANSWER_HITS;
}

/**
 * Find the best matching passages across PDFs.
 * Returns multiple documents when several manuals answer the question.
 */
async function findTopAnswerHits(
  auth: string,
  question: string,
  onlyDocumentId?: number
): Promise<AnswerHit[]> {
  const docs = await listReadyPdfDocuments(auth);
  if (docs.length === 0) return [];

  const tokens = significantTokens(question);
  if (tokens.length === 0) return [];

  const headingQuery = isHeadingStyleQuestion(question);
  const hits: AnswerHit[] = [];
  const phrases = extractTopicPhrases(question);

  const rankedDocs = [...docs]
    .filter((doc) => !onlyDocumentId || doc.id === onlyDocumentId)
    .sort((a, b) => {
      const ah = `${a.title} ${a.original_filename || ''}`.toLowerCase();
      const bh = `${b.title} ${b.original_filename || ''}`.toLowerCase();
      const aPhrase = phrases.filter((p) => ah.includes(p)).length;
      const bPhrase = phrases.filter((p) => bh.includes(p)).length;
      if (bPhrase !== aPhrase) return bPhrase - aPhrase;
      const aHits = tokens.filter((t) => ah.includes(t) || ah.includes(normalizeToken(t))).length;
      const bHits = tokens.filter((t) => bh.includes(t) || bh.includes(normalizeToken(t))).length;
      return bHits - aHits;
    });

  for (const doc of rankedDocs) {
    const pages = await loadPdfPages(doc.id, auth);
    if (!pages) continue;

    let bestInDoc: AnswerHit | null = null;

    pages.forEach((pageText, index) => {
      const physicalPage = index + 1;
      const content = String(pageText || '');
      if (looksLikeTocPage(content)) return;
      if (isIndexEntryForQuestion(content, question) && scoreSectionHeadingMatch(content, question) < 0.65) {
        return;
      }

      const stripped = stripBoilerplate(content);
      if (stripped.length < 40) return;

      const headingScore = scoreSectionHeadingMatch(content, question);
      const pagePhrase = phraseMatchScore(content, question);
      const pageCoverage = topicCoverage(content, question);

      const makeHit = (sentence: string, score: number): AnswerHit => ({
        fileId: doc.id,
        fileName: doc.title,
        physicalPage,
        printedPage: extractPrintedPageNumber(content),
        sentence,
        pageText: stripped.slice(0, 2200),
        score,
        headingScore,
      });

      if (headingQuery) {
        if (headingScore < 0.65) return;
        const ranked = splitSentences(content)
          .map((sentence) => ({ sentence, score: scoreSentence(sentence, question) }))
          .sort((a, b) => b.score - a.score);
        const sentence = ranked[0]?.sentence || stripped.slice(0, 280);
        const score = headingScore + (ranked[0]?.score ?? 0) + pagePhrase * 0.2;
        const hit = makeHit(sentence, score);
        if (!bestInDoc || hit.score > bestInDoc.score) bestInDoc = hit;
        return;
      }

      if (headingScore >= 0.65) {
        const ranked = splitSentences(content)
          .map((sentence) => ({ sentence, score: scoreSentence(sentence, question) }))
          .sort((a, b) => b.score - a.score);
        const sentence = ranked[0]?.sentence || stripped.slice(0, 280);
        const score = headingScore + (ranked[0]?.score ?? 0) + 0.2 + pagePhrase * 0.25;
        const hit = makeHit(sentence, score);
        if (!bestInDoc || hit.score > bestInDoc.score) bestInDoc = hit;
      }

      for (const sentence of splitSentences(content)) {
        let score = scoreSentence(sentence, question);
        // Page-level topic context helps when the sentence is short but on-topic.
        if (pagePhrase >= 0.65) score += 0.15;
        if (pageCoverage >= 0.5) score += 0.08;
        if (score < MIN_HIT_SCORE) continue;

        const hit = makeHit(sentence, score);
        if (!bestInDoc || hit.score > bestInDoc.score) bestInDoc = hit;
      }
    });

    if (bestInDoc) considerHit(hits, bestInDoc);
  }

  // Keep only hits that stay competitive with the best match.
  if (hits.length === 0) return [];
  const topScore = hits[0].score;
  const relativeFloor = Math.max(MIN_HIT_SCORE, topScore * 0.55);
  return hits.filter((h) => h.score >= relativeFloor);
}

/** Find the single best answer sentence and the exact PDF page it lives on. */
async function findBestAnswerHit(
  auth: string,
  question: string,
  onlyDocumentId?: number
): Promise<AnswerHit | null> {
  const hits = await findTopAnswerHits(auth, question, onlyDocumentId);
  return hits[0] ?? null;
}

function extractAnswerSentences(pageText: string, question: string): string {
  const ranked = splitSentences(pageText)
    .map((sentence) => ({ sentence, score: scoreSentence(sentence, question) }))
    .sort((a, b) => b.score - a.score);

  const top = ranked[0]?.sentence;
  if (!top) return '';
  return buildConciseAnswer(top);
}

/**
 * When the live API returns "not found", locate the best PDF passage(s),
 * synthesize an answer with the LLM (or extractive fallback), and cite the source page.
 */
export async function recoverAnswerFromDocuments(
  auth: string,
  question: string
): Promise<{ answer: string; sources: SourceLike[] } | null> {
  if (!auth || !question.trim()) return null;

  const hits = await findTopAnswerHits(auth, question);
  const hit = hits[0];
  if (!hit || hit.score < MIN_HIT_SCORE) return null;

  const llmPassages = hits.slice(0, 3).map((h) => ({
    fileName: h.fileName,
    page: h.physicalPage,
    text: h.pageText,
  }));

  let answer =
    (await synthesizeAnswerFromPassages(question, llmPassages)) ||
    buildConciseAnswer(hit.sentence);

  if (!answer || answer.length < 20 || /could not find/i.test(answer)) return null;

  return {
    answer,
    sources: hits.map((h, index) => ({
      ...sourceFromHit(h),
      relevance_rank: index + 1,
    })),
  };
}
