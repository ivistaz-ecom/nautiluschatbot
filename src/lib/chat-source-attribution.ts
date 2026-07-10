import { extractText, getDocumentProxy } from 'unpdf';
import { API_BACKEND_URL } from './api-config';

export type SourceLike = Record<string, unknown>;

/** Per-request cache so one session load does not re-download the same PDF. */
const pdfPagesCache = new Map<number, string[]>();
const pageDetectionCache = new Map<string, number | null>();

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

export async function attachFallbackSources(
  auth: string,
  question: string,
  answer: string
): Promise<SourceLike[]> {
  if (!auth) return [];

  try {
    const res = await fetch(`${API_BACKEND_URL}/admin/documents?per_page=50&status=ready`, {
      headers: { Authorization: auth },
    });
    if (!res.ok) return [];

    const json = await res.json();
    const docs: Array<Record<string, unknown>> = Array.isArray(json?.data) ? json.data : [];
    if (docs.length === 0) return [];

    const q = `${question} ${answer}`.toLowerCase();
    const scored = docs
      .map((doc) => {
        const hay = `${doc.title || ''} ${doc.original_filename || ''} ${doc.category_name || ''}`.toLowerCase();
        let score = 0;
        for (const word of q.split(/[^a-z0-9]+/).filter((w) => w.length >= 4)) {
          if (hay.includes(word)) score += 1;
        }
        if (String(doc.mime_type || '') === 'application/pdf') score += 0.25;
        const uploaded = Date.parse(String(doc.created_at || '')) || 0;
        return { doc, score, uploaded };
      })
      .sort((a, b) => b.score - a.score || b.uploaded - a.uploaded);

    const best = scored[0]?.doc;
    if (!best) return [];

    const fileId = Number(best.id);
    if (!Number.isFinite(fileId) || fileId <= 0) return [];

    const fileName = String(best.title || best.original_filename || 'Document');
    const token = auth.replace(/^Bearer\s+/i, '');
    const pdfUrl = `${API_BACKEND_URL}/chat/documents/${fileId}/file?token=${encodeURIComponent(token)}`;

    return [
      {
        document_id: fileId,
        document_title: fileName,
        page_number: null,
        relevance_rank: 1,
        mime_type: best.mime_type || 'application/pdf',
        fileId,
        fileName,
        pageNumber: null,
        pdfUrl,
        pdf_url: pdfUrl,
      },
    ];
  } catch {
    return [];
  }
}

export async function attributePagesFromPdf(
  auth: string,
  sources: SourceLike[],
  answer: string,
  question: string
): Promise<SourceLike[]> {
  const token = auth.replace(/^Bearer\s+/i, '');
  const out: SourceLike[] = [];

  for (const source of sources) {
    const fileId = getFileId(source);
    const mime = String(source.mime_type || 'application/pdf');
    const isPdf = !mime || mime === 'application/pdf';
    const currentPage = getPage(source);

    let pageNumber = currentPage;

    if (isPdf && fileId > 0 && auth) {
      const detected = await findBestPageInPdf(fileId, auth, answer, question);
      if (detected != null) {
        if (currentPage == null || currentPage <= 1 || detected !== 1) {
          pageNumber = detected;
        }
      }
    }

    const fileName = String(source.fileName ?? source.document_title ?? 'Document');
    let pdfUrl = `${API_BACKEND_URL}/chat/documents/${fileId}/file?token=${encodeURIComponent(token)}`;
    if (pageNumber) {
      pdfUrl = `${pdfUrl}#page=${pageNumber}`;
    }

    out.push({
      ...source,
      document_id: fileId,
      document_title: fileName,
      fileId,
      fileName,
      page_number: pageNumber,
      pageNumber,
      page_label: pageNumber ? `Page ${pageNumber}` : null,
      pageLabel: pageNumber ? `Page ${pageNumber}` : null,
      mime_type: mime,
      pdfUrl,
      pdf_url: pdfUrl,
    });
  }

  return out;
}

