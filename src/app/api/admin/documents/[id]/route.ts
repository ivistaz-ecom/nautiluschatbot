import { NextRequest, NextResponse } from 'next/server';
import { API_BACKEND_URL } from '@/lib/api-config';
import {
  updateDocumentInDb,
  verifyAdminToken,
  type DocumentUpdateInput,
} from '@/lib/document-db-update';
import {
  saveDocumentOverride,
  clearDocumentOverride,
} from '@/lib/document-overrides-store';
import { forwardDocumentUpdateToPhp } from '@/lib/document-update-sync';

export const dynamic = 'force-dynamic';

function parseBody(body: Record<string, unknown>): DocumentUpdateInput {
  return {
    title: String(body.title ?? '').trim(),
    category_id: Number(body.category_id),
    original_filename: body.original_filename
      ? String(body.original_filename).trim()
      : undefined,
  };
}

function jsonError(message: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ success: false, message, ...extra }, { status });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = req.headers.get('authorization') || '';
    const { id } = await params;
    const docId = Number(id);

    if (!Number.isFinite(docId) || docId <= 0) {
      return jsonError('Invalid document id', 400);
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const input = parseBody(body);

    if (!input.title) {
      return jsonError('Document name is required', 422);
    }
    if (!Number.isFinite(input.category_id) || input.category_id <= 0) {
      return jsonError('Invalid category', 422);
    }

    // 1) Live PHP API (source of truth on Vercel + production)
    const phpResult = await forwardDocumentUpdateToPhp(docId, auth, body);
    if (phpResult?.ok) {
      clearDocumentOverride(docId);
      return NextResponse.json(
        Object.keys(phpResult.payload || {}).length > 0
          ? phpResult.payload
          : {
              success: true,
              data: {
                id: docId,
                title: input.title,
                category_id: input.category_id,
                original_filename: input.original_filename ?? '',
              },
              message: 'Document updated',
            },
        { status: phpResult.status || 200 }
      );
    }
    if (
      phpResult &&
      !phpResult.ok &&
      (phpResult.status === 401 || phpResult.status === 403 || phpResult.status === 422)
    ) {
      const msg =
        typeof phpResult.payload?.message === 'string'
          ? phpResult.payload.message
          : 'Update rejected';
      return NextResponse.json(
        { success: false, message: msg, ...phpResult.payload },
        { status: phpResult.status }
      );
    }

    const isAdmin = await verifyAdminToken(auth, API_BACKEND_URL);
    if (!isAdmin) {
      return jsonError('Authentication required', 401);
    }

    // 2) Direct DB update when API_DB_* is configured
    try {
      const doc = await updateDocumentInDb(docId, input);
      clearDocumentOverride(docId);
      return NextResponse.json({ success: true, data: doc, message: 'Document updated' });
    } catch (err) {
      if (!(err instanceof Error && err.message === 'DB_NOT_CONFIGURED')) {
        const message = err instanceof Error ? err.message : 'Update failed';
        const status =
          message === 'Document not found' ? 404 : message.includes('category') ? 422 : 500;
        return jsonError(message, status);
      }
    }

    // 3) Local override (dev only — ephemeral on Vercel)
    const categoryName =
      typeof body.category_name === 'string' ? body.category_name.trim() : '';

    try {
      const saved = saveDocumentOverride(docId, {
        title: input.title,
        category_id: input.category_id,
        category_name: categoryName || undefined,
        original_filename: input.original_filename,
      });

      return NextResponse.json(
        {
          success: false,
          local_only: true,
          data: {
            id: docId,
            title: saved.title,
            original_filename: saved.original_filename ?? input.original_filename ?? '',
            category_id: saved.category_id,
            category_name: saved.category_name ?? categoryName,
          },
          message:
            'Could not update the live database. Upload nautilusapi/document-update.php (or the latest DocumentController) to the PHP host, then try again.',
        },
        { status: 502 }
      );
    } catch (err) {
      const readonly =
        err instanceof Error && err.message.startsWith('OVERRIDE_STORE_READONLY');
      return jsonError(
        readonly
          ? 'Category could not be saved on Vercel because the live PHP update API is missing. Upload nautilusapi/document-update.php to https://nautilus.crafttechhub.com/api/v1/ (same folder as index.php), then edit the document again.'
          : err instanceof Error
            ? err.message
            : 'Update failed',
        502,
        { needs_php_update: true }
      );
    }
  } catch (err) {
    return jsonError(
      err instanceof Error ? err.message : 'Unexpected error while updating document',
      500
    );
  }
}
