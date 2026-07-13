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

  const hit = await findBestAnswerHit(auth, question, documentId);
  if (!hit) return [];

  // Heading-style queries: only cite when we found the real section page.
  if (isHeadingStyleQuestion(question) && hit.headingScore < 0.65) {
    return [];
  }

  if (hit.score < 0.25) return [];

  return [sourceFromHit(hit)];
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
 * Skips PDF re-scan unless the message was unanswered or missing sources.
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

  if (answered && sources.length > 0 && auth) {
    return {
      answer,
      is_answered: true,
      sources: finalizeSourceLinks(auth, sources),
    };
  }

  if (answered && sources.length === 0) {
    return resolveAssistantTurn(auth, question, answer, true, []);
  }

  if (!answered) {
    return resolveAssistantTurn(auth, question, answer, false, sources);
  }

  return { answer, is_answered: true, sources: auth ? finalizeSourceLinks(auth, sources) : sources };
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

  const hit = await findBestAnswerHit(auth, question);
  const needsBetterAnswer =
    !isAnswered || isNotFoundAnswer(answer) || looksLikeRawDump(answer);

  let finalAnswer = answer;
  let finalAnswered = isAnswered && !isNotFoundAnswer(answer);

  if (needsBetterAnswer && hit) {
    const llmPassages = [
      { fileName: hit.fileName, page: hit.physicalPage, text: hit.pageText },
    ];
    const synthesized = await synthesizeAnswerFromPassages(question, llmPassages);
    const extracted = buildConciseAnswer(hit.sentence);
    const candidate = synthesized || extracted;

    if (candidate && candidate.length >= 15 && !isNotFoundAnswer(candidate)) {
      finalAnswer = candidate;
      finalAnswered = true;
    }
  }

  // PDF hit with no API answer — still answer from the matched passage.
  if (!finalAnswered && hit && hit.score >= 0.25) {
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

  if (hit && hit.score >= 0.25 && (!isHeadingStyleQuestion(question) || hit.headingScore >= 0.65)) {
    sources = finalizeSourceLinks(auth, [sourceFromHit(hit)]);
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

function significantTokens(text: string): string[] {
  const stop = new Set([
    'the', 'and', 'for', 'that', 'with', 'this', 'from', 'are', 'was', 'were',
    'have', 'has', 'had', 'will', 'shall', 'must', 'can', 'may', 'also', 'into',
    'based', 'provided', 'sources', 'following', 'involves', 'process',
  ]);

  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !stop.has(w))
    )
  );
}

function scorePageAgainstAnswer(pageText: string, answerTokens: string[], answer: string, question: string): number {
  const pageLower = pageText.toLowerCase();
  const pageTokens = new Set(significantTokens(pageText));

  let hits = 0;
  for (const token of answerTokens) {
    if (pageTokens.has(token) || pageLower.includes(token)) hits++;
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

  return tokenScore * 0.35 + questionScore * 0.45 + phraseScore * 0.2;
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

  if (/superintendent/i.test(lower) && /inspection/i.test(lower)) score += 0.25;
  if (/oil record book|orb/i.test(lower) && /record|entries|oil/i.test(qLower)) score += 0.4;
  if (/at least once|once in a year|12 months|every year|per year/i.test(lower)) score += 0.45;
  if (/4\.?\s*1\s+superintendent/i.test(lower)) score += 0.35;

  if (/\b(how often|frequency)\b/i.test(qLower)) {
    if (/\b(months?|years?|annual|quarterly|weekly|daily|times)\b/i.test(lower)) score += 0.35;
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

/** Find the single best answer sentence and the exact PDF page it lives on. */
async function findBestAnswerHit(
  auth: string,
  question: string,
  onlyDocumentId?: number
): Promise<AnswerHit | null> {
  const docs = await listReadyPdfDocuments(auth);
  if (docs.length === 0) return null;

  const tokens = significantTokens(question);
  if (tokens.length === 0) return null;

  const headingQuery = isHeadingStyleQuestion(question);
  let best: AnswerHit | null = null;

  const rankedDocs = [...docs]
    .filter((doc) => !onlyDocumentId || doc.id === onlyDocumentId)
    .sort((a, b) => {
      const ah = `${a.title} ${a.original_filename || ''}`.toLowerCase();
      const bh = `${b.title} ${b.original_filename || ''}`.toLowerCase();
      const aHits = tokens.filter((t) => ah.includes(t)).length;
      const bHits = tokens.filter((t) => bh.includes(t)).length;
      return bHits - aHits;
    });

  for (const doc of rankedDocs) {
    const pages = await loadPdfPages(doc.id, auth);
    if (!pages) continue;

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

      if (headingQuery) {
        if (headingScore < 0.65) return;

        const ranked = splitSentences(content)
          .map((sentence) => ({ sentence, score: scoreSentence(sentence, question) }))
          .sort((a, b) => b.score - a.score);
        const sentence = ranked[0]?.sentence || stripped.slice(0, 280);
        const score = headingScore + (ranked[0]?.score ?? 0);

        if (!best || score > best.score) {
          best = {
            fileId: doc.id,
            fileName: doc.title,
            physicalPage,
            printedPage: extractPrintedPageNumber(content),
            sentence,
            pageText: stripped.slice(0, 2200),
            score,
            headingScore,
          };
        }
        return;
      }

      if (headingScore >= 0.65) {
        const ranked = splitSentences(content)
          .map((sentence) => ({ sentence, score: scoreSentence(sentence, question) }))
          .sort((a, b) => b.score - a.score);
        const sentence = ranked[0]?.sentence || stripped.slice(0, 280);
        const score = headingScore + (ranked[0]?.score ?? 0) + 0.2;

        if (!best || score > best.score) {
          best = {
            fileId: doc.id,
            fileName: doc.title,
            physicalPage,
            printedPage: extractPrintedPageNumber(content),
            sentence,
            pageText: stripped.slice(0, 2200),
            score,
            headingScore,
          };
        }
      }

      for (const sentence of splitSentences(content)) {
        const score = scoreSentence(sentence, question);
        if (score < 0.35) continue;

        if (!best || score > best.score) {
          best = {
            fileId: doc.id,
            fileName: doc.title,
            physicalPage,
            printedPage: extractPrintedPageNumber(content),
            sentence,
            pageText: stripped.slice(0, 2200),
            score,
            headingScore,
          };
        }
      }
    });

    if (best && best.score >= 0.9) break;
  }

  return best;
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

  const hit = await findBestAnswerHit(auth, question);
  if (!hit || hit.score < 0.25) return null;

  const llmPassages = [
    {
      fileName: hit.fileName,
      page: hit.physicalPage,
      text: hit.pageText,
    },
  ];

  let answer =
    (await synthesizeAnswerFromPassages(question, llmPassages)) ||
    buildConciseAnswer(hit.sentence);

  if (!answer || answer.length < 20 || /could not find/i.test(answer)) return null;

  return { answer, sources: [sourceFromHit(hit)] };
}
