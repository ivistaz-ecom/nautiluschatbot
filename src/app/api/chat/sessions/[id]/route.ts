import { NextRequest, NextResponse } from 'next/server';
import { enrichAnswerSources, type SourceLike } from '@/lib/chat-source-attribution';
import { API_BACKEND_URL } from '@/lib/api-config';

type SessionMessage = {
  role?: string;
  question?: string;
  answer?: string;
  is_answered?: number | boolean;
  sources?: SourceLike[] | string | null;
};

function parseSources(raw: SessionMessage['sources']): SourceLike[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Proxies GET /chat/sessions/:id and re-enriches assistant message sources
 * so PDF cards + page numbers survive a browser refresh.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = req.headers.get('authorization') || '';
  const sessionId = params.id;

  const upstream = await fetch(`${API_BACKEND_URL}/chat/sessions/${sessionId}`, {
    headers: {
      ...(auth ? { Authorization: auth } : {}),
    },
  });

  const payload = await upstream.json();

  if (!upstream.ok) {
    return NextResponse.json(payload, { status: upstream.status });
  }

  const data = payload?.data;
  if (!data || typeof data !== 'object' || !Array.isArray(data.messages)) {
    return NextResponse.json(payload);
  }

  let lastQuestion = '';

  for (const msg of data.messages as SessionMessage[]) {
    if (msg.role === 'user') {
      lastQuestion = typeof msg.question === 'string' ? msg.question : '';
      continue;
    }

    if (msg.role !== 'assistant') continue;

    const answered = msg.is_answered === 1 || msg.is_answered === true;
    const answer = typeof msg.answer === 'string' ? msg.answer : '';
    if (!answered || !answer) {
      msg.sources = [];
      continue;
    }

    const rawSources = parseSources(msg.sources);
    msg.sources = await enrichAnswerSources(auth, lastQuestion, answer, rawSources);
  }

  payload.data = data;
  return NextResponse.json(payload);
}
