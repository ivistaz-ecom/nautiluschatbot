'use client';
import { useState, useEffect } from 'react';
import { api, UnansweredQuery } from '@/lib/api';
import { Send, CheckCircle, MessageSquare } from 'lucide-react';

export default function AdminQueries() {
  const [queries, setQueries] = useState<UnansweredQuery[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('open');
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState<Record<number, boolean>>({});

  useEffect(() => {
    load();
  }, [status, page]);

  async function load() {
    const r = await api.admin.queries.list(status, page);
    setQueries(r.data);
    setTotal(r.meta.total);
  }

  async function handleAnswer(id: number) {
    const answer = answers[id]?.trim();
    if (!answer) return;
    setSaving(p => ({ ...p, [id]: true }));
    try {
      await api.admin.queries.answer(id, answer);
      load();
    } finally {
      setSaving(p => ({ ...p, [id]: false }));
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-6">
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-xl font-bold text-white">Unanswered Queries</h1>
        <span className="text-white/50 text-sm">{total} results</span>

        <div className="ml-auto flex gap-2">
          {['open', 'answered', 'dismissed'].map(s => (
            <button key={s} onClick={() => { setStatus(s); setPage(1); }}
              className={`px-3 py-1.5 text-xs rounded-lg font-medium capitalize transition-colors ${status === s ? 'bg-brand-accent text-white' : 'bg-white/10 text-white/70 hover:bg-white/15'}`}>
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-4">
        {queries.map(q => (
          <div key={q.id} className="card p-5">
            <div className="flex items-start justify-between gap-4 mb-3">
              <div className="flex items-center gap-2 text-xs text-white/50">
                <div className="w-6 h-6 bg-white/10 rounded-full flex items-center justify-center text-white font-medium text-xs">
                  {q.user_name[0]}
                </div>
                <span className="font-medium text-white/80">{q.user_name}</span>
                <span>·</span>
                <span>{q.user_email}</span>
                <span>·</span>
                <span>{new Date(q.created_at).toLocaleDateString()}</span>
              </div>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                q.status === 'open' ? 'bg-amber-500/20 text-amber-300' :
                q.status === 'answered' ? 'bg-green-500/20 text-green-300' : 'bg-white/10 text-white/50'
              }`}>{q.status}</span>
            </div>

            <div className="bg-white/5 rounded-lg p-3 mb-4">
              <p className="text-sm font-medium text-white/50 mb-1 flex items-center gap-1">
                <MessageSquare className="w-3.5 h-3.5" />User question
              </p>
              <p className="text-sm text-white">{q.question}</p>
            </div>

            {q.admin_answer && (
              <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3 mb-4">
                <p className="text-sm font-medium text-green-300 mb-1 flex items-center gap-1">
                  <CheckCircle className="w-3.5 h-3.5" />Admin answer
                </p>
                <p className="text-sm text-white">{q.admin_answer}</p>
              </div>
            )}

            {q.status === 'open' && (
              <div className="flex gap-2">
                <textarea
                  className="flex-1 input text-sm resize-none"
                  rows={2}
                  placeholder="Type your answer…"
                  value={answers[q.id] ?? ''}
                  onChange={e => setAnswers(p => ({ ...p, [q.id]: e.target.value }))}
                />
                <button
                  onClick={() => handleAnswer(q.id)}
                  disabled={!answers[q.id]?.trim() || saving[q.id]}
                  className="btn-primary flex items-center gap-1 text-sm self-end"
                >
                  <Send className="w-3.5 h-3.5" />
                  {saving[q.id] ? 'Saving…' : 'Answer'}
                </button>
              </div>
            )}
          </div>
        ))}

        {!queries.length && (
          <div className="card p-12 text-center">
            <CheckCircle className="w-10 h-10 text-green-400 mx-auto mb-3" />
            <p className="text-white/50 text-sm">No {status} queries</p>
          </div>
        )}
      </div>

      {total > 20 && (
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={() => setPage(p => p - 1)} disabled={page === 1} className="btn-secondary text-xs px-3 py-1.5">Previous</button>
          <button onClick={() => setPage(p => p + 1)} disabled={page * 20 >= total} className="btn-secondary text-xs px-3 py-1.5">Next</button>
        </div>
      )}
    </div>
  );
}
