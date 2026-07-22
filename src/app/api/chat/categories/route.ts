import { NextRequest, NextResponse } from 'next/server';
import { API_BACKEND_URL } from '@/lib/api-config';
import { syncPendingDocumentOverrides } from '@/lib/document-update-sync';

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

function isReadyPdf(doc: DocRow): boolean {
  const status = String(doc.status || 'ready').toLowerCase();
  if (status && status !== 'ready') return false;
  const mime = String(doc.mime_type || '').toLowerCase();
  const name = String(doc.original_filename || doc.title || '').toLowerCase();
  if (mime.includes('pdf') || name.endsWith('.pdf')) return true;
  // Some uploads store generic binary mime — treat as PDF if no other type is set.
  if (!mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream') {
    return true;
  }
  return false;
}

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

  // Prefer chat/documents (full list, no pagination).
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

function normalizeCategories(rows: CategoryRow[]): CategoryRow[] {
  return rows
    .map((c) => ({
      ...c,
      id: Number(c.id),
      doc_count: c.doc_count != null ? Number(c.doc_count) : undefined,
      sort_order: c.sort_order != null ? Number(c.sort_order) : 0,
    }))
    .filter((c) => c.id > 0)
    .sort(
      (a, b) =>
        (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name)
    );
}

/**
 * Categories with at least one ready PDF — from the LIVE database only.
 *
 * Local filesystem overrides are intentionally NOT applied here, so local
 * Next.js and Vercel both show the same pills for the same API/DB.
 *
 * Pending overrides are still synced to PHP first when possible.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization') || '';

  if (auth) {
    await syncPendingDocumentOverrides(auth);
  }

  // 1) Prefer PHP chat/categories (already filtered to ready PDFs).
  const chatPayload = await fetchJson(`${API_BACKEND_URL}/chat/categories`, auth);
  const chatCats = Array.isArray((chatPayload as { data?: CategoryRow[] } | null)?.data)
    ? (chatPayload as { data: CategoryRow[] }).data
    : [];

  if (chatCats.length > 0) {
    const normalized = normalizeCategories(chatCats).filter(
      (c) => c.doc_count == null || Number(c.doc_count) > 0
    );
    if (normalized.length > 0) {
      return NextResponse.json({ data: normalized });
    }
  }

  // 2) Fallback: rebuild from live documents (no local override remapping).
  const [adminCatPayload, docs] = await Promise.all([
    fetchJson(`${API_BACKEND_URL}/admin/categories`, auth),
    fetchAllReadyDocuments(auth),
  ]);

  const adminCats = Array.isArray((adminCatPayload as { data?: CategoryRow[] } | null)?.data)
    ? (adminCatPayload as { data: CategoryRow[] }).data
    : [];

  const byId = new Map<number, CategoryRow>();
  for (const c of [...chatCats, ...adminCats]) {
    const id = Number(c.id);
    if (!id) continue;
    byId.set(id, { ...byId.get(id), ...c, id });
  }

  const pdfCounts = new Map<number, { count: number; name?: string }>();
  for (const doc of docs) {
    if (!isReadyPdf(doc)) continue;
    const categoryId = Number(doc.category_id);
    if (!categoryId) continue;
    const prev = pdfCounts.get(categoryId);
    pdfCounts.set(categoryId, {
      count: (prev?.count || 0) + 1,
      name: prev?.name || (doc.category_name ? String(doc.category_name) : undefined),
    });
  }

  const result = Array.from(pdfCounts.entries())
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
