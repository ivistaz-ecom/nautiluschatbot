import { NextRequest, NextResponse } from 'next/server';
import { API_BACKEND_URL } from '@/lib/api-config';
import { syncPendingDocumentOverrides } from '@/lib/document-update-sync';
import { getDocumentOverrides } from '@/lib/document-overrides-store';

export const dynamic = 'force-dynamic';

type CategoryRow = {
  id: number;
  name: string;
  slug?: string;
  description?: string;
  parent_id?: number | null;
  parent_name?: string | null;
  sort_order?: number;
  doc_count?: number;
};

type DocRow = {
  id?: number;
  category_id?: number;
  status?: string;
};

/**
 * Admin categories with accurate doc counts.
 * Also pushes any pending local document overrides to the live API first.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization') || '';

  // Flush local-only category edits to the live DB when possible.
  if (auth) {
    await syncPendingDocumentOverrides(auth);
  }

  const catRes = await fetch(`${API_BACKEND_URL}/admin/categories`, {
    headers: auth ? { Authorization: auth } : {},
    cache: 'no-store',
  });

  const catPayload = await catRes.json().catch(() => ({}));
  if (!catRes.ok) {
    return NextResponse.json(catPayload, { status: catRes.status });
  }

  const categories: CategoryRow[] = Array.isArray(catPayload?.data) ? catPayload.data : [];

  // Rebuild doc_count from live documents (+ any remaining local overrides).
  const docs = await fetchAllReadyDocs(auth);
  const overrides = getDocumentOverrides();

  const counts = new Map<number, number>();
  for (const doc of docs) {
    const id = Number(doc.id);
    const ov = id ? overrides[String(id)] : null;
    const categoryId = Number(ov?.category_id ?? doc.category_id ?? 0);
    if (!categoryId) continue;
    counts.set(categoryId, (counts.get(categoryId) || 0) + 1);
  }

  // Include override-only docs not present in the fetched page set (shouldn't happen often).
  for (const [idStr, ov] of Object.entries(overrides)) {
    const docId = Number(idStr);
    if (docs.some((d) => Number(d.id) === docId)) continue;
    const categoryId = Number(ov.category_id);
    if (!categoryId) continue;
    counts.set(categoryId, (counts.get(categoryId) || 0) + 1);
  }

  const data = categories.map((c) => ({
    ...c,
    id: Number(c.id),
    doc_count: counts.has(Number(c.id))
      ? counts.get(Number(c.id))
      : Number(c.doc_count ?? 0),
  }));

  return NextResponse.json({ data });
}

async function fetchAllReadyDocs(auth: string): Promise<DocRow[]> {
  const all: DocRow[] = [];

  const chatRes = await fetch(`${API_BACKEND_URL}/chat/documents?status=ready`, {
    headers: auth ? { Authorization: auth } : {},
    cache: 'no-store',
  });
  if (chatRes.ok) {
    const json = await chatRes.json().catch(() => ({}));
    if (Array.isArray(json?.data) && json.data.length > 0) {
      return json.data;
    }
  }

  for (let page = 1; page <= 50; page++) {
    const res = await fetch(
      `${API_BACKEND_URL}/admin/documents?status=ready&per_page=100&page=${page}`,
      {
        headers: auth ? { Authorization: auth } : {},
        cache: 'no-store',
      }
    );
    if (!res.ok) break;
    const json = await res.json().catch(() => ({}));
    const rows: DocRow[] = Array.isArray(json?.data) ? json.data : [];
    if (rows.length === 0) break;
    all.push(...rows);
    const totalPages = Number(json?.meta?.total_pages || 0);
    if (totalPages > 0 && page >= totalPages) break;
    if (rows.length < 100) break;
  }

  return all;
}
