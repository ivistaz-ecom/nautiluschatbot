import { NextRequest, NextResponse } from 'next/server';
import { enrichAnswerSources, type SourceLike } from '@/lib/chat-source-attribution';
import { API_BACKEND_URL } from '@/lib/api-config';

/**
 * Proxies POST /chat/ask to the PHP API, then enriches PDF source cards
 * with correct page numbers and deep-link URLs.
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

  const answered = Boolean(data.is_answered);
  const answer = typeof data.answer === 'string' ? data.answer : '';
  const question = typeof body?.question === 'string' ? body.question : '';
  const rawSources: SourceLike[] = Array.isArray(data.sources) ? data.sources : [];

  if (answered && answer) {
    data.sources = await enrichAnswerSources(auth, question, answer, rawSources);
    payload.data = data;
  }

  return NextResponse.json(payload);
}
