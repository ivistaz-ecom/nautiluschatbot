'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/lib/auth';
import {
  api, ChatSession, ChatMessage, MessageSource, FAQ, Category,
  buildSourcePdfUrl, getSourceFileName, getSourcePageLabel,
} from '@/lib/api';
import {
  cacheAssistantTurn,
  applyCachedTurnToMessages,
  cacheSessionMessages,
  getCachedSessionMessages,
} from '@/lib/message-sources-cache';
import {
  Send, Plus, Trash2, Book, MessageSquare, LogOut, ChevronRight,
  Search, FileText, AlertTriangle, CheckCircle, Sparkles, X,
} from 'lucide-react';
import { Logo } from '@/components/Logo';

function newMessageId(prefix = 'msg') {
  return `${prefix}-${crypto.randomUUID()}`;
}

/** Chip label — full name when short; acronym when long. */
function categoryChipLabel(cat: Category): string {
  const name = cat.name.trim();
  if (name.length <= 18) return name;
  return categoryShortLabel(cat);
}

/** Short chip label — prefers slug acronyms (SOM, HSEM), else initials. */
function categoryShortLabel(cat: Category): string {
  const slug = (cat.slug || '').trim();
  if (slug) {
    const compact = slug.replace(/[^a-z0-9]/gi, '');
    if (compact.length >= 2 && compact.length <= 6) return compact.toUpperCase();
    const fromParts = slug
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((p) => p[0])
      .join('')
      .toUpperCase();
    if (fromParts.length >= 2) return fromParts.slice(0, 5);
  }
  const words = cat.name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return words
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 5);
  }
  return (words[0] || cat.name).slice(0, 8);
}

const CATEGORY_PILL_TONES = [
  { idle: 'border-sky-400/50 text-sky-300', active: 'bg-sky-400/20 border-sky-300 text-sky-100' },
  { idle: 'border-emerald-400/50 text-emerald-300', active: 'bg-emerald-400/20 border-emerald-300 text-emerald-100' },
  { idle: 'border-violet-400/50 text-violet-300', active: 'bg-violet-400/20 border-violet-300 text-violet-100' },
  { idle: 'border-orange-400/50 text-orange-300', active: 'bg-orange-400/20 border-orange-300 text-orange-100' },
  { idle: 'border-amber-400/50 text-amber-300', active: 'bg-amber-400/20 border-amber-300 text-amber-100' },
  { idle: 'border-teal-400/50 text-teal-300', active: 'bg-teal-400/20 border-teal-300 text-teal-100' },
  { idle: 'border-fuchsia-400/50 text-fuchsia-300', active: 'bg-fuchsia-400/20 border-fuchsia-300 text-fuchsia-100' },
  { idle: 'border-blue-400/50 text-blue-300', active: 'bg-blue-400/20 border-blue-300 text-blue-100' },
] as const;

const ASK_STATUS_STEPS = [
  'Searching manuals…',
  'Finding relevant pages…',
  'Preparing your answer…',
] as const;

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** ChatGPT-style reveal: stream words so the wait feels shorter after the API returns. */
async function streamAnswerText(
  full: string,
  onChunk: (partial: string) => void,
  isCancelled?: () => boolean
): Promise<void> {
  if (!full) {
    onChunk('');
    return;
  }
  if (full.length < 48) {
    onChunk(full);
    return;
  }

  const tokens = full.split(/(\s+)/);
  const wordCount = tokens.filter((t) => t.trim()).length || 1;
  const targetMs = Math.min(3200, Math.max(900, full.length * 7));
  const delay = Math.max(10, Math.floor(targetMs / wordCount));

  let out = '';
  for (const token of tokens) {
    if (isCancelled?.()) {
      onChunk(full);
      return;
    }
    out += token;
    onChunk(out);
    if (token.trim()) await sleep(delay);
  }
  onChunk(full);
}

export function normalizeSessionId(id: string | number | null | undefined): string {
  return id == null ? '' : String(id);
}

type ChatWorkspaceProps = {
  /** Session id from URL (`/chat/[id]`). Null/undefined = new chat at `/chat`. */
  sessionId?: string | null;
};

