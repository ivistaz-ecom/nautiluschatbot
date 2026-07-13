import { NextRequest, NextResponse } from 'next/server';
import { resolveSessionMessage, type SourceLike } from '@/lib/chat-source-attribution';
import { API_BACKEND_URL } from '@/lib/api-config';

export const dynamic = 'force-dynamic';

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
 * Proxies GET /chat/sessions/:id — fast reload from DB; PDF scan only when needed.
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
    cache: 'no-store',
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
    const rawSources = parseSources(msg.sources);

    const resolved = await resolveSessionMessage(auth, lastQuestion, answer, answered, rawSources);
    msg.answer = resolved.answer;
    msg.is_answered = resolved.is_answered ? 1 : 0;
    msg.sources = resolved.sources;
  }

  payload.data = data;
  return NextResponse.json(payload);
}
