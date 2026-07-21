import { NextRequest, NextResponse } from 'next/server';
import { locateSourcesForQuestion } from '@/lib/chat-source-attribution';
import { API_BACKEND_URL } from '@/lib/api-config';

export const dynamic = 'force-dynamic';

/**
 * Locate source pages for a question.
 * Tries production chunk index first, then local PDF grounding.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization') || '';
  const question = req.nextUrl.searchParams.get('q') || req.nextUrl.searchParams.get('question') || '';
  const answer = req.nextUrl.searchParams.get('answer') || '';
  const documentId = req.nextUrl.searchParams.get('document_id');
  const categoryIdsParam = req.nextUrl.searchParams.get('category_ids');
  const categoryIdParam = req.nextUrl.searchParams.get('category_id');
  const categoryIds = Array.from(
    new Set(
      [
        ...(categoryIdsParam ? categoryIdsParam.split(',') : []),
        ...(categoryIdParam ? [categoryIdParam] : []),
      ]
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n) && n > 0)
    )
  );
  const categoryIdsOrUndef = categoryIds.length > 0 ? categoryIds : undefined;

  if (question.trim().length < 3) {
    return NextResponse.json({ success: false, message: 'Question too short' }, { status: 422 });
  }

  // Prefer production DB chunk index when deployed.
  if (auth) {
    const params = new URLSearchParams({ q: question });
    if (answer.trim()) params.set('answer', answer.slice(0, 800));
    if (documentId) params.set('document_id', documentId);
    if (categoryIdsOrUndef?.length === 1) {
      params.set('category_id', String(categoryIdsOrUndef[0]));
    } else if (categoryIdsOrUndef && categoryIdsOrUndef.length > 1) {
      params.set('category_ids', categoryIdsOrUndef.join(','));
    }

    try {
      const upstream = await fetch(`${API_BACKEND_URL}/chat/locate-source?${params}`, {
        headers: { Authorization: auth },
        cache: 'no-store',
      });
      if (upstream.ok) {
        const payload = await upstream.json();
        if (Array.isArray(payload?.data?.sources) && payload.data.sources.length > 0) {
          return NextResponse.json(payload);
        }
      }
    } catch {
      // Fall through to local grounding
    }
  }

  const sources = await locateSourcesForQuestion(
    auth,
    question,
    answer,
    documentId ? Number(documentId) : undefined,
    categoryIdsOrUndef
  );

  return NextResponse.json({ success: true, data: { sources } });
}
