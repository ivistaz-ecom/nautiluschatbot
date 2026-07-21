import { NextRequest, NextResponse } from 'next/server';
import { resolveAssistantTurn, mergeAssistantSources } from '@/lib/chat-source-attribution';
import { API_BACKEND_URL } from '@/lib/api-config';

export const dynamic = 'force-dynamic';

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
  const categoryId =
    body?.category_id != null && Number(body.category_id) > 0
      ? Number(body.category_id)
      : undefined;
  const answer = typeof data.answer === 'string' ? data.answer : '';
  const isAnswered = Boolean(data.is_answered);
  const rawSources = Array.isArray(data.sources) ? data.sources : [];

  const resolved = await resolveAssistantTurn(
    auth,
    question,
    answer,
    isAnswered,
    rawSources,
    categoryId
  );
  data.answer = resolved.answer;
  data.is_answered = resolved.is_answered;
  data.sources = mergeAssistantSources(auth, resolved.sources, rawSources);
  payload.data = data;

  return NextResponse.json(payload);
}
