// src/lib/api.ts

import { API_URL, DOCUMENT_API_URL } from './api-config';

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('nk_token');
}

async function request<T>(
  method: string,
  path: string,
  body?: Record<string, unknown> | FormData,
  isFormData = false
): Promise<T> {
  const token = getToken();

  const headers: HeadersInit = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!isFormData) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body
      ? isFormData
        ? (body as FormData)
        : JSON.stringify(body)
      : undefined,
  });

  let data: Record<string, unknown> = {};
  const raw = await res.text();
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new ApiError(
      res.ok ? 'Invalid server response' : `Request failed (${res.status})`,
      res.status
    );
  }

  if (!res.ok) {
    const message = typeof data.message === 'string' ? data.message : 'Request failed';
    throw new ApiError(message, res.status, data.errors as Record<string, string[]> | undefined);
  }

  return data as T;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public errors?: Record<string, string[]>
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Ask via the Next.js BFF so we can recover PDF source cards when the remote
 * PHP API returns an empty sources array for an otherwise successful answer.
 */
async function requestLocalAsk(
  question: string,
  sessionId?: string,
  categoryId?: number
): Promise<{ data: AskResponse }> {
  const token = getToken();
  const headers: HeadersInit = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch('/api/chat/ask', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      question,
      ...(sessionId && { session_id: sessionId }),
      ...(categoryId && { category_id: categoryId }),
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new ApiError(data.message || 'Request failed', res.status, data.errors);
  }
  return data;
}

async function requestLocalSession(id: string): Promise<{ data: { session: ChatSession; messages: ChatMessage[] } }> {
  const token = getToken();
  const headers: HeadersInit = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`/api/chat/sessions/${id}`, { headers });
  const data = await res.json();
  if (!res.ok) {
    throw new ApiError(data.message || 'Request failed', res.status, data.errors);
  }
  return data;
}

