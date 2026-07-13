import { extractPdfPages } from './pdf-pages';

export type PdfPageMap = Record<number, string>;

/** Extract per-page text from a PDF buffer (images are ignored). */
export async function extractPdfPagesFromBuffer(buffer: Uint8Array): Promise<PdfPageMap> {
  const pages = await extractPdfPages(buffer);
  const out: PdfPageMap = {};

  pages.forEach((text, index) => {
    out[index + 1] = String(text || '').trim();
  });

  return out;
}

export function countMeaningfulChars(pages: PdfPageMap): number {
  let total = 0;
  for (const text of Object.values(pages)) {
    if (!text) continue;
    total += text.replace(/\s+/g, '').length;
  }
  return total;
}
