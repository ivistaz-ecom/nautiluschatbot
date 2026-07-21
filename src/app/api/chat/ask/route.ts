import { NextRequest, NextResponse } from 'next/server';
import { resolveAssistantTurn, mergeAssistantSources } from '@/lib/chat-source-attribution';
import { API_BACKEND_URL } from '@/lib/api-config';

export const dynamic = 'force-dynamic';

function parseCategoryIds(body: Record<string, unknown>): number[] | undefined {
  const fromArray = Array.isArray(body?.category_ids)
    ? body.category_ids.map((v) => Number(v)).filter((n) => n > 0)
    : [];
  const single =
    body?.category_id != null && Number(body.category_id) > 0
      ? [Number(body.category_id)]
      : [];
  const ids = Array.from(new Set([...fromArray, ...single]));
  return ids.length > 0 ? ids : undefined;
}

function notFoundInSelectedCategoriesMessage(categoryIds: number[]): string {
  return categoryIds.length <= 1
    ? 'The given question was not found in the selected category.'
    : 'The given question was not found in the selected categories.';
}

/**
 * Proxies POST /chat/ask to the PHP API, then recovers missed answers
 * and attaches exact PDF page citations.
 */
export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') || '';
  const body = await req.json();

  const upstream = await fetch(`${API_BACKEND_URL}/chat/ask`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  });

  const payload = await upstream.json();

  if (!upstream.ok) {
    return NextResponse.json(payload, { status: upstream.status });
  }

  const data = payload?.data;
  if (!data || typeof data !== 'object') {
    return NextResponse.json(payload);
  }

  const question = typeof body?.question === 'string' ? body.question : '';
  const categoryIds = parseCategoryIds(body ?? {});
  const answer = typeof data.answer === 'string' ? data.answer : '';
  const isAnswered = Boolean(data.is_answered);
  const rawSources = Array.isArray(data.sources) ? data.sources : [];

  const resolved = await resolveAssistantTurn(
    auth,
    question,
    answer,
    isAnswered,
    rawSources,
    categoryIds
  );

  // Enforce category scope: never return out-of-scope answers/sources.
  if (categoryIds) {
    const scopedOk =
      Boolean(resolved.is_answered) &&
      Array.isArray(resolved.sources) &&
      resolved.sources.length > 0;
    if (!scopedOk) {
      data.answer = notFoundInSelectedCategoriesMessage(categoryIds);
      data.is_answered = false;
      data.sources = [];
    } else {
      data.answer = resolved.answer;
      data.is_answered = true;
      data.sources = resolved.sources;
    }
  } else {
    data.answer = resolved.answer;
    data.is_answered = resolved.is_answered;
    data.sources = mergeAssistantSources(auth, resolved.sources, rawSources);
  }

  payload.data = data;
  return NextResponse.json(payload);
}