async function requestLocalDocumentUpload<T>(formData: FormData): Promise<T> {
  const token = getToken();
  const headers: HeadersInit = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch('/api/admin/documents/upload', {
    method: 'POST',
    headers,
    body: formData,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new ApiError(data.message || 'Upload failed', res.status, data.errors);
  }
  return data as T;
}

async function requestLocalDocumentReparse(id: number, formData?: FormData): Promise<{ message?: string; data?: { status?: string; error?: string } }> {
  const token = getToken();
  const headers: HeadersInit = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`/api/admin/documents/${id}/reparse`, {
    method: 'POST',
    headers,
    body: formData,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new ApiError(data.message || 'Re-parse failed', res.status, data.errors);
  }
  return data;
}

async function requestLocalDocumentUpdate<T>(
  id: number,
  data: {
    title: string;
    category_id: number;
    original_filename?: string;
    category_name?: string;
  }
): Promise<T> {
  const token = getToken();
  const headers: HeadersInit = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`/api/admin/documents/${id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(data),
  });

  const payload = await res.json();
  if (!res.ok) {
    throw new ApiError(payload.message || 'Update failed', res.status, payload.errors);
  }
  return payload as T;
}

async function requestLocalKnowledgeHealth(): Promise<{ data: KnowledgeHealthReport }> {
  const token = getToken();
  const headers: HeadersInit = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch('/api/admin/knowledge-health', { headers, cache: 'no-store' });
  const data = await res.json();
  if (!res.ok) {
    throw new ApiError(data.message || 'Request failed', res.status, data.errors);
  }
  return data;
}

export const api = {
  // Auth
  auth: {
    register: (name: string, email: string, password: string) =>
      request('POST', '/auth/register', { name, email, password }),
    login: (email: string, password: string) =>
      request<{ data: { token: string; user: User } }>('POST', '/auth/login', { email, password }),
    logout: () => request('POST', '/auth/logout'),
    verifyEmail: (token: string) => request('POST', '/auth/verify-email', { token }),
    forgotPassword: (email: string) => request('POST', '/auth/forgot-password', { email }),
    resetPassword: (token: string, password: string) =>
      request('POST', '/auth/reset-password', { token, password }),
    me: () => request<{ data: User }>('GET', '/auth/me'),
  },

  // Chat
  chat: {
    ask: (question: string, sessionId?: string, categoryId?: number) =>
      // Route through Next.js proxy so empty live-API sources can be enriched
      // with a matching PDF until the PHP attribution fix is deployed.
      requestLocalAsk(question, sessionId, categoryId),
    sessions: (page = 1) =>
      request<PaginatedResponse<ChatSession>>('GET', `/chat/sessions?page=${page}`),
    session: (id: string) =>
      // Route through Next.js proxy so sources are re-enriched after refresh.
      requestLocalSession(id),
    deleteSession: (id: string) => request('DELETE', `/chat/sessions/${id}`),
    faqs: (categoryId?: number, limit = 20) =>
      request<{ data: FAQ[] }>('GET', `/chat/faqs?limit=${limit}${categoryId ? `&category_id=${categoryId}` : ''}`),
    categories: () => request<{ data: Category[] }>('GET', '/chat/categories'),
    submitQuery: (question: string, messageId?: string) =>
      request('POST', '/chat/submit-query', { question, ...(messageId && { message_id: messageId }) }),
    documentFile: (documentId: number) => fetchDocumentFile(documentId),
  },

  // Admin
  admin: {
    metrics: () => request<{ data: Metrics }>('GET', '/admin/metrics'),
    knowledgeHealth: () => requestLocalKnowledgeHealth(),

    documents: {
      list: (params?: Record<string, string | number>) => {
        const qs = new URLSearchParams(params as Record<string, string>).toString();
        return request<PaginatedResponse<Document>>('GET', `/admin/documents?${qs}`);
      },
      upload: (formData: FormData) =>
        requestLocalDocumentUpload<{ data: { document_id: number; status?: string; error?: string }; message?: string }>(formData),
      show: (id: number) => request<{ data: Document }>('GET', `/admin/documents/${id}`),
      update: (id: number, data: {
        title: string;
        category_id: number;
        original_filename?: string;
        category_name?: string;
      }) =>
        requestLocalDocumentUpdate<{ data: Document; local_only?: boolean; message?: string }>(id, data),
      delete: (id: number) => request('DELETE', `/admin/documents/${id}`),
      reparse: (id: number, formData?: FormData) => requestLocalDocumentReparse(id, formData),
    },

    categories: {
      list: () => request<{ data: Category[] }>('GET', '/admin/categories'),
      create: (data: Partial<Category>) => request('POST', '/admin/categories', data as Record<string, unknown>),
      update: (id: number, data: Partial<Category>) =>
        request('PUT', `/admin/categories/${id}`, data as Record<string, unknown>),
      delete: (id: number) => request('DELETE', `/admin/categories/${id}`),
    },

    users: {
      list: (params?: Record<string, string | number>) => {
        const qs = new URLSearchParams(params as Record<string, string>).toString();
        return request<PaginatedResponse<User>>('GET', `/admin/users?${qs}`);
      },
      show: (id: number) => request<{ data: User }>('GET', `/admin/users/${id}`),
      toggle: (id: number) => request('PUT', `/admin/users/${id}/toggle`),
    },

    whitelist: {
      list: () => request<{ data: WhitelistEntry[] }>('GET', '/admin/whitelist'),
      create: (origin: string, note?: string) => request('POST', '/admin/whitelist', { origin, note }),
      delete: (id: number) => request('DELETE', `/admin/whitelist/${id}`),
      toggle: (id: number) => request('PUT', `/admin/whitelist/${id}/toggle`),
    },

    queries: {
      list: (status = 'open', page = 1) =>
        request<PaginatedResponse<UnansweredQuery>>('GET', `/admin/queries?status=${status}&page=${page}`),
      answer: (id: number, answer: string) =>
        request('POST', `/admin/queries/${id}/answer`, { answer }),
    },

    questions: (params?: Record<string, string | number>) => {
      const qs = new URLSearchParams(params as Record<string, string>).toString();
      return request<PaginatedResponse<ChatMessage>>('GET', `/admin/questions?${qs}`);
    },
  },
};

// ── Types ──────────────────────────────────────────────────────────
export interface User {
  id: number;
  name: string;
  email: string;
  role: 'user' | 'admin';
  is_active?: number;
  email_verified_at?: string;
  created_at?: string;
  stats?: { sessions: number; messages: number };
}

export interface ChatSession {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  question?: string;
  answer?: string;
  is_answered?: number;
  created_at: string;
  sources?: MessageSource[];
  user_name?: string;
  user_email?: string;
  category_name?: string;
}

/**
 * Source citation returned by the chat API.
 * page_number is optional for older embeddings / legacy message_sources rows.
 */
export interface MessageSource {
  document_id: number;
  document_title: string;
  /** Original PDF page for this chunk; omitted on legacy data. */
  page_number?: number | null;
  relevance_rank?: number;
  /** Retrieval / FULLTEXT score when the API provides it. */
  score?: number;
  mime_type?: string;
  /** Pre-built document URL from the API (without #page=). */
  pdf_url?: string;
  // CamelCase aliases (preferred API contract going forward)
  fileId?: number;
  fileName?: string;
  pageNumber?: number | null;
  /** Last page when answer spans consecutive pages (e.g. 49–50). */
  page_end?: number | null;
  pageEnd?: number | null;
  /** Optional list of page numbers from the retrieved chunk(s). */
  pageNumbers?: number[] | null;
  pages?: number[] | null;
  /** Pre-formatted label from API: "Page 49" or "Pages 49–50". */
  page_label?: string | null;
  pageLabel?: string | null;
  pdfUrl?: string;
  /** Short quote from the PDF page used to ground this citation. */
  excerpt?: string | null;
  snippet?: string | null;
}

/** Resolve the document id from either snake_case or camelCase source fields. */
export function getSourceFileId(source: MessageSource): number {
  return source.fileId ?? source.document_id;
}

/** Resolve the display name from either snake_case or camelCase source fields. */
export function getSourceFileName(source: MessageSource): string {
  return source.fileName ?? source.document_title;
}

/**
 * Resolve the preserved PDF page number.
 * Returns undefined when missing (backward compatible with old embeddings).
 */
export function getSourcePageNumber(source: MessageSource): number | undefined {
  const explicit = source.pageNumber ?? source.page_number;
  if (explicit != null) {
    const n = Number(explicit);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  const pages = getSourcePageNumbers(source);
  return pages[0];
}

export function getSourcePageNumbers(source: MessageSource): number[] {
  const fromArray = source.pageNumbers ?? source.pages;
  if (Array.isArray(fromArray) && fromArray.length > 0) {
    return fromArray.filter((page): page is number => typeof page === 'number' && Number.isFinite(page) && page > 0).sort((a, b) => a - b);
  }

  const single = source.pageNumber ?? source.page_number;
  if (single == null) return [];
  const number = Number(single);
  return Number.isFinite(number) && number > 0 ? [number] : [];
}

/** Human-readable page label — always matches the PDF link (#page=N). */
export function getSourcePageLabel(source: MessageSource): string | undefined {
  const pages = getSourcePageNumbers(source);
  if (pages.length === 0) {
    const label = source.pageLabel ?? source.page_label;
    return label || undefined;
  }
  if (pages.length === 1) return `Page ${pages[0]}`;

  const sorted = [...pages].sort((a, b) => a - b);
  const consecutive = sorted.every((page, index) => index === 0 || page === sorted[index - 1] + 1);
  if (consecutive) {
    return `Pages ${sorted[0]}–${sorted[sorted.length - 1]}`;
  }

  return `Pages ${sorted.join(', ')}`;
}

/** PDF excerpt shown under source badges for verification. */
export function getSourceExcerpt(source: MessageSource): string | undefined {
  const text = (source.excerpt ?? source.snippet ?? '').trim();
  return text || undefined;
}

async function fetchDocumentFile(documentId: number): Promise<Blob> {
  const token = getToken();
  const res = await fetch(`${API_URL}/chat/documents/${documentId}/file`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    let detail = 'Unable to open document';
    try {
      const body = await res.json();
      if (body?.message === 'Route not found') {
        detail = 'Document viewer is not enabled on the server yet. Deploy the latest API files.';
      } else if (body?.message) {
        detail = body.message;
      }
    } catch {
      // Non-JSON error body (e.g. HTML 404 page)
    }
    throw new Error(detail);
  }
  return res.blob();
}

/**
 * Build the document viewer URL, appending #page=N for PDFs when page metadata exists.
 * Always targets the real API host — never the dev JSON proxy (PDFs are binary).
 */
export function buildSourcePdfUrl(source: MessageSource, token: string): string {
  const fileId = getSourceFileId(source);
  const base = `${DOCUMENT_API_URL}/chat/documents/${fileId}/file?token=${encodeURIComponent(token)}`;

  const isPdf = !source.mime_type || source.mime_type === 'application/pdf';
  const page = getSourcePageNumber(source);

  if (isPdf && page) {
    return `${base}#page=${page}`;
  }

  return base;
}

