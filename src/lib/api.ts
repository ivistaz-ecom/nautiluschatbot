// src/lib/api.ts

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://nautilus.crafttechhub.com/api/v1';

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

  const data = await res.json();

  if (!res.ok) {
    throw new ApiError(data.message || 'Request failed', res.status, data.errors);
  }

  return data;
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
      request<{ data: AskResponse }>('POST', '/chat/ask', {
        question,
        ...(sessionId && { session_id: sessionId }),
        ...(categoryId && { category_id: categoryId }),
      }),
    sessions: (page = 1) =>
      request<PaginatedResponse<ChatSession>>('GET', `/chat/sessions?page=${page}`),
    session: (id: string) =>
      request<{ data: { session: ChatSession; messages: ChatMessage[] } }>('GET', `/chat/sessions/${id}`),
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

    documents: {
      list: (params?: Record<string, string | number>) => {
        const qs = new URLSearchParams(params as Record<string, string>).toString();
        return request<PaginatedResponse<Document>>('GET', `/admin/documents?${qs}`);
      },
      upload: (formData: FormData) =>
        request<{ data: { document_id: number } }>('POST', '/admin/documents', formData, true),
      show: (id: number) => request<{ data: Document }>('GET', `/admin/documents/${id}`),
      delete: (id: number) => request('DELETE', `/admin/documents/${id}`),
      reparse: (id: number) => request('POST', `/admin/documents/${id}/reparse`),
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

export interface MessageSource {
  document_id: number;
  document_title: string;
  page_number: number;
  relevance_rank: number;
  mime_type?: string;
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

export async function openDocumentSource(source: MessageSource): Promise<void> {
  const token = getToken();
  if (!token) {
    throw new Error('Please log in again to view documents.');
  }

  const isPdf = !source.mime_type || source.mime_type === 'application/pdf';
  const page  = isPdf && source.page_number ? `#page=${source.page_number}` : '';
  const url   = `${API_URL}/chat/documents/${source.document_id}/file?token=${encodeURIComponent(token)}${page}`;

  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  if (!opened) {
    throw new Error('Pop-up blocked. Allow pop-ups for this site and try again.');
  }
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
  mime_type: string;
  file_size: number;
  page_count?: number;
  status: 'pending' | 'processing' | 'ready' | 'error';
  category_name?: string;
  error_message?: string;
  file_on_disk?: boolean;
  created_at: string;
}

export interface Category {
  id: number;
  name: string;
  slug: string;
  description?: string;
  parent_id?: number;
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
