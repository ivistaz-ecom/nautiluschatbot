import { API_BACKEND_URL } from '@/lib/api-config';
import { countMeaningfulChars, extractPdfPagesFromBuffer, type PdfPageMap } from '@/lib/pdf-upload-extract';

type IngestResult = {
  ok: boolean;
  status: number;
  payload: Record<string, unknown>;
};

function authHeaders(auth: string): HeadersInit {
  return auth ? { Authorization: auth } : {};
}

export async function extractPdfPagesFromFile(file: File): Promise<PdfPageMap> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const extractCopy = Buffer.from(buffer);
  const pages = await extractPdfPagesFromBuffer(new Uint8Array(extractCopy));

  const chars = countMeaningfulChars(pages);
  if (chars < 30) {
    throw new Error(
      'Could not extract enough readable text from this PDF. Export a fresh PDF from Word or upload the DOCX file instead.'
    );
  }

  return pages;
}

export function pdfFileBuffer(file: File, buffer: Buffer): FormData {
  const form = new FormData();
  const bytes = new Uint8Array(buffer);
  form.set('file', new Blob([bytes], { type: file.type || 'application/pdf' }), file.name);
  return form;
}

async function ingestPagesJson(
  docId: number,
  pages: PdfPageMap,
  auth: string
): Promise<IngestResult> {
  const res = await fetch(`${API_BACKEND_URL}/admin/documents/${docId}/ingest-pages`, {
    method: 'POST',
    headers: {
      ...authHeaders(auth),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ pages }),
  });

  const payload = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, payload };
}

async function reparsePagesJson(
  docId: number,
  pages: PdfPageMap,
  auth: string
): Promise<IngestResult> {
  const res = await fetch(`${API_BACKEND_URL}/admin/documents/${docId}/reparse`, {
    method: 'POST',
    headers: {
      ...authHeaders(auth),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ pages }),
  });

  const payload = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, payload };
}

async function reparsePagesMultipart(
  docId: number,
  pages: PdfPageMap,
  auth: string
): Promise<IngestResult> {
  const form = new FormData();
  form.append('parsed_pages', JSON.stringify(pages));

  const res = await fetch(`${API_BACKEND_URL}/admin/documents/${docId}/reparse`, {
    method: 'POST',
    headers: authHeaders(auth),
    body: form,
  });

  const payload = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, payload };
}

/** Push Node-extracted pages to PHP using the best available endpoint. */
export async function pushParsedPagesToApi(
  docId: number,
  pages: PdfPageMap,
  auth: string
): Promise<IngestResult> {
  const attempts = [
    () => ingestPagesJson(docId, pages, auth),
    () => reparsePagesJson(docId, pages, auth),
    () => reparsePagesMultipart(docId, pages, auth),
  ];

  let last: IngestResult = { ok: false, status: 500, payload: {} };

  for (const attempt of attempts) {
    last = await attempt();
    if (last.ok) return last;
    if (last.status !== 404) break;
  }

  return last;
}

export const DEPLOY_PHP_MESSAGE =
  'The API server needs the latest PHP files deployed (DocumentController.php + index.php). See nautilusapi/DEPLOY_SOURCES.md';

export function enrichIngestFailure(result: IngestResult): Record<string, unknown> {
  if (result.ok) return result.payload;

  const message =
    (typeof result.payload.message === 'string' && result.payload.message) ||
    (result.status === 404 ? DEPLOY_PHP_MESSAGE : 'Document indexing failed on the server.');

  return {
    ...result.payload,
    success: false,
    message,
  };
}
