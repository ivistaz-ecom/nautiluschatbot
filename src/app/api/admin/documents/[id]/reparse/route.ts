import { NextRequest, NextResponse } from 'next/server';
import { API_BACKEND_URL } from '@/lib/api-config';
import {
  enrichIngestFailure,
  extractPdfPagesFromFile,
  pushParsedPagesToApi,
} from '@/lib/document-ingest';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Re-parse: extract PDF text in Node (from upload or server file), index via ingest-pages.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = req.headers.get('authorization') || '';
  const { id } = await params;
  const docId = Number(id);

  if (!Number.isFinite(docId) || docId <= 0) {
    return NextResponse.json({ success: false, message: 'Invalid document id' }, { status: 400 });
  }

  const authHeaders: HeadersInit = auth ? { Authorization: auth } : {};
  const incoming = await req.formData().catch(() => null);
  const clientFile = incoming?.get('file');

  let pages: Awaited<ReturnType<typeof extractPdfPagesFromFile>> | null = null;

  if (clientFile instanceof File) {
    try {
      pages = await extractPdfPagesFromFile(clientFile);
    } catch (err) {
      return NextResponse.json(
        {
          success: false,
          message: err instanceof Error ? err.message : 'Failed to read PDF.',
        },
        { status: 422 }
      );
    }
  } else {
    const metaRes = await fetch(`${API_BACKEND_URL}/admin/documents/${docId}`, {
      headers: authHeaders,
    });
    const metaPayload = await metaRes.json();
    if (!metaRes.ok) {
      return NextResponse.json(metaPayload, { status: metaRes.status });
    }

    const doc = metaPayload.data as { mime_type?: string; original_filename?: string };
    const isPdf =
      doc.mime_type === 'application/pdf' ||
      (doc.original_filename || '').toLowerCase().endsWith('.pdf');

    if (isPdf) {
      const fileRes = await fetch(`${API_BACKEND_URL}/admin/documents/${docId}/file`, {
        headers: authHeaders,
      });

      if (!fileRes.ok) {
        return NextResponse.json(
          {
            success: false,
            message:
              'Could not download PDF from server. Pick the PDF file when re-parsing, or deploy the latest API.',
          },
          { status: 422 }
        );
      }

      try {
        const buffer = Buffer.from(await fileRes.arrayBuffer());
        const extractCopy = Buffer.from(buffer);
        const { extractPdfPagesFromBuffer, countMeaningfulChars } = await import(
          '@/lib/pdf-upload-extract'
        );
        const extracted = await extractPdfPagesFromBuffer(new Uint8Array(extractCopy));
        if (countMeaningfulChars(extracted) < 30) {
          return NextResponse.json(
            {
              success: false,
              message:
                'Could not extract enough text from the server PDF. Re-upload the file or pick it when re-parsing.',
            },
            { status: 422 }
          );
        }
        pages = extracted;
      } catch (err) {
        console.warn('[document-reparse] Node PDF extract failed:', err);
        return NextResponse.json(
          { success: false, message: 'Failed to read PDF. Pick the file when re-parsing.' },
          { status: 422 }
        );
      }
    }
  }

  if (!pages) {
    const res = await fetch(`${API_BACKEND_URL}/admin/documents/${docId}/reparse`, {
      method: 'POST',
      headers: authHeaders,
    });
    const payload = await res.json();
    return NextResponse.json(payload, { status: res.status });
  }

  const ingest = await pushParsedPagesToApi(docId, pages, auth);
  if (ingest.ok) {
    return NextResponse.json(ingest.payload, { status: ingest.status });
  }

  return NextResponse.json(enrichIngestFailure(ingest), {
    status: ingest.status === 404 ? 502 : ingest.status,
  });
}
