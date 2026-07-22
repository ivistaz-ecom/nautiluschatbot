import { getDocumentOverrides, type DocumentOverride } from '@/lib/document-overrides-store';

export type DocForCategoryCount = {
  id?: number;
  category_id?: number;
  category_name?: string;
  mime_type?: string;
  original_filename?: string;
  title?: string;
  status?: string;
};

export function isReadyPdfDoc(doc: DocForCategoryCount): boolean {
  const status = String(doc.status || 'ready').toLowerCase();
  if (status && status !== 'ready') return false;
  const mime = String(doc.mime_type || '').toLowerCase();
  const name = String(doc.original_filename || doc.title || '').toLowerCase();
  if (mime.includes('pdf') || name.endsWith('.pdf')) return true;
  if (!mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream') {
    return true;
  }
  return false;
}

/** Effective category after pending local override (if any). */
export function effectiveCategoryId(
  doc: DocForCategoryCount,
  overrides: Record<string, DocumentOverride> = getDocumentOverrides()
): number {
  const docId = Number(doc.id);
  const ov = docId ? overrides[String(docId)] : null;
  return Number(ov?.category_id ?? doc.category_id ?? 0);
}

export function effectiveCategoryName(
  doc: DocForCategoryCount,
  overrides: Record<string, DocumentOverride> = getDocumentOverrides()
): string | undefined {
  const docId = Number(doc.id);
  const ov = docId ? overrides[String(docId)] : null;
  return ov?.category_name || (doc.category_name ? String(doc.category_name) : undefined);
}

/**
 * Count ready PDFs per category, honouring pending local overrides so
 * Admin Documents, Admin Categories, and Chat pills stay aligned.
 */
export function countReadyPdfsByCategory(
  docs: DocForCategoryCount[],
  overrides: Record<string, DocumentOverride> = getDocumentOverrides()
): Map<number, { count: number; name?: string }> {
  const pdfCounts = new Map<number, { count: number; name?: string }>();

  for (const doc of docs) {
    if (!isReadyPdfDoc(doc)) continue;
    const categoryId = effectiveCategoryId(doc, overrides);
    if (!categoryId) continue;
    const prev = pdfCounts.get(categoryId);
    pdfCounts.set(categoryId, {
      count: (prev?.count || 0) + 1,
      name: prev?.name || effectiveCategoryName(doc, overrides),
    });
  }

  // Override-only rows (rare) if a doc id is not in the fetched list.
  for (const [idStr, ov] of Object.entries(overrides)) {
    const docId = Number(idStr);
    if (docs.some((d) => Number(d.id) === docId)) continue;
    const categoryId = Number(ov.category_id);
    if (!categoryId) continue;
    const prev = pdfCounts.get(categoryId);
    pdfCounts.set(categoryId, {
      count: (prev?.count || 0) + 1,
      name: prev?.name || ov.category_name,
    });
  }

  return pdfCounts;
}

/**
 * Document IDs whose effective category is in `categoryIds`
 * (DB category or pending override). Used so chat search still finds
 * reassigned PDFs before the live DB update is deployed.
 */
export function documentIdsForCategories(
  categoryIds: number[],
  docs: DocForCategoryCount[],
  overrides: Record<string, DocumentOverride> = getDocumentOverrides()
): number[] {
  const wanted = new Set(categoryIds.map(Number).filter((n) => n > 0));
  if (wanted.size === 0) return [];

  const ids = new Set<number>();
  for (const doc of docs) {
    const id = Number(doc.id);
    if (!id) continue;
    if (wanted.has(effectiveCategoryId(doc, overrides))) ids.add(id);
  }
  for (const [idStr, ov] of Object.entries(overrides)) {
    const id = Number(idStr);
    if (id && wanted.has(Number(ov.category_id))) ids.add(id);
  }
  return Array.from(ids);
}
