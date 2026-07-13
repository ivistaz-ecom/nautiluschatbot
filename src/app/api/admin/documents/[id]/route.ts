import { NextRequest, NextResponse } from 'next/server';
import { API_BACKEND_URL } from '@/lib/api-config';
import {
  updateDocumentInDb,
  verifyAdminToken,
  type DocumentUpdateInput,
} from '@/lib/document-db-update';
import { saveDocumentOverride } from '@/lib/document-overrides-store';

export const dynamic = 'force-dynamic';

async function forwardToPhp(
  id: number,
  auth: string,
  body: Record<string, unknown>
): Promise<Response | null> {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(auth ? { Authorization: auth } : {}),
  };
  const json = JSON.stringify(body);
  const base = API_BACKEND_URL.replace(/\/$/, '');

  const attempts: { url: string; method: 'PUT' | 'POST' }[] = [
    { url: `${base}/admin/documents/${id}`, method: 'PUT' },
    { url: `${base}/admin/documents/${id}/update`, method: 'POST' },
    { url: `${base}/document-update.php?id=${id}`, method: 'POST' },
  ];

  for (const { url, method } of attempts) {
    const res = await fetch(url, { method, headers, body: json });
    if (res.status !== 404) {
      return res;
    }
  }

  return null;
}

function parseBody(body: Record<string, unknown>): DocumentUpdateInput {
  return {
    title: String(body.title ?? '').trim(),
    category_id: Number(body.category_id),
    original_filename: body.original_filename
      ? String(body.original_filename).trim()
      : undefined,
  };
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = req.headers.get('authorization') || '';
  const { id } = await params;
  const docId = Number(id);

  if (!Number.isFinite(docId) || docId <= 0) {
    return NextResponse.json({ success: false, message: 'Invalid document id' }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const input = parseBody(body);

  const phpRes = await forwardToPhp(docId, auth, body);
  if (phpRes) {
    const payload = await phpRes.json().catch(() => ({}));
    return NextResponse.json(payload, { status: phpRes.status });
  }

  // PHP routes missing on server — update database directly when configured.
  const isAdmin = await verifyAdminToken(auth, API_BACKEND_URL);
  if (!isAdmin) {
    return NextResponse.json({ success: false, message: 'Authentication required' }, { status: 401 });
  }

  try {
    const doc = await updateDocumentInDb(docId, input);
    return NextResponse.json({ success: true, data: doc, message: 'Document updated' });
  } catch (err) {
    if (err instanceof Error && err.message === 'DB_NOT_CONFIGURED') {
      const categoryName =
        typeof body.category_name === 'string' ? body.category_name.trim() : '';

      const saved = saveDocumentOverride(docId, {
        title: input.title,
        category_id: input.category_id,
        category_name: categoryName || undefined,
        original_filename: input.original_filename,
      });

      return NextResponse.json({
        success: true,
        data: {
          id: docId,
          title: saved.title,
          original_filename: saved.original_filename ?? input.original_filename ?? '',
          category_id: saved.category_id,
          category_name: saved.category_name ?? categoryName,
        },
        message:
          'Saved locally on this dev machine. Upload document-update.php to production for chat to use the new name.',
        local_only: true,
      });
    }

    const message = err instanceof Error ? err.message : 'Update failed';
    const status = message === 'Document not found' ? 404 : message.includes('category') ? 422 : 500;
    return NextResponse.json({ success: false, message }, { status });
  }
}
