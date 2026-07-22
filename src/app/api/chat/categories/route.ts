import { NextRequest, NextResponse } from 'next/server';
import { API_BACKEND_URL } from '@/lib/api-config';
import { syncPendingDocumentOverrides } from '@/lib/document-update-sync';
import { getDocumentOverrides } from '@/lib/document-overrides-store';
import { countReadyPdfsByCategory } from '@/lib/effective-document-categories';

export const dynamic = 'force-dynamic';

type CategoryRow = {
  id: number;
  name: string;
  slug?: string;
  description?: string;
  parent_id?: number | null;
  sort_order?: number;
  doc_count?: number;
};

type DocRow = {
  id?: number;
  category_id?: number;
  category_name?: string;
  mime_type?: string;
  original_filename?: string;
  title?: string;
  status?: string;
};

async function fetchJson(url: string, auth: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: auth ? { Authorization: auth } : {},
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchAllReadyDocuments(auth: string): Promise<DocRow[]> {
  const all: DocRow[] = [];

  const chatPayload = await fetchJson(
    `${API_BACKEND_URL}/chat/documents?status=ready`,
    auth
  );
  const chatDocs = (chatPayload as { data?: DocRow[] } | null)?.data;
  if (Array.isArray(chatDocs) && chatDocs.length > 0) {
    return chatDocs;
  }

  for (let page = 1; page <= 50; page++) {
    const payload = await fetchJson(
      `${API_BACKEND_URL}/admin/documents?status=ready&per_page=100&page=${page}`,
      auth
    );
    if (!payload) break;

    const data = (payload as { data?: DocRow[] }).data;
    const meta = (payload as { meta?: { total_pages?: number } }).meta;
    if (!Array.isArray(data) || data.length === 0) break;

    all.push(...data);

    const totalPages = Number(meta?.total_pages || 0);
    if (totalPages > 0 && page >= totalPages) break;
    if (data.length < 100) break;
  }

  return all;
}

/**
 * Categories that currently have ≥1 ready PDF.
 * Uses live documents + pending local overrides so Admin Documents edits
 * show up in chat pills even before the PHP update endpoint is deployed.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization') || '';

  if (auth) {
    await syncPendingDocumentOverrides(auth);
  }

  const [catPayload, adminCatPayload, docs] = await Promise.all([
    fetchJson(`${API_BACKEND_URL}/chat/categories`, auth),
    fetchJson(`${API_BACKEND_URL}/admin/categories`, auth),
    fetchAllReadyDocuments(auth),
  ]);

  const chatCats = Array.isArray((catPayload as { data?: CategoryRow[] } | null)?.data)
    ? (catPayload as { data: CategoryRow[] }).data
    : [];
  const adminCats = Array.isArray((adminCatPayload as { data?: CategoryRow[] } | null)?.data)
    ? (adminCatPayload as { data: CategoryRow[] }).data
    : [];

  const byId = new Map<number, CategoryRow>();
  for (const c of [...chatCats, ...adminCats]) {
    const id = Number(c.id);
    if (!id) continue;
    byId.set(id, { ...byId.get(id), ...c, id });
  }

  const overrides = getDocumentOverrides();
  const pdfCounts = countReadyPdfsByCategory(docs, overrides);

  const result = Array.from(pdfCounts.entries())
    .filter(([, { count }]) => count > 0)
    .map(([id, { count, name }]) => {
      const existing = byId.get(id);
      return {
        id,
        name: existing?.name || name || `Category ${id}`,
        slug: existing?.slug || '',
        description: existing?.description,
        parent_id: existing?.parent_id ?? null,
        sort_order: existing?.sort_order ?? 0,
        doc_count: count,
      };
    })
    .sort(
      (a, b) =>
        (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name)
    );

  return NextResponse.json({ data: result });
}
