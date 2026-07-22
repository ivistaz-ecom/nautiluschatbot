import { NextRequest, NextResponse } from 'next/server';
import { resolveAssistantTurn, mergeAssistantSources } from '@/lib/chat-source-attribution';
import { API_BACKEND_URL } from '@/lib/api-config';
import {
  buildSuggestionBundle,
  fetchSuggestionInputs,
} from '@/lib/query-suggestions';
import { getDocumentOverrides } from '@/lib/document-overrides-store';
import { documentIdsForCategories } from '@/lib/effective-document-categories';

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

function sourceDocumentId(src: unknown): number {
  if (!src || typeof src !== 'object') return 0;
  const row = src as Record<string, unknown>;
  return Number(row.document_id ?? row.fileId ?? 0);
}

function extractTopicHints(sources: unknown[]): string[] {
  const hints: string[] = [];
  for (const raw of sources) {
    if (!raw || typeof raw !== 'object') continue;
    const src = raw as Record<string, unknown>;
    const excerpt = String(src.excerpt ?? src.snippet ?? '').trim();
    if (excerpt) {
      const firstLine = excerpt.split('\n').map((l) => l.trim()).find((l) => l.length >= 8);
      if (firstLine) hints.push(firstLine.slice(0, 90));
    }
    const title = String(src.fileName ?? src.document_title ?? '').trim();
    if (title) hints.push(title.replace(/\.pdf$/i, ''));
  }
  return hints;
}

async function fetchReadyDocs(auth: string): Promise<Array<{ id?: number; category_id?: number }>> {
  try {
    const res = await fetch(`${API_BACKEND_URL.replace(/\/$/, '')}/chat/documents?status=ready`, {
      headers: auth ? { Authorization: auth } : {},
      cache: 'no-store',
    });
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json?.data) ? json.data : [];
  } catch {
    return [];
  }
}

/**
 * Proxies POST /chat/ask to the PHP API, then recovers missed answers
 * and attaches exact PDF page citations + query suggestions when weak.
 */
export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') || '';
  const body = (await req.json()) as Record<string, unknown>;
  const categoryIds = parseCategoryIds(body ?? {});

  // Pending local category reassignments → include those document IDs in retrieval.
  const askBody: Record<string, unknown> = { ...body };
  let allowedDocumentIds: number[] | undefined;
  if (categoryIds?.length) {
    const docs = await fetchReadyDocs(auth);
    const overrides = getDocumentOverrides();
    allowedDocumentIds = documentIdsForCategories(categoryIds, docs, overrides);
    if (allowedDocumentIds.length > 0) {
      askBody.document_ids = allowedDocumentIds;
    }
  }

  const upstream = await fetch(`${API_BACKEND_URL}/chat/ask`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: auth } : {}),
    },
    body: JSON.stringify(askBody),
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
    let sources = Array.isArray(resolved.sources) ? resolved.sources : [];
    if (allowedDocumentIds && allowedDocumentIds.length > 0) {
      const allow = new Set(allowedDocumentIds);
      sources = sources.filter((s) => {
        const id = sourceDocumentId(s);
        if (id && allow.has(id)) return true;
        const cat = Number(
          (s as { category_id?: number; categoryId?: number }).category_id ??
            (s as { categoryId?: number }).categoryId ??
            0
        );
        return cat > 0 && categoryIds.includes(cat);
      });
    }
    const scopedOk = Boolean(resolved.is_answered) && sources.length > 0;
    if (!scopedOk) {
      data.answer = notFoundInSelectedCategoriesMessage(categoryIds);
      data.is_answered = false;
      data.sources = [];
    } else {
      data.answer = resolved.answer;
      data.is_answered = true;
      data.sources = sources;
    }
  } else {
    data.answer = resolved.answer;
    data.is_answered = resolved.is_answered;
    data.sources = mergeAssistantSources(auth, resolved.sources, rawSources);
  }

  // Suggest alternatives when the query didn't closely match (or not found).
  const needsSuggestions =
    !data.is_answered ||
    (Array.isArray(data.sources) && data.sources.length === 0) ||
    /could not find|not found/i.test(String(data.answer || ''));

  if (needsSuggestions && question.trim().length >= 3) {
    const upstreamSuggestions = Array.isArray(data.suggestions)
      ? data.suggestions.map((s: unknown) => String(s)).filter(Boolean)
      : [];
    const inputs = await fetchSuggestionInputs(auth, API_BACKEND_URL, categoryIds);
    const topicHints = [
      ...upstreamSuggestions,
      ...extractTopicHints(Array.isArray(data.sources) ? data.sources : []),
      ...extractTopicHints(rawSources),
    ];
    const bundle = buildSuggestionBundle(question, {
      faqs: inputs.faqs,
      documentTitles: inputs.documentTitles,
      topicHints,
      limit: 4,
    });

    data.did_you_mean = bundle.did_you_mean || null;
    data.looking_for = bundle.looking_for;
    data.suggestions = [
      ...(bundle.did_you_mean ? [bundle.did_you_mean] : []),
      ...bundle.looking_for,
    ].slice(0, 5);
  } else {
    data.did_you_mean = null;
    data.looking_for = [];
    data.suggestions = [];
  }

  payload.data = data;
  return NextResponse.json(payload);
}
