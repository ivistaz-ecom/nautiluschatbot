/**
 * Extract per-page text for source attribution.
 * Uses unpdf — works in Next.js server routes without pdfjs worker setup.
 */
import { extractText, getDocumentProxy } from 'unpdf';

const pdfPagesCache = new Map<number, string[]>();

export function getCachedPdfPages(fileId: number): string[] | null {
  return pdfPagesCache.get(fileId) ?? null;
}

export function cachePdfPages(fileId: number, pages: string[]): void {
  pdfPagesCache.set(fileId, pages);
}

export async function extractPdfPages(buffer: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(buffer, { verbosity: 0 });
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [String(text || '')];
  return pages;
}