export function openDocumentSource(source: MessageSource): void {
  const token = getToken();
  if (!token) {
    throw new Error('Please log in again to view documents.');
  }

  const url = buildSourcePdfUrl(source, token);
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export interface AskResponse {
  session_id: string;
  message_id: string;
  answer: string;
  sources: MessageSource[];
  is_answered: boolean;
  query_id?: number;
  from_cache?: boolean;
}

export interface FAQ {
  id: number;
  canonical_question: string;
  canonical_answer: string;
  ask_count: number;
  category_name?: string;
}

export interface Document {
  id: number;
  title: string;
  original_filename: string;
  category_id?: number;
  mime_type: string;
  file_size: number;
  page_count?: number;
  chunk_count?: number;
  status: 'pending' | 'processing' | 'ready' | 'error';
  category_name?: string;
  error_message?: string;
  file_on_disk?: boolean;
  created_at: string;
}

export type IndexingHealth = 'good' | 'low' | 'none' | 'not_ready';

export interface KnowledgeHealthDocument {
  id: number;
  title: string;
  original_filename?: string;
  status: string;
  page_count: number | null;
  chunk_count: number;
  file_on_disk: boolean;
  indexing: IndexingHealth;
}

export interface KnowledgeHealthReport {
  summary: {
    total_documents: number;
    ready_documents: number;
    total_chunks: number;
    low_indexing: number;
    not_indexed: number;
    errors: number;
  };
  documents: KnowledgeHealthDocument[];
}

export interface Category {
  id: number;
  name: string;
  slug: string;
  description?: string;
  parent_id?: number;
  parent_name?: string;
  doc_count?: number;
}

export interface WhitelistEntry {
  id: number;
  origin: string;
  note?: string;
  is_active: number;
  created_by_name?: string;
  created_at: string;
}

export interface UnansweredQuery {
  id: number;
  question: string;
  admin_answer?: string;
  status: 'open' | 'answered' | 'dismissed';
  user_name: string;
  user_email: string;
  created_at: string;
}

export interface Metrics {
  total_users: number;
  active_today: number;
  total_questions: number;
  questions_today: number;
  unanswered_open: number;
  new_users_30d: number;
  answer_rate_pct: number;
  top_categories: { name: string; question_count: number }[];
  top_faqs: { canonical_question: string; ask_count: number }[];
  daily_activity: { date: string; count: number }[];
}

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  meta: { total: number; page: number; per_page: number; total_pages: number };
}
