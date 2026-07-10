'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth';
import { useRouter } from 'next/navigation';
import { api, Metrics } from '@/lib/api';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import {
  Users, MessageSquare, FileText, AlertTriangle, TrendingUp,
  Shield, FolderOpen, LogOut, HelpCircle
} from 'lucide-react';
import { Logo } from '@/components/Logo';

export default function AdminDashboard() {
  const { user, logout, loading } = useAuth();
  const router = useRouter();
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loadingMetrics, setLoadingMetrics] = useState(true);

  useEffect(() => {
    if (!loading && (!user || user.role !== 'admin')) router.push('/login');
  }, [user, loading, router]);

  useEffect(() => {
    if (user?.role === 'admin') {
      api.admin.metrics()
        .then(r => setMetrics(r.data))
        .finally(() => setLoadingMetrics(false));
    }
  }, [user]);

  if (loading || loadingMetrics) return (
    <div className="min-h-screen flex items-center justify-center bg-brand">
      <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
    </div>
  );

  const navLinks = [
    { href: '/admin', label: 'Dashboard', icon: TrendingUp },
    { href: '/admin/documents', label: 'Documents', icon: FileText },
    { href: '/admin/categories', label: 'Categories', icon: FolderOpen },
    { href: '/admin/users', label: 'Users', icon: Users },
    { href: '/admin/whitelist', label: 'URL Whitelist', icon: Shield },
    { href: '/admin/queries', label: 'Unanswered', icon: HelpCircle, badge: metrics?.unanswered_open },
    { href: '/admin/questions', label: 'All Questions', icon: MessageSquare },
  ];

  return (
    <div className="flex h-screen bg-brand">
      {/* Sidebar */}
      <aside className="w-60 bg-brand border-r border-white/10 flex flex-col flex-shrink-0">
        <div className="px-4 py-5 border-b border-white/10">
          <Logo size="sm" />
          <p className="text-white/50 text-xs mt-1 pl-1">Admin Panel</p>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1">
          {navLinks.map(({ href, label, icon: Icon, badge }) => (
            <Link key={href} href={href} className="flex items-center gap-3 px-3 py-2 text-white/70 hover:bg-white/10 hover:text-white rounded-lg text-sm transition-colors group">
              <Icon className="w-4 h-4 flex-shrink-0" />
              <span className="flex-1">{label}</span>
              {badge ? (
                <span className="bg-red-500 text-white text-xs px-1.5 py-0.5 rounded-full min-w-[20px] text-center">
                  {badge}
                </span>
              ) : null}
            </Link>
          ))}
        </nav>

        <div className="px-3 py-4 border-t border-white/10">
          <Link href="/chat" className="flex items-center gap-3 px-3 py-2 text-white/70 hover:bg-white/10 rounded-lg text-sm">
            <MessageSquare className="w-4 h-4" />User chat
          </Link>
          <button onClick={logout} className="flex items-center gap-3 px-3 py-2 text-white/70 hover:bg-white/10 rounded-lg text-sm w-full">
            <LogOut className="w-4 h-4" />Sign out
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto">
        <div className="px-8 py-6">
          <h1 className="text-xl font-bold text-white mb-1">Dashboard</h1>
          <p className="text-white/50 text-sm mb-8">Knowledge Base overview</p>

          {/* Metric cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <MetricCard label="Total Users" value={metrics?.total_users ?? 0} icon={Users} color="blue" sub={`${metrics?.new_users_30d} new this month`} />
            <MetricCard label="Questions Today" value={metrics?.questions_today ?? 0} icon={MessageSquare} color="purple" sub={`${metrics?.total_questions} total`} />
            <MetricCard label="Answer Rate" value={`${metrics?.answer_rate_pct ?? 0}%`} icon={TrendingUp} color="green" sub="last 30 days" />
            <MetricCard label="Open Queries" value={metrics?.unanswered_open ?? 0} icon={AlertTriangle} color="amber" sub="need admin reply" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Activity chart */}
            <div className="card p-5 lg:col-span-2">
              <h2 className="font-semibold text-white mb-4 text-sm">Daily activity (30 days)</h2>
              <ResponsiveContainer width="100%" height={220}>
              <BarChart data={metrics?.daily_activity ?? []}>
  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
  <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.5)' }} tickFormatter={d => d.slice(5)} />
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
            </div>

            {/* Top FAQs */}
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

          {/* Top categories */}
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
      </main>
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
