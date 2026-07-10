'use client';
import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/lib/auth';
import {
  api, ChatSession, ChatMessage, MessageSource, FAQ, Category,
  buildSourcePdfUrl, getSourceFileName, getSourcePageLabel,
} from '@/lib/api';
import { cacheMessageSources, applyCachedSourcesToMessages } from '@/lib/message-sources-cache';
import {
  Send, Plus, Trash2, Book, MessageSquare, LogOut, ChevronRight,
  Search, FileText, AlertTriangle, CheckCircle, Sparkles, X
} from 'lucide-react';
import { Logo } from '@/components/Logo';

function newMessageId(prefix = 'msg') {
  return `${prefix}-${crypto.randomUUID()}`;
}

const ACTIVE_SESSION_KEY = 'nk_active_session';

export default function ChatPage() {
  const { user, logout, loading: authLoading } = useAuth();
  const router = useRouter();

  const [sessions, setSessions]       = useState<ChatSession[]>([]);
  const [activeSession, setActive]    = useState<string | null>(null);
  const [messages, setMessages]       = useState<ChatMessage[]>([]);
  const [faqs, setFaqs]               = useState<FAQ[]>([]);
  const [categories, setCategories]   = useState<Category[]>([]);
  const [question, setQuestion]       = useState('');
  const [asking, setAsking]           = useState(false);
  const [selectedCat, setSelectedCat] = useState<number | undefined>();
  const [showFaqs, setShowFaqs]       = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const restoredSessionRef = useRef(false);

  useEffect(() => {
    if (!authLoading && !user) router.push('/login');
  }, [user, authLoading, router]);

  useEffect(() => {
    if (user) {
      loadSessions();
      loadFaqs();
      api.chat.categories().then(r => setCategories(r.data)).catch(() => {});
    }
  }, [user]);

  // Re-open the last active chat after a browser refresh.
  useEffect(() => {
    if (!user || sessions.length === 0 || activeSession || restoredSessionRef.current) return;

    const saved = localStorage.getItem(ACTIVE_SESSION_KEY);
    if (!saved || !sessions.some(s => String(s.id) === saved)) return;

    restoredSessionRef.current = true;
    openSession(saved);
  }, [user, sessions, activeSession]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function loadSessions() {
    try {
      const r = await api.chat.sessions();
      setSessions(r.data);
    } catch {}
  }

  async function loadFaqs() {
    try {
      const r = await api.chat.faqs(undefined, 10);
      setFaqs(r.data);
    } catch {}
  }

  async function openSession(id: string) {
    setActive(id);
    localStorage.setItem(ACTIVE_SESSION_KEY, id);
    try {
      const r = await api.chat.session(id);
      const messages = applyCachedSourcesToMessages(r.data.messages);
      setMessages(messages);
    } catch {}
  }

  async function newSession() {
    setActive(null);
    setMessages([]);
    localStorage.removeItem(ACTIVE_SESSION_KEY);
    restoredSessionRef.current = false;
  }

  async function deleteSession(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    await api.chat.deleteSession(id);
    if (activeSession === id) {
      setActive(null);
      setMessages([]);
      localStorage.removeItem(ACTIVE_SESSION_KEY);
      restoredSessionRef.current = false;
    }
    setSessions(prev => prev.filter(s => s.id !== id));
  }

  async function sendQuestion(q?: string) {
    const text = (q ?? question).trim();
    if (!text || asking) return;

    setQuestion('');
    setAsking(true);

    // Optimistic user message
    const tempId = newMessageId('temp');
    setMessages(prev => [...prev, {
      id: tempId, session_id: activeSession ?? '', user_id: user!.id,
      role: 'user', question: text, created_at: new Date().toISOString()
    } as ChatMessage]);

    try {
      const r = await api.chat.ask(text, activeSession ?? undefined, selectedCat);
      const { session_id, message_id, answer, sources, is_answered } = r.data;

      if (!activeSession) {
        setActive(session_id);
        localStorage.setItem(ACTIVE_SESSION_KEY, session_id);
        await loadSessions();
      }

      const enrichedSources = sources ? [...sources] : [];
      cacheMessageSources(String(message_id), enrichedSources);

      setMessages(prev => [
        ...prev.filter(m => m.id !== tempId),
        { id: newMessageId('user'), session_id, role: 'user', question: text, created_at: new Date().toISOString() } as ChatMessage,
        {
          id: String(message_id),
          session_id,
          role: 'assistant',
          answer,
          sources: enrichedSources,
          is_answered: is_answered ? 1 : 0,
          created_at: new Date().toISOString(),
        } as ChatMessage,
      ]);

      if (!is_answered) loadFaqs();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Something went wrong';
      setMessages(prev => [
        ...prev.filter(m => m.id !== tempId),
        { id: newMessageId('error'), session_id: '', role: 'assistant', answer: `Error: ${msg}`, is_answered: 0, created_at: new Date().toISOString() } as ChatMessage,
      ]);
    } finally {
      setAsking(false);
    }
  }

  if (authLoading) return (
    <div className="min-h-screen flex items-center justify-center bg-brand">
      <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
    </div>
  );

  return (
    <div className="flex h-screen bg-brand overflow-hidden">
      {/* ── Sidebar ─────────────────────────────────── */}
      <aside className={`${sidebarOpen ? 'w-72' : 'w-0'} flex-shrink-0 transition-all duration-200 overflow-hidden border-r border-white/10 bg-brand flex flex-col`}>
        {/* Brand */}
        <div className="px-4 py-4 border-b border-white/10">
          <Logo size="md" />
        </div>

        {/* New chat */}
        <div className="px-3 py-3">
          <button onClick={newSession} className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium text-white border border-white/30 rounded-lg hover:bg-white/10 transition-colors">
            <Plus className="w-4 h-4" />New conversation
          </button>
        </div>

        {/* Category filter */}
        <div className="px-3 pb-2">
          <select
            className="w-full text-xs border border-white/20 rounded-lg px-2 py-1.5 text-white/80 bg-white/5"
            value={selectedCat ?? ''}
            onChange={e => setSelectedCat(e.target.value ? Number(e.target.value) : undefined)}
          >
            <option value="" className="bg-brand text-white">All categories</option>
            {categories.map(c => <option key={c.id} value={c.id} className="bg-brand text-white">{c.name}</option>)}
          </select>
        </div>

        {/* Sessions */}
        <div className="flex-1 overflow-y-auto px-3 space-y-1">
          <p className="text-xs font-medium text-white/40 px-2 py-1 uppercase tracking-wide">Recent chats</p>
          {sessions.length === 0 && (
            <p className="text-xs text-white/40 px-2 py-4 text-center">No conversations yet</p>
          )}
          {sessions.map(s => (
            <div
              key={s.id}
              onClick={() => openSession(s.id)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer group transition-colors ${activeSession === s.id ? 'bg-white/15 text-white' : 'hover:bg-white/10 text-white/80'}`}
            >
              <MessageSquare className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="text-sm truncate flex-1">{s.title || 'New chat'}</span>
              <button onClick={e => deleteSession(s.id, e)} className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-red-400">
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>

        {/* FAQ link */}
        <div className="px-3 py-2 border-t border-white/10">
          <button onClick={() => setShowFaqs(!showFaqs)} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-white/70 hover:bg-white/10 rounded-lg">
            <Book className="w-4 h-4" />Frequently Asked
          </button>
        </div>

        {/* User */}
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

      {/* ── Main chat area ────────────────────────────── */}
      <main className="flex-1 flex flex-col overflow-hidden bg-brand">
        {/* Top bar */}
        <div className="flex items-center gap-3 px-6 py-3 border-b border-white/10">
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="p-1 text-white/50 hover:text-white">
            <ChevronRight className={`w-4 h-4 transition-transform ${sidebarOpen ? 'rotate-180' : ''}`} />
          </button>
          <h1 className="font-semibold text-white text-sm">
            {activeSession ? (sessions.find(s => s.id === activeSession)?.title ?? 'Chat') : 'New conversation'}
          </h1>
          {user?.role === 'admin' && (
            <Link href="/admin" className="ml-auto text-xs text-brand-accent hover:underline font-medium">
              Admin dashboard →
            </Link>
          )}
        </div>

        {/* FAQ panel */}
        {showFaqs && faqs.length > 0 && (
          <div className="bg-brand-light border-b border-white/10 px-6 py-3">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-white/80 uppercase tracking-wide flex items-center gap-1">
                <Sparkles className="w-3.5 h-3.5" />Frequently Asked
              </p>
              <button onClick={() => setShowFaqs(false)}><X className="w-3.5 h-3.5 text-white/70" /></button>
            </div>
            <div className="flex flex-wrap gap-2">
              {faqs.slice(0, 6).map(faq => (
                <button
                  key={faq.id}
                  onClick={() => { setShowFaqs(false); sendQuestion(faq.canonical_question); }}
                  className="text-xs bg-white/10 text-white border border-white/20 rounded-full px-3 py-1 hover:bg-white hover:text-brand transition-colors"
                >
                  {faq.canonical_question.length > 60 ? faq.canonical_question.slice(0, 57) + '…' : faq.canonical_question}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="w-14 h-14 bg-white/10 rounded-2xl flex items-center justify-center mb-4">
                <Search className="w-6 h-6 text-white/70" />
              </div>
              <h2 className="text-lg font-semibold text-white mb-2">Ask the knowledge base</h2>
              <p className="text-sm text-white/50 max-w-sm">Type a question below. I&apos;ll search through {categories.length > 0 ? categories.length + ' categories of ' : ''}company documents and give you a concise answer with references.</p>
              {faqs.length > 0 && (
                <button onClick={() => setShowFaqs(true)} className="mt-4 text-sm text-brand-accent hover:underline flex items-center gap-1">
                  <Sparkles className="w-3.5 h-3.5" />See frequently asked questions
                </button>
              )}
            </div>
          )}

          {messages.map(msg => (
            <MessageBubble key={msg.id} msg={msg} onAskQuery={() => setQuestion(msg.question ?? '')} />
          ))}

          {asking && (
            <div className="flex gap-3">
              <div className="w-8 h-8 bg-white/20 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden">
                <img src="/white-logo.webp" alt="" className="w-5 h-5 object-contain" />
              </div>
              <div className="bg-brand-light border border-white/10 rounded-2xl rounded-tl-none px-4 py-3">
                <div className="flex gap-1 items-center h-5">
                  <span className="w-2 h-2 bg-white/40 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-2 h-2 bg-white/40 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-2 h-2 bg-white/40 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="px-6 py-4 border-t border-white/10">
          <div className="flex gap-3 items-end max-w-3xl mx-auto">
            <textarea
              className="flex-1 bg-white/5 border border-white/20 rounded-xl px-4 py-3 text-sm text-white placeholder:text-white/40 resize-none focus:outline-none focus:ring-2 focus:ring-brand-accent focus:border-transparent max-h-36"
              placeholder="Ask a question about Nautilus Shipping policies, procedures, or documents…"
              rows={1}
              value={question}
              onChange={e => setQuestion(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendQuestion(); } }}
            />
            <button
              onClick={() => sendQuestion()}
              disabled={!question.trim() || asking}
              className="btn-primary p-3 rounded-xl flex-shrink-0"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
          <p className="text-xs text-white/40 text-center mt-2">Answers are sourced from approved company documents only.</p>
        </div>
      </main>
    </div>
  );
}

// ── Message bubble component ─────────────────────────────────────
function MessageBubble({ msg, onAskQuery }: { msg: ChatMessage; onAskQuery: () => void }) {
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

  return (
    <div className="flex gap-3">
      <div className="w-8 h-8 bg-white/20 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden">
        <img src="/white-logo.webp" alt="" className="w-5 h-5 object-contain" />
      </div>
      <div className="flex-1 max-w-2xl space-y-2">
        {/* Answer */}
        <div className={`rounded-2xl rounded-tl-none px-4 py-3 text-sm border ${msg.is_answered === 0 ? 'bg-amber-500/10 border-amber-500/30' : 'bg-brand-light border-white/10'}`}>
          {msg.is_answered === 0 && (
            <div className="flex items-center gap-1.5 text-amber-300 text-xs font-medium mb-2">
              <AlertTriangle className="w-3.5 h-3.5" />Not found in documents
            </div>
          )}
          <p className="text-white/90 leading-relaxed whitespace-pre-wrap">{msg.answer}</p>
        </div>

        {/* Sources — each badge deep-links to the cited PDF page */}
        {msg.sources && msg.sources.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[11px] font-medium uppercase tracking-wide text-white/40">Sources</p>
            <div className="flex flex-wrap gap-2">
              {msg.sources.map((src, i) => (
                <SourceBadge key={`${src.fileId ?? src.document_id ?? i}-${src.pageNumber ?? src.page_number ?? i}`} source={src} />
              ))}
            </div>
          </div>
        )}

        {/* Unanswered action */}
        {msg.is_answered === 0 && !submitDone && (
          <button
            onClick={async () => {
              await api.chat.submitQuery(msg.answer ?? '');
              setSubmitDone(true);
            }}
            className="text-xs text-brand-accent hover:underline flex items-center gap-1"
          >
            <MessageSquare className="w-3 h-3" />Submit to admin for manual answer
          </button>
        )}
        {submitDone && (
          <p className="text-xs text-green-400 flex items-center gap-1">
            <CheckCircle className="w-3 h-3" />Query submitted. Admin will respond soon.
          </p>
        )}

        <p className="text-xs text-white/30">{new Date(msg.created_at).toLocaleTimeString()}</p>
      </div>
    </div>
  );
}

function SourceBadge({ source }: { source: MessageSource }) {
  const fileName = getSourceFileName(source);
  const pageLabel = getSourcePageLabel(source);
  const token = typeof window !== 'undefined' ? localStorage.getItem('nk_token') : null;
  const href = token ? buildSourcePdfUrl(source, token) : undefined;

  const title = pageLabel
    ? `Open ${fileName} at ${pageLabel}`
    : `Open ${fileName}`;

  if (!href) {
    return (
      <span
        title="Please log in again to view documents"
        className="inline-flex items-center gap-1.5 bg-white/10 text-white/50 text-xs rounded-lg px-2.5 py-1.5 border border-white/20 max-w-full cursor-not-allowed"
      >
        <FileText className="w-3 h-3 flex-shrink-0" />
        <span className="font-medium truncate max-w-[200px]">{fileName}</span>
        {pageLabel != null && (
          <span className="flex-shrink-0 rounded-md bg-brand-accent/20 text-brand-accent border border-brand-accent/30 px-1.5 py-0.5 font-semibold tabular-nums">
            {pageLabel}
          </span>
        )}
      </span>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className="inline-flex items-center gap-1.5 bg-white/10 text-white/80 text-xs rounded-lg px-2.5 py-1.5 border border-white/20 hover:bg-white/20 hover:border-white/30 transition-colors cursor-pointer max-w-full"
    >
      <FileText className="w-3 h-3 flex-shrink-0" />
      <span className="font-medium truncate max-w-[200px]">{fileName}</span>
      {pageLabel != null && (
        <span className="flex-shrink-0 rounded-md bg-brand-accent/20 text-brand-accent border border-brand-accent/30 px-1.5 py-0.5 font-semibold tabular-nums">
          {pageLabel}
        </span>
      )}
    </a>
  );
}
