import type { ChatMessage, MessageSource } from '@/lib/api';

const CACHE_KEY = 'nk_assistant_turns_v3';
const SESSION_CACHE_KEY = 'nk_session_messages_v1';

type CachedTurn = {
  answer?: string;
  is_answered?: boolean;
  sources: MessageSource[];
};

type TurnCache = Record<string, CachedTurn>;

function readCache(): TurnCache {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as TurnCache) : {};
  } catch {
    return {};
  }
}

function writeCache(cache: TurnCache) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Ignore quota errors
  }
}

export function cacheAssistantTurn(
  messageId: string | number,
  turn: { answer?: string; is_answered?: boolean; sources?: MessageSource[] }
) {
  const key = String(messageId);
  if (!key || (!turn.answer && !turn.sources?.length)) return;
  const cache = readCache();
  cache[key] = {
    answer: turn.answer,
    is_answered: turn.is_answered,
    sources: turn.sources ?? [],
  };
  writeCache(cache);
}

/** @deprecated Use cacheAssistantTurn */
export function cacheMessageSources(messageId: string | number, sources: MessageSource[]) {
  cacheAssistantTurn(messageId, { sources, is_answered: true });
}

export function getCachedAssistantTurn(messageId: string | number): CachedTurn | null {
  const key = String(messageId);
  if (!key) return null;
  const cached = readCache()[key];
  return cached && Array.isArray(cached.sources) && cached.sources.length > 0 ? cached : null;
}

function isNotFoundAnswer(answer?: string): boolean {
  return Boolean(
    answer &&
      /could not find|not found in the (available )?documents|not found in the knowledge base/i.test(answer)
  );
}

export function applyCachedTurnToMessages<
  T extends {
    id: string;
    role: string;
    answer?: string;
    is_answered?: number | boolean;
    sources?: MessageSource[];
  }
>(messages: T[]): T[] {
  return messages.map((msg) => {
    if (msg.role !== 'assistant') return msg;

    const answered = msg.is_answered === 1 || msg.is_answered === true;
    const hasServerSources = Array.isArray(msg.sources) && msg.sources.length > 0;

    // Server/BFF already resolved sources — do not override with stale local cache.
    if (answered && hasServerSources && !isNotFoundAnswer(msg.answer)) {
      return msg;
    }

    const cached = getCachedAssistantTurn(msg.id);
    if (!cached) {
      if (!answered) return { ...msg, sources: [] };
      return msg;
    }

    const cachedAnswered =
      cached.is_answered ?? (msg.is_answered === 1 || msg.is_answered === true);
    return {
      ...msg,
      answer: cached.answer ?? msg.answer,
      is_answered: cachedAnswered ? 1 : 0,
      sources: cached.sources,
    };
  });
}

/** @deprecated Use applyCachedTurnToMessages */
export function applyCachedSourcesToMessages<
  T extends { id: string; role: string; is_answered?: number | boolean; sources?: MessageSource[] }
>(messages: T[]): T[] {
  return applyCachedTurnToMessages(messages);
}

type SessionMessageCache = Record<string, ChatMessage[]>;

function readSessionCache(): SessionMessageCache {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(SESSION_CACHE_KEY);
    return raw ? (JSON.parse(raw) as SessionMessageCache) : {};
  } catch {
    return {};
  }
}

function writeSessionCache(cache: SessionMessageCache) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Ignore quota errors
  }
}

/** Cache full session thread for instant restore after refresh. */
export function cacheSessionMessages(sessionId: string | number, messages: ChatMessage[]) {
  const key = String(sessionId);
  if (!key || messages.length === 0) return;
  const cache = readSessionCache();
  cache[key] = messages;
  writeSessionCache(cache);
}

export function getCachedSessionMessages(sessionId: string | number): ChatMessage[] | null {
  const key = String(sessionId);
  if (!key) return null;
  const cached = readSessionCache()[key];
  return Array.isArray(cached) && cached.length > 0 ? cached : null;
}
