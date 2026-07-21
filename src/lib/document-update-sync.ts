import { API_BACKEND_URL } from '@/lib/api-config';
import {
  getDocumentOverrides,
  clearDocumentOverride,
  type DocumentOverride,
} from '@/lib/document-overrides-store';

/**
 * Try every known PHP update endpoint. Skip 404/405 so Apache/PUT
 * limitations don't block the POST fallbacks.
 */
export async function forwardDocumentUpdateToPhp(
  id: number,
  auth: string,
  body: Record<string, unknown>
): Promise<{ ok: true; status: number; payload: Record<string, unknown> } | { ok: false; status: number; payload: Record<string, unknown> } | null> {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(auth ? { Authorization: auth } : {}),
  };
  const json = JSON.stringify(body);
  const base = API_BACKEND_URL.replace(/\/$/, '');

  // Prefer POST — many hosts reject PUT to PHP routes.
  const attempts: { url: string; method: 'PUT' | 'POST' }[] = [
    { url: `${base}/admin/documents/${id}/update`, method: 'POST' },
    { url: `${base}/document-update.php?id=${id}`, method: 'POST' },
    { url: `${base}/admin/documents/${id}`, method: 'PUT' },
    { url: `${base}/admin/documents/${id}`, method: 'POST' },
  ];

  let lastFailure: { status: number; payload: Record<string, unknown> } | null = null;

  for (const { url, method } of attempts) {
    try {
      const res = await fetch(url, { method, headers, body: json });
      if (res.status === 404 || res.status === 405) {
        continue;
      }

      const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok) {
        return { ok: true, status: res.status, payload };
      }

      // Auth/validation errors are definitive — don't keep probing.
      if (res.status === 401 || res.status === 403 || res.status === 422) {
        return { ok: false, status: res.status, payload };
      }

      lastFailure = { status: res.status, payload };
    } catch {
      // try next endpoint
    }
  }

  if (lastFailure) {
    return { ok: false, status: lastFailure.status, payload: lastFailure.payload };
  }

  return null;
}

/** Push any locally-saved category/title overrides to the live PHP API. */
export async function syncPendingDocumentOverrides(auth: string): Promise<{
  synced: number[];
  failed: number[];
}> {
  const overrides = getDocumentOverrides();
  const synced: number[] = [];
  const failed: number[] = [];

  for (const [idStr, ov] of Object.entries(overrides)) {
    const id = Number(idStr);
    if (!Number.isFinite(id) || id <= 0) continue;

    const body = overrideToUpdateBody(ov);
    const result = await forwardDocumentUpdateToPhp(id, auth, body);

    if (result?.ok) {
      clearDocumentOverride(id);
      synced.push(id);
    } else {
      failed.push(id);
    }
  }

  return { synced, failed };
}

export function overrideToUpdateBody(ov: DocumentOverride): Record<string, unknown> {
  return {
    title: ov.title,
    category_id: ov.category_id,
    ...(ov.original_filename ? { original_filename: ov.original_filename } : {}),
    ...(ov.category_name ? { category_name: ov.category_name } : {}),
  };
}
