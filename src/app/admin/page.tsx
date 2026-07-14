'use client';
import { useState, useEffect } from 'react';
import { api, Metrics, KnowledgeHealthReport } from '@/lib/api';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import {
  Users, MessageSquare, AlertTriangle, TrendingUp, Database, RefreshCw,
} from 'lucide-react';
import Link from 'next/link';

async function fetchMetricsWithRetry(attempts = 3): Promise<Metrics> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await api.admin.metrics();
      return res.data;
    } catch (err) {
      lastError = err;
      // Brief backoff — production DB sometimes returns intermittent 503s.
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Failed to load metrics');
}

/** Lighter endpoints when /admin/metrics fails. */
async function fetchMetricsFallback(): Promise<Partial<Metrics>> {
  const [usersRes, queriesRes] = await Promise.allSettled([
    api.admin.users.list({ page: 1 }),
    api.admin.queries.list('open', 1),
  ]);

  const partial: Partial<Metrics> = {
    daily_activity: [],
    top_faqs: [],
    top_categories: [],
  };

  if (usersRes.status === 'fulfilled') {
    partial.total_users = usersRes.value.meta?.total ?? usersRes.value.data.length;
  }
  if (queriesRes.status === 'fulfilled') {
    partial.unanswered_open = queriesRes.value.meta?.total ?? queriesRes.value.data.length;
  }

  return partial;
}

