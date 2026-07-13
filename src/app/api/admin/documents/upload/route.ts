import { NextRequest, NextResponse } from 'next/server';
import { API_BACKEND_URL } from '@/lib/api-config';
import {
  DEPLOY_PHP_MESSAGE,
  enrichIngestFailure,
  pushParsedPagesToApi,
} from '@/lib/document-ingest';
import { countMeaningfulChars, extractPdfPagesFromBuffer, type PdfPageMap } from '@/lib/pdf-upload-extract';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Upload: save file on PHP, extract PDF text in Node, index via ingest-pages JSON.
 */
export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') || '';
  const incoming = await req.formData();

  const file = incoming.get('file');
  const categoryId = incoming.get('category_id');
  const title = incoming.get('title');

  if (!(file instanceof File)) {
    return NextResponse.json({ success: false, message: 'No file provided' }, { status: 400 });
  }

  const isPdf =
    file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

  const fileBuffer = Buffer.from(await file.arrayBuffer());
  let pages: PdfPageMap | null = null;

  if (isPdf) {
    try {
      const extractCopy = Buffer.from(fileBuffer);
      pages = await extractPdfPagesFromBuffer(new Uint8Array(extractCopy));
      if (countMeaningfulChars(pages) < 30) {
        return NextResponse.json(
          {
            success: false,
            message:
              'Could not extract enough readable text from this PDF. Export a fresh PDF from Word or upload the DOCX file instead.',
          },
          { status: 422 }
        );
      }
    } catch (err) {
      console.warn('[document-upload] Node PDF extract failed:', err);
      return NextResponse.json(
        {
          success: false,
          message: err instanceof Error ? err.message : 'Failed to read PDF on server.',
        },
        { status: 422 }
      );
    }
  }

  const upstream = new FormData();
  if (categoryId != null) upstream.append('category_id', String(categoryId));
  if (title != null) upstream.append('title', String(title));
  upstream.append('skip_server_parse', '1');
  upstream.set(
    'file',
    new Blob([fileBuffer], { type: file.type || 'application/octet-stream' }),
    file.name
  );

  const uploadRes = await fetch(`${API_BACKEND_URL}/admin/documents`, {
    method: 'POST',
    headers: auth ? { Authorization: auth } : {},
    body: upstream,
  });

  const uploadPayload = await uploadRes.json().catch(() => ({}));
  if (!uploadRes.ok) {
    return NextResponse.json(uploadPayload, { status: uploadRes.status });
  }

  const docId = Number((uploadPayload as { data?: { document_id?: number } }).data?.document_id);
  if (!Number.isFinite(docId) || docId <= 0) {
    return NextResponse.json(
      { success: false, message: 'Upload succeeded but no document id was returned.' },
      { status: 500 }
    );
  }

  if (!isPdf || !pages) {
    return NextResponse.json(uploadPayload, { status: uploadRes.status });
  }

  const ingest = await pushParsedPagesToApi(docId, pages, auth);
  if (ingest.ok) {
    return NextResponse.json(ingest.payload, { status: ingest.status });
  }

  const failed = enrichIngestFailure(ingest);

  return NextResponse.json(
    {
      ...uploadPayload,
      success: false,
      message:
        ingest.status === 404
          ? `${DEPLOY_PHP_MESSAGE} Document #${docId} was saved but could not be indexed.`
          : failed.message,
      data: {
        ...(uploadPayload as { data?: Record<string, unknown> }).data,
        document_id: docId,
        status: 'error',
        error:
          typeof failed.message === 'string'
            ? failed.message
            : 'Indexing failed — deploy latest PHP and click Re-parse.',
      },
    },
    { status: ingest.status === 404 ? 502 : ingest.status }
  );
}
