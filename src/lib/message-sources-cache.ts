import type { MessageSource } from '@/lib/api';

const CACHE_KEY = 'nk_message_sources';

type SourceCache = Record<string, MessageSource[]>;

function readCache(): SourceCache {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as SourceCache) : {};
  } catch {
    return {};
  }
}

function writeCache(cache: SourceCache) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Ignore quota errors
  }
}

export function cacheMessageSources(messageId: string | number, sources: MessageSource[]) {
  const key = String(messageId);
  if (!key || sources.length === 0) return;
  const cache = readCache();
  cache[key] = sources;
  writeCache(cache);
}

export function getCachedMessageSources(messageId: string | number): MessageSource[] | null {
  const key = String(messageId);
  if (!key) return null;
  const cached = readCache()[key];
  return Array.isArray(cached) && cached.length > 0 ? cached : null;
}

export function applyCachedSourcesToMessages<T extends { id: string; role: string; sources?: MessageSource[] }>(
  messages: T[]
): T[] {
  return messages.map((msg) => {
    if (msg.role !== 'assistant') return msg;
    if (Array.isArray(msg.sources) && msg.sources.length > 0) return msg;
    const cached = getCachedMessageSources(msg.id);
    if (!cached) return msg;
    return { ...msg, sources: cached };
  });
}