export default function AdminDashboard() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [health, setHealth] = useState<KnowledgeHealthReport | null>(null);
  const [loadingMetrics, setLoadingMetrics] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  async function load(isRefresh = false) {
    if (isRefresh) setRefreshing(true);
    else setLoadingMetrics(true);
    setError(null);
    setPartial(false);

    try {
      const [metricsRes, healthRes] = await Promise.allSettled([
        fetchMetricsWithRetry(3),
        api.admin.knowledgeHealth(),
      ]);

      if (metricsRes.status === 'fulfilled') {
        setMetrics(metricsRes.value);
      } else {
        try {
          const fallback = await fetchMetricsFallback();
          setMetrics({
            total_users: fallback.total_users ?? 0,
            active_today: 0,
            total_questions: 0,
            questions_today: 0,
            unanswered_open: fallback.unanswered_open ?? 0,
            new_users_30d: 0,
            answer_rate_pct: 0,
            top_categories: [],
            top_faqs: [],
            daily_activity: [],
            ...fallback,
          } as Metrics);
          setPartial(true);
          setError(
            metricsRes.reason instanceof Error
              ? metricsRes.reason.message
              : 'Full metrics temporarily unavailable'
          );
        } catch {
          setMetrics(null);
          setError(
            metricsRes.reason instanceof Error
              ? metricsRes.reason.message
              : 'Failed to load metrics'
          );
        }
      }

      if (healthRes.status === 'fulfilled') {
        setHealth(healthRes.value.data);
      } else {
        setHealth(null);
      }
    } finally {
      setLoadingMetrics(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (loadingMetrics) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-6">
      <div className="flex items-start justify-between gap-4 mb-8">
        <div>
          <h1 className="text-xl font-bold text-white mb-1">Dashboard</h1>
          <p className="text-white/50 text-sm">Knowledge Base overview</p>
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={refreshing}
          className="btn-secondary text-xs flex items-center gap-1.5 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          <p className="font-medium">
            {partial ? 'Showing partial dashboard data' : 'Could not load dashboard metrics'}
          </p>
          <p className="text-amber-200/80 mt-1">{error}</p>
          <p className="text-amber-200/60 mt-2 text-xs">
            The API database connection is flaky. Use Refresh, or check MySQL on the PHP host.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <MetricCard label="Total Users" value={metrics?.total_users ?? 0} icon={Users} color="blue" sub={`${metrics?.new_users_30d ?? 0} new this month`} />
        <MetricCard label="Questions Today" value={metrics?.questions_today ?? 0} icon={MessageSquare} color="purple" sub={`${metrics?.total_questions ?? 0} total`} />
        <MetricCard label="Answer Rate" value={`${metrics?.answer_rate_pct ?? 0}%`} icon={TrendingUp} color="green" sub="last 30 days" />
        <MetricCard label="Open Queries" value={metrics?.unanswered_open ?? 0} icon={AlertTriangle} color="amber" sub="need admin reply" />
      </div>

      {health && (
        <div className="card p-5 mb-8">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-brand-accent" />
              <h2 className="font-semibold text-white text-sm">Knowledge base indexing</h2>
            </div>
            <Link href="/admin/documents" className="text-xs text-brand-accent hover:underline">
              View documents
            </Link>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            <div>
              <p className="text-xs text-white/50">Ready PDFs</p>
              <p className="text-xl font-bold text-white">{health.summary.ready_documents}</p>
            </div>
            <div>
              <p className="text-xs text-white/50">Searchable chunks</p>
              <p className="text-xl font-bold text-white">{health.summary.total_chunks}</p>
            </div>
            <div>
              <p className="text-xs text-white/50">Partially indexed</p>
              <p className={`text-xl font-bold ${health.summary.low_indexing > 0 ? 'text-amber-300' : 'text-white'}`}>
                {health.summary.low_indexing}
              </p>
            </div>
            <div>
              <p className="text-xs text-white/50">Not indexed</p>
              <p className={`text-xl font-bold ${health.summary.not_indexed > 0 ? 'text-red-300' : 'text-white'}`}>
                {health.summary.not_indexed}
              </p>
            </div>
          </div>
          {(health.summary.low_indexing > 0 || health.summary.not_indexed > 0) && (
            <p className="text-xs text-amber-200/90">
              Chat only searches indexed text. Re-parse any PDF with low chunk counts so answers come from the full document.
            </p>
          )}
          {health.summary.ready_documents > 0 && health.summary.low_indexing === 0 && health.summary.not_indexed === 0 && (
            <p className="text-xs text-green-300/90">
              All ready documents are indexed. In chat, click a source badge to open the PDF at the cited page and verify the answer.
            </p>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="card p-5 lg:col-span-2">
          <h2 className="font-semibold text-white mb-4 text-sm">Daily activity (30 days)</h2>
          {(metrics?.daily_activity?.length ?? 0) === 0 ? (
            <p className="text-xs text-white/40 py-16 text-center">
              {partial || error ? 'Activity chart unavailable while metrics API is down.' : 'No activity yet'}
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={metrics?.daily_activity ?? []}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.5)' }} tickFormatter={(d) => d.slice(5)} />
                <YAxis tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.5)' }} />
                <Tooltip
                  cursor={false}
                  contentStyle={{ background: '#003d52', border: '1px solid rgba(255,255,255,0.1)', color: '#fff' }}
                />
                <Bar
                  dataKey="count"
                  fill="#0ea5c9"
                  radius={[3, 3, 0, 0]}
                  activeBar={{ fill: '#38bdf8' }}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="card p-5">
          <h2 className="font-semibold text-white mb-4 text-sm">Top FAQs</h2>
          <div className="space-y-3">
            {(metrics?.top_faqs ?? []).slice(0, 8).map((faq, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="text-xs font-bold text-white/30 w-5 text-right flex-shrink-0 mt-0.5">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-white/80 truncate">{faq.canonical_question}</p>
                  <p className="text-xs text-white/40">{faq.ask_count}× asked</p>
                </div>
              </div>
            ))}
            {!metrics?.top_faqs?.length && <p className="text-xs text-white/40">No FAQs yet</p>}
          </div>
        </div>
      </div>

      {metrics?.top_categories?.length ? (
        <div className="card p-5 mt-6">
          <h2 className="font-semibold text-white mb-4 text-sm">Top categories (30 days)</h2>
          <div className="flex flex-wrap gap-3">
            {metrics.top_categories.map((c, i) => (
              <div key={i} className="flex items-center gap-2 bg-white/10 rounded-lg px-3 py-2">
                <span className="text-sm font-medium text-white">{c.name}</span>
                <span className="text-xs text-white/50">{c.question_count} questions</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MetricCard({ label, value, icon: Icon, color, sub }: {
  label: string; value: string | number; icon: React.ElementType; color: string; sub: string;
}) {
  const colors: Record<string, string> = {
    blue: 'bg-blue-500/20 text-blue-300',
    purple: 'bg-purple-500/20 text-purple-300',
    green: 'bg-green-500/20 text-green-300',
    amber: 'bg-amber-500/20 text-amber-300',
  };
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-medium text-white/50 uppercase tracking-wide">{label}</p>
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${colors[color]}`}>
          <Icon className="w-4 h-4" />
        </div>
      </div>
      <p className="text-2xl font-bold text-white">{value}</p>
      <p className="text-xs text-white/40 mt-1">{sub}</p>
    </div>
  );
}
