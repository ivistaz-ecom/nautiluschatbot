import { NextRequest, NextResponse } from 'next/server';
import { API_BACKEND_URL } from '@/lib/api-config';

export const dynamic = 'force-dynamic';

type DocRow = {
  id: number;
  title: string;
  original_filename?: string;
  status: string;
  page_count?: number | null;
  chunk_count?: number | null;
  file_on_disk?: boolean;
};

export type IndexingHealth = 'good' | 'low' | 'none' | 'not_ready';

function classifyIndexing(doc: DocRow): IndexingHealth {
  if (doc.status !== 'ready') return 'not_ready';
  const chunks = Number(doc.chunk_count ?? 0);
  if (chunks === 0) return 'none';
  const pages = Number(doc.page_count ?? 0);
  if (pages > 30 && chunks < pages * 0.15) return 'low';
  if (chunks < 10) return 'low';
  return 'good';
}

async function upstreamGet(path: string, auth: string) {
  const res = await fetch(`${API_BACKEND_URL}${path}`, {
    headers: auth ? { Authorization: auth } : {},
    cache: 'no-store',
  });
  const payload = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, payload };
}

/** Report how fully each PDF is indexed for chat retrieval. */
export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization') || '';
  if (!auth) {
    return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 });
  }

  const allDocs: DocRow[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const { ok, status, payload } = await upstreamGet(
      `/admin/documents?page=${page}&per_page=${perPage}`,
      auth
    );
    if (!ok) {
      return NextResponse.json(payload, { status });
    }

    const batch = (payload?.data ?? []) as DocRow[];
    allDocs.push(...batch);

    const total = Number(payload?.meta?.total ?? batch.length);
    if (allDocs.length >= total || batch.length < perPage) break;
    page += 1;
  }

  const needsChunkCount = allDocs.filter(
    (doc) => doc.chunk_count == null && doc.status === 'ready'
  );

  await Promise.all(
    needsChunkCount.map(async (doc) => {
      const { ok, payload } = await upstreamGet(`/admin/documents/${doc.id}`, auth);
      if (ok && payload?.data) {
        doc.chunk_count = Number(payload.data.chunk_count ?? 0);
      }
    })
  );

  const documents = allDocs.map((doc) => ({
    id: doc.id,
    title: doc.title,
    original_filename: doc.original_filename,
    status: doc.status,
    page_count: doc.page_count ?? null,
    chunk_count: Number(doc.chunk_count ?? 0),
    file_on_disk: doc.file_on_disk !== false,
    indexing: classifyIndexing(doc),
  }));

  const ready = documents.filter((d) => d.status === 'ready');
  const summary = {
    total_documents: documents.length,
    ready_documents: ready.length,
    total_chunks: ready.reduce((sum, d) => sum + d.chunk_count, 0),
    low_indexing: documents.filter((d) => d.indexing === 'low').length,
    not_indexed: documents.filter((d) => d.indexing === 'none').length,
    errors: documents.filter((d) => d.status === 'error').length,
  };

  return NextResponse.json({ success: true, data: { summary, documents } });
}