export function ChatWorkspace({ sessionId = null }: ChatWorkspaceProps) {
  const { user, logout, loading: authLoading } = useAuth();
  const router = useRouter();

  const activeSession = sessionId ? normalizeSessionId(sessionId) : null;

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [faqs, setFaqs] = useState<FAQ[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(true);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [askStatus, setAskStatus] = useState<string>(ASK_STATUS_STEPS[0]);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [loadingSession, setLoadingSession] = useState(Boolean(activeSession));
  const [selectedCats, setSelectedCats] = useState<number[]>([]);
  const [showFaqs, setShowFaqs] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sessionSearch, setSessionSearch] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const sessionLoadGen = useRef(0);

  const filteredSessions = useMemo(() => {
    const q = sessionSearch.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => (s.title || 'New chat').toLowerCase().includes(q));
  }, [sessions, sessionSearch]);

  // Categories near the ask box: only those that currently have ready PDFs.
  const categoriesWithPdfs = useMemo(() => {
    const hasCounts = categories.some((c) => c.doc_count != null);
    if (hasCounts) return categories.filter((c) => Number(c.doc_count) > 0);
    return categories;
  }, [categories]);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/login');
  }, [user, authLoading, router]);

  // Rotate status copy while the API is working (before answer streaming starts).
  useEffect(() => {
    if (!asking || streamingId) return;
    let step = 0;
    setAskStatus(ASK_STATUS_STEPS[0]);
    const timer = setInterval(() => {
      step = Math.min(step + 1, ASK_STATUS_STEPS.length - 1);
      setAskStatus(ASK_STATUS_STEPS[step]);
    }, 2400);
    return () => clearInterval(timer);
  }, [asking, streamingId]);

  useEffect(() => {
    if (!user) return;
    loadSessions();
    void loadCategoriesWithPdfs();
  }, [user]);

  async function loadCategoriesWithPdfs() {
    setCategoriesLoading(true);
    try {
      const r = await api.chat.categories();
      const rows = Array.isArray(r.data) ? r.data : [];
      setCategories(rows);
    } catch {
      setCategories([]);
    } finally {
      setCategoriesLoading(false);
    }
  }

  // Drop selections if those categories no longer have PDFs.
  useEffect(() => {
    setSelectedCats((prev) => {
      if (prev.length === 0) return prev;
      const valid = new Set(categoriesWithPdfs.map((c) => c.id));
      const next = prev.filter((id) => valid.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [categoriesWithPdfs]);

  useEffect(() => {
    if (!user) return;
    // FAQ strip: only filter when exactly one manual is selected.
    loadFaqs(selectedCats.length === 1 ? selectedCats[0] : undefined);
  }, [user, selectedCats]);

  function toggleCategory(id: number) {
    setSelectedCats((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  const selectedCategoryNames = useMemo(
    () =>
      categoriesWithPdfs
        .filter((c) => selectedCats.includes(c.id))
        .map((c) => c.name),
    [categoriesWithPdfs, selectedCats]
  );

  // Load the session from the URL — show cache instantly, then refresh from API.
  useEffect(() => {
    if (!user) return;

    if (!activeSession) {
      sessionLoadGen.current += 1;
      setMessages([]);
      setLoadingSession(false);
      return;
    }

    const loadGen = ++sessionLoadGen.current;
    const cached = getCachedSessionMessages(activeSession);
    if (cached?.length) {
      setMessages(cached);
      setLoadingSession(false);
    } else {
      setMessages([]);
      setLoadingSession(true);
    }

    let cancelled = false;

    (async () => {
      try {
        const r = await api.chat.session(activeSession);
        if (cancelled || loadGen !== sessionLoadGen.current) return;
        const loaded = applyCachedTurnToMessages(r.data.messages);
        setMessages(loaded);
        cacheSessionMessages(activeSession, loaded);
      } catch {
        if (cancelled || loadGen !== sessionLoadGen.current) return;
        if (cached?.length) setMessages(cached);
      } finally {
        if (!cancelled && loadGen === sessionLoadGen.current) {
          setLoadingSession(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, activeSession]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({
      behavior: streamingId ? 'auto' : 'smooth',
    });
  }, [messages, asking, askStatus, streamingId]);

  async function loadSessions() {
    try {
      const r = await api.chat.sessions();
      setSessions(r.data);
    } catch {
      // ignore
    }
  }

  async function loadFaqs(categoryId?: number) {
    try {
      const r = await api.chat.faqs(categoryId, 10);
      setFaqs(r.data);
    } catch {
      // ignore
    }
  }

  function goToSession(id: string | number) {
    const sid = normalizeSessionId(id);
    if (!sid || sid === activeSession) return;
    router.push(`/chat/${sid}`);
  }

  function newSession() {
    if (!activeSession) {
      setMessages([]);
      return;
    }
    router.push('/chat');
  }

  async function deleteSession(id: string | number, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const sid = normalizeSessionId(id);
    await api.chat.deleteSession(sid);
    setSessions((prev) => prev.filter((s) => normalizeSessionId(s.id) !== sid));
    if (activeSession === sid) {
      router.push('/chat');
    }
  }

  async function sendQuestion(q?: string) {
    const text = (q ?? question).trim();
    if (!text || asking) return;

    setQuestion('');
    setAsking(true);
    setStreamingId(null);
    setAskStatus(ASK_STATUS_STEPS[0]);

    const tempId = newMessageId('temp');
    setMessages((prev) => [
      ...prev,
      {
        id: tempId,
        session_id: activeSession ?? '',
        user_id: user!.id,
        role: 'user',
        question: text,
        created_at: new Date().toISOString(),
      } as ChatMessage,
    ]);

    let cancelled = false;
    let assistantIdForCleanup: string | null = null;
    try {
      const r = await api.chat.ask(
        text,
        activeSession ?? undefined,
        selectedCats.length > 0 ? selectedCats : undefined
      );
      const {
        session_id,
        message_id,
        answer,
        sources,
        is_answered,
        did_you_mean,
        looking_for,
        suggestions,
      } = r.data;
      const sid = normalizeSessionId(activeSession ?? session_id);
      const isNew = !activeSession;

      const enrichedSources = Array.isArray(sources) ? [...sources] : [];
      const lookingFor = Array.isArray(looking_for)
        ? looking_for
        : Array.isArray(suggestions)
          ? suggestions
          : [];
      const fullAnswer = typeof answer === 'string' ? answer : '';
      const answeredFlag = is_answered || enrichedSources.length > 0 ? 1 : 0;
      const assistantId = String(message_id);
      assistantIdForCleanup = assistantId;

      if (is_answered || enrichedSources.length > 0) {
        cacheAssistantTurn(assistantId, {
          answer: fullAnswer,
          is_answered: Boolean(is_answered) || enrichedSources.length > 0,
          sources: enrichedSources,
        });
      }

      // Insert assistant shell, then stream the text (ChatGPT-style).
      setAskStatus('Writing your answer…');
      setStreamingId(assistantId);
      setMessages((prev) => {
        const withoutTemp = prev.filter((m) => m.id !== tempId);
        return [
          ...withoutTemp,
          {
            id: newMessageId('user'),
            session_id: sid,
            role: 'user',
            question: text,
            created_at: new Date().toISOString(),
          } as ChatMessage,
          {
            id: assistantId,
            session_id: sid,
            role: 'assistant',
            answer: '',
            sources: [],
            is_answered: answeredFlag,
            did_you_mean: null,
            looking_for: [],
            suggestions: [],
            created_at: new Date().toISOString(),
          } as ChatMessage,
        ];
      });

      await streamAnswerText(
        fullAnswer,
        (partial) => {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, answer: partial } : m))
          );
        },
        () => cancelled
      );

      setMessages((prev) => {
        const updated = prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                answer: fullAnswer,
                sources: enrichedSources,
                is_answered: answeredFlag,
                did_you_mean: did_you_mean || null,
                looking_for: lookingFor,
                suggestions: lookingFor,
              }
            : m
        );
        cacheSessionMessages(sid, updated);
        return updated;
      });

      if (isNew) {
        await loadSessions();
        router.replace(`/chat/${sid}`);
      } else {
        void loadSessions();
      }

      if (!is_answered) loadFaqs(selectedCats.length === 1 ? selectedCats[0] : undefined);
    } catch (err: unknown) {
      cancelled = true;
      const msg = err instanceof Error ? err.message : 'Something went wrong';
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== tempId && m.id !== assistantIdForCleanup),
        {
          id: newMessageId('error'),
          session_id: '',
          role: 'assistant',
          answer: `Error: ${msg}`,
          is_answered: 0,
          created_at: new Date().toISOString(),
        } as ChatMessage,
      ]);
    } finally {
      setStreamingId(null);
      setAsking(false);
    }
  }

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-brand">
        <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const title = activeSession
    ? sessions.find((s) => normalizeSessionId(s.id) === activeSession)?.title ?? 'Chat'
    : 'New conversation';

  return (
    <div className="flex h-screen bg-brand overflow-hidden">
      <aside
        className={`${sidebarOpen ? 'w-72' : 'w-0'} flex-shrink-0 transition-all duration-200 overflow-hidden border-r border-white/10 bg-brand flex flex-col`}
      >
        <div className="px-4 py-4 border-b border-white/10">
          <Logo size="md" />
        </div>

        <div className="px-3 py-3 space-y-2">
          <button
            onClick={newSession}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium text-white border border-white/30 rounded-lg hover:bg-white/10 transition-colors"
          >
            <Plus className="w-4 h-4" />
            New conversation
          </button>

          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-white/40" />
            <input
              className="w-full text-xs border border-white/20 rounded-lg pl-8 pr-2 py-2 text-white/80 bg-white/5 placeholder:text-white/35 focus:outline-none focus:ring-1 focus:ring-brand-accent"
              placeholder="Search chats…"
              value={sessionSearch}
              onChange={(e) => setSessionSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-3 space-y-1">
          <p className="text-xs font-medium text-white/40 px-2 py-1 uppercase tracking-wide">
            Recent chats
          </p>
          {filteredSessions.length === 0 && (
            <p className="text-xs text-white/40 px-2 py-4 text-center">
              {sessionSearch.trim() ? 'No matching chats' : 'No conversations yet'}
            </p>
          )}
          {filteredSessions.map((s) => {
            const sid = normalizeSessionId(s.id);
            return (
              <div
                key={sid}
                onClick={() => goToSession(sid)}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer group transition-colors ${
                  activeSession === sid
                    ? 'bg-white/15 text-white'
                    : 'hover:bg-white/10 text-white/80'
                }`}
              >
                <MessageSquare className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="text-sm truncate flex-1">{s.title || 'New chat'}</span>
                <button
                  onClick={(e) => deleteSession(sid, e)}
                  className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-red-400"
                  title="Delete chat"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>

        <div className="px-3 py-2 border-t border-white/10">
          <button
            onClick={() => setShowFaqs(!showFaqs)}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-white/70 hover:bg-white/10 rounded-lg"
          >
            <Book className="w-4 h-4" />
            Frequently Asked
          </button>
        </div>

        <div className="px-3 py-3 border-t border-white/10 flex items-center gap-2">
          <div className="w-8 h-8 bg-white/20 rounded-full flex items-center justify-center text-white text-xs font-bold">
            {user?.name?.[0]?.toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white truncate">{user?.name}</p>
            <p className="text-xs text-white/50 truncate">{user?.email}</p>
          </div>
          <button onClick={logout} className="p-1 text-white/50 hover:text-red-400">
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </aside>

      <main className="flex-1 flex flex-col overflow-hidden bg-brand">
        <div className="flex items-center gap-3 px-6 py-3 border-b border-white/10">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-1 text-white/50 hover:text-white"
          >
            <ChevronRight
              className={`w-4 h-4 transition-transform ${sidebarOpen ? 'rotate-180' : ''}`}
            />
          </button>
          <h1 className="font-semibold text-white text-sm truncate">{title}</h1>
          {user?.role === 'admin' && (
            <Link
              href="/admin"
              className="ml-auto text-xs text-brand-accent hover:underline font-medium flex-shrink-0"
            >
              Admin dashboard →
            </Link>
          )}
        </div>

        {showFaqs && faqs.length > 0 && (
          <div className="bg-brand-light border-b border-white/10 px-6 py-3">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-white/80 uppercase tracking-wide flex items-center gap-1">
                <Sparkles className="w-3.5 h-3.5" />
                Frequently Asked
              </p>
              <button onClick={() => setShowFaqs(false)}>
                <X className="w-3.5 h-3.5 text-white/70" />
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {faqs.slice(0, 6).map((faq) => (
                <button
                  key={faq.id}
                  onClick={() => {
                    setShowFaqs(false);
                    sendQuestion(faq.canonical_question);
                  }}
                  className="text-xs bg-white/10 text-white border border-white/20 rounded-full px-3 py-1 hover:bg-white hover:text-brand transition-colors"
                >
                  {faq.canonical_question.length > 60
                    ? `${faq.canonical_question.slice(0, 57)}…`
                    : faq.canonical_question}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
          {loadingSession && messages.length === 0 && <SessionSkeleton />}

          {!loadingSession && messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="w-14 h-14 bg-white/10 rounded-2xl flex items-center justify-center mb-4">
                <Search className="w-6 h-6 text-white/70" />
              </div>
              <h2 className="text-lg font-semibold text-white mb-2">Ask the knowledge base</h2>
              <p className="text-sm text-white/50 max-w-sm">
                Type a question below. I&apos;ll search through
                {categoriesWithPdfs.length > 0
                  ? ` ${categoriesWithPdfs.length} categories of `
                  : ' '}
                company documents and give you a concise answer with references.
                {selectedCategoryNames.length > 0
                  ? ` Currently filtered to ${selectedCategoryNames.join(', ')}.`
                  : ''}
              </p>
              {faqs.length > 0 && (
                <button
                  onClick={() => setShowFaqs(true)}
                  className="mt-4 text-sm text-brand-accent hover:underline flex items-center gap-1"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  See frequently asked questions
                </button>
              )}
            </div>
          )}

          {messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              msg={msg}
              isStreaming={streamingId === msg.id}
              onSuggest={(q) => sendQuestion(q)}
              suggestingDisabled={asking}
            />
          ))}

          {asking && !streamingId && !loadingSession && (
            <div className="flex gap-3">
              <div className="w-8 h-8 bg-white/20 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden">
                <img src="/white-logo.webp" alt="" className="w-5 h-5 object-contain" />
              </div>
              <div className="bg-brand-light border border-white/10 rounded-2xl rounded-tl-none px-4 py-3 min-w-[12rem]">
                <div className="flex items-center gap-2.5">
                  <div className="flex gap-1 items-center h-4">
                    <span
                      className="w-1.5 h-1.5 bg-brand-accent/80 rounded-full animate-bounce"
                      style={{ animationDelay: '0ms' }}
                    />
                    <span
                      className="w-1.5 h-1.5 bg-brand-accent/80 rounded-full animate-bounce"
                      style={{ animationDelay: '150ms' }}
                    />
                    <span
                      className="w-1.5 h-1.5 bg-brand-accent/80 rounded-full animate-bounce"
                      style={{ animationDelay: '300ms' }}
                    />
                  </div>
                  <p className="text-sm text-white/70 transition-opacity duration-300">
                    {askStatus}
                  </p>
                </div>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        <div className="px-6 py-4 border-t border-white/10">
          <div className="flex flex-col gap-3 max-w-3xl mx-auto">
            {(categoriesLoading || categoriesWithPdfs.length > 0) && (
              <div className="space-y-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/40">
                Categories
                </p>
                <div
                  className="flex flex-wrap gap-2"
                  role="group"
                  aria-label="Filter by category (multi-select)"
                >
                  {categoriesLoading &&
                    [0, 1, 2, 3].map((i) => (
                      <span
                        key={i}
                        className="h-8 w-16 rounded-full bg-white/10 animate-pulse"
                        aria-hidden
                      />
                    ))}
                  {!categoriesLoading &&
                    categoriesWithPdfs.map((c, i) => {
                      const active = selectedCats.includes(c.id);
                      const tone = CATEGORY_PILL_TONES[i % CATEGORY_PILL_TONES.length];
                      const short = categoryChipLabel(c);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          aria-pressed={active}
                          title={
                            c.doc_count != null
                              ? `${c.name} · ${c.doc_count} PDF${c.doc_count === 1 ? '' : 's'}`
                              : c.name
                          }
                          onClick={() => toggleCategory(c.id)}
                          className={`rounded-full border px-3 py-1.5 text-xs font-semibold tracking-wide transition-colors ${
                            active
                              ? tone.active
                              : `${tone.idle} opacity-45 hover:opacity-80`
                          }`}
                        >
                          {short}
                        </button>
                      );
                    })}
                </div>
              </div>
            )}
            <div className="flex gap-3 items-end">
              <textarea
                className="flex-1 bg-white/5 border border-white/20 rounded-xl px-4 py-3 text-sm text-white placeholder:text-white/40 resize-none focus:outline-none focus:ring-2 focus:ring-brand-accent focus:border-transparent max-h-36"
                placeholder={
                  selectedCategoryNames.length > 0
                    ? `Ask about ${selectedCategoryNames.join(', ')}…`
                    : 'e.g. enclosed space entry, hot work permit, bunkering, mooring…'
                }
                rows={1}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendQuestion();
                  }
                }}
              />
              <button
                onClick={() => sendQuestion()}
                disabled={!question.trim() || asking}
                className="btn-primary p-3 rounded-xl flex-shrink-0"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>
          <p className="text-xs text-white/40 text-center mt-2">
            {selectedCategoryNames.length > 0
              ? `Searching ${selectedCategoryNames.join(', ')} manuals only.`
              : 'Answers are sourced from approved company documents only.'}
          </p>
        </div>
      </main>
    </div>
  );
}

function SessionSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      {[0, 1].map((pair) => (
        <div key={pair} className="space-y-4">
          <div className="flex justify-end">
            <div className="h-10 w-2/5 max-w-sm rounded-2xl rounded-tr-none bg-white/10" />
          </div>
          <div className="flex gap-3">
            <div className="w-8 h-8 rounded-full bg-white/10 flex-shrink-0" />
            <div className="flex-1 max-w-2xl space-y-2">
              <div className="h-24 rounded-2xl rounded-tl-none bg-white/10" />
              <div className="h-8 w-48 rounded-lg bg-white/10" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function MessageBubble({
  msg,
  isStreaming = false,
  onSuggest,
  suggestingDisabled = false,
}: {
  msg: ChatMessage;
  isStreaming?: boolean;
  onSuggest?: (question: string) => void;
  suggestingDisabled?: boolean;
}) {
  const [submitDone, setSubmitDone] = useState(false);

  if (msg.role === 'user') {
    return (
      <div className="flex justify-end gap-3">
        <div className="bg-white text-brand rounded-2xl rounded-tr-none px-4 py-3 max-w-2xl text-sm">
          {msg.question}
        </div>
      </div>
    );
  }

  const didYouMean = msg.did_you_mean?.trim() || null;
  const lookingFor = (msg.looking_for?.length ? msg.looking_for : msg.suggestions || [])
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => s.toLowerCase() !== (didYouMean || '').toLowerCase())
    .slice(0, 4);
  const showSuggestions = Boolean(didYouMean || lookingFor.length > 0) && !isStreaming;

  return (
    <div className="flex gap-3">
      <div className="w-8 h-8 bg-white/20 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden">
        <img src="/white-logo.webp" alt="" className="w-5 h-5 object-contain" />
      </div>
      <div className="flex-1 max-w-2xl space-y-2">
        <div
          className={`rounded-2xl rounded-tl-none px-4 py-3 text-sm border ${
            msg.is_answered === 0 && !isStreaming
              ? 'bg-amber-500/10 border-amber-500/30'
              : 'bg-brand-light border-white/10'
          }`}
        >
          {msg.is_answered === 0 && !isStreaming && (
            <div className="flex items-center gap-1.5 text-amber-300 text-xs font-medium mb-2">
              <AlertTriangle className="w-3.5 h-3.5" />
              {/selected categor/i.test(msg.answer || '')
                ? 'Not found in selected category'
                : 'Not found in documents'}
            </div>
          )}
          <p className="text-white/90 leading-relaxed whitespace-pre-wrap">
            {msg.answer}
            {isStreaming && (
              <span
                className="inline-block w-1.5 h-4 ml-0.5 align-text-bottom bg-brand-accent/90 animate-pulse"
                aria-hidden
              />
            )}
          </p>
        </div>

        {showSuggestions && onSuggest && (
          <div className="rounded-xl border border-white/15 bg-white/5 px-3 py-2.5 space-y-2">
            {didYouMean && (
              <div className="space-y-1.5">
                <p className="text-[11px] font-medium uppercase tracking-wide text-white/45">
                  Did you mean
                </p>
                <button
                  type="button"
                  disabled={suggestingDisabled}
                  onClick={() => onSuggest(didYouMean)}
                  className="text-left text-sm text-brand-accent hover:underline disabled:opacity-50"
                >
                  {didYouMean}
                </button>
              </div>
            )}
            {lookingFor.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[11px] font-medium uppercase tracking-wide text-white/45">
                  Are you looking for
                </p>
                <div className="flex flex-wrap gap-2">
                  {lookingFor.map((s) => (
                    <button
                      key={s}
                      type="button"
                      disabled={suggestingDisabled}
                      onClick={() => onSuggest(s)}
                      className="rounded-full border border-white/20 bg-white/5 px-3 py-1 text-xs text-white/85 hover:bg-white/15 hover:border-white/35 transition-colors disabled:opacity-50"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {!isStreaming && msg.sources && msg.sources.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[11px] font-medium uppercase tracking-wide text-white/40">
              Sources
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {msg.sources.map((src, i) => (
                <SourceBadge
                  key={`${src.fileId ?? src.document_id ?? i}-${src.pageNumber ?? src.page_number ?? i}`}
                  source={src}
                />
              ))}
            </div>
          </div>
        )}

        {!isStreaming && msg.is_answered === 0 && !submitDone && (
          <button
            onClick={async () => {
              await api.chat.submitQuery(msg.question ?? msg.answer ?? '');
              setSubmitDone(true);
            }}
            className="text-xs text-brand-accent hover:underline flex items-center gap-1"
          >
            <MessageSquare className="w-3 h-3" />
            Submit to admin for manual answer
          </button>
        )}
        {submitDone && (
          <p className="text-xs text-green-400 flex items-center gap-1">
            <CheckCircle className="w-3 h-3" />
            Query submitted. Admin will respond soon.
          </p>
        )}

        {!isStreaming && (
          <p className="text-xs text-white/30">
            {new Date(msg.created_at).toLocaleTimeString()}
          </p>
        )}
      </div>
    </div>
  );
}

function SourceBadge({ source }: { source: MessageSource }) {
  const fileName = getSourceFileName(source);
  const pageLabel = getSourcePageLabel(source);
  const categoryName = source.category_name?.trim() || null;
  const token = typeof window !== 'undefined' ? localStorage.getItem('nk_token') : null;
  const href = token ? buildSourcePdfUrl(source, token) : undefined;
  const openLabel = pageLabel ? `Open PDF — ${pageLabel}` : 'Open PDF';
  const titleParts = [fileName];
  if (categoryName) titleParts.push(`Category: ${categoryName}`);
  if (pageLabel) titleParts.push(pageLabel);
  const title = titleParts.join(' · ');

  const content = (
    <>
      <FileText className="w-3.5 h-3.5 flex-shrink-0 text-white/70" />
      <span className="min-w-0 flex-1 flex flex-col gap-0.5">
        <span className="font-medium truncate">{fileName}</span>
        {categoryName && (
          <span className="truncate text-[10px] text-white/45 font-normal normal-case tracking-normal">
            {categoryName}
          </span>
        )}
      </span>
      <span className="flex-shrink-0 rounded-md bg-brand-accent/20 text-brand-accent border border-brand-accent/30 px-1.5 py-0.5 font-semibold tabular-nums whitespace-nowrap">
        {openLabel}
      </span>
    </>
  );

  if (!href) {
    return (
      <span
        title="Please log in again to view documents"
        className="flex w-full min-w-0 items-center gap-2 bg-white/10 text-white/50 text-xs rounded-lg px-2.5 py-2 border border-white/20 cursor-not-allowed"
      >
        {content}
      </span>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className="flex w-full min-w-0 items-center gap-2 bg-white/10 text-white/80 text-xs rounded-lg px-2.5 py-2 border border-white/20 hover:bg-white/20 hover:border-white/30 transition-colors cursor-pointer"
    >
      {content}
    </a>
  );
}