/** Enrich sources for one answered assistant turn (ask + session reload). */
export async function enrichAnswerSources(
  auth: string,
  question: string,
  answer: string,
  rawSources: SourceLike[] | null | undefined
): Promise<SourceLike[]> {
  if (!answer) return [];

  let sources = Array.isArray(rawSources) ? rawSources : [];

  if (sources.length === 0) {
    sources = await attachFallbackSources(auth, question, answer);
  }

  sources = dedupeSources(sources);
  return attributePagesFromPdf(auth, sources, answer, question);
}

async function findBestPageInPdf(
  fileId: number,
  auth: string,
  answer: string,
  question: string
): Promise<number | null> {
  const cacheKey = `${fileId}:${answer.slice(0, 120)}:${question.slice(0, 80)}`;
  if (pageDetectionCache.has(cacheKey)) {
    return pageDetectionCache.get(cacheKey) ?? null;
  }

  try {
    const pages = await loadPdfPages(fileId, auth);
    if (!pages || pages.length === 0) {
      pageDetectionCache.set(cacheKey, null);
      return null;
    }

    const answerTokens = significantTokens(`${answer} ${question}`);
    if (answerTokens.length === 0) {
      pageDetectionCache.set(cacheKey, null);
      return null;
    }

    let bestPage = 0;
    let bestScore = -1;

    pages.forEach((pageText, index) => {
      const pageNum = index + 1;
      const content = String(pageText || '');
      if (!content.trim()) return;
      if (looksLikeToc(content)) return;

      const score = scorePageAgainstAnswer(content, answerTokens, answer);
      if (score > bestScore) {
        bestScore = score;
        bestPage = pageNum;
      }
    });

    const result = bestPage <= 0 || bestScore < 0.08 ? null : bestPage;
    pageDetectionCache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.warn('[chat-source-attribution] PDF page attribution failed for doc', fileId, err);
    pageDetectionCache.set(cacheKey, null);
    return null;
  }
}

async function loadPdfPages(fileId: number, auth: string): Promise<string[] | null> {
  if (pdfPagesCache.has(fileId)) {
    return pdfPagesCache.get(fileId) ?? null;
  }

  const res = await fetch(`${API_BACKEND_URL}/chat/documents/${fileId}/file`, {
    headers: { Authorization: auth },
  });
  if (!res.ok) return null;

  const buffer = new Uint8Array(await res.arrayBuffer());
  if (buffer.byteLength < 100) return null;

  const pdf = await getDocumentProxy(buffer);
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [String(text || '')];
  pdfPagesCache.set(fileId, pages);
  return pages;
}

function looksLikeToc(content: string): boolean {
  const lower = content.toLowerCase();
  if (lower.includes('table of contents')) return true;

  const lines = content.split(/\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 3) return false;

  let tocLines = 0;
  for (const line of lines) {
    if (/\.{3,}\s*\d+\s*$/.test(line) || /\s{3,}\d{1,4}\s*$/.test(line)) {
      tocLines++;
    }
  }
  return tocLines / lines.length >= 0.35;
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

function scorePageAgainstAnswer(pageText: string, answerTokens: string[], answer: string): number {
  const pageLower = pageText.toLowerCase();
  const pageTokens = new Set(significantTokens(pageText));

  let hits = 0;
  for (const token of answerTokens) {
    if (pageTokens.has(token) || pageLower.includes(token)) hits++;
  }
  const tokenScore = answerTokens.length > 0 ? hits / answerTokens.length : 0;

  const words = answer.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 4);
  let phraseHits = 0;
  let phraseTotal = 0;
  for (let i = 0; i < words.length - 3; i++) {
    const phrase = words.slice(i, i + 4).join(' ');
    phraseTotal++;
    if (pageLower.includes(phrase)) phraseHits++;
  }
  const phraseScore = phraseTotal > 0 ? phraseHits / phraseTotal : 0;

  return tokenScore * 0.65 + phraseScore * 0.35;
}
