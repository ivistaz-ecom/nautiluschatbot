'use client';
import { useState, useEffect } from 'react';
import { api, ChatMessage } from '@/lib/api';
import { Search } from 'lucide-react';

export default function AdminQuestions() {
  const [questions, setQuestions] = useState<ChatMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');

  useEffect(() => {
    load();
  }, [page]);

  async function load() {
    const params: Record<string, string | number> = { page };
    if (search) params.search = search;
    const r = await api.admin.questions(params);
    setQuestions(r.data);
    setTotal(r.meta.total);
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-6">
      <h1 className="text-xl font-bold text-white mb-6">All Questions</h1>

      <div className="relative max-w-md mb-4">
        <Search className="absolute left-3 top-2.5 w-4 h-4 text-white/40" />
        <input
          className="input pl-9 text-sm w-full"
          placeholder="Search questions…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && load()}
        />
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Question</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Answered</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {questions.map(q => (
              <tr key={q.id} className="hover:bg-white/5">
                <td className="px-4 py-3 text-white max-w-lg truncate">{q.question || q.answer || '—'}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${q.is_answered ? 'bg-green-500/20 text-green-300' : 'bg-amber-500/20 text-amber-300'}`}>
                    {q.is_answered ? 'Yes' : 'No'}
                  </span>
                </td>
                <td className="px-4 py-3 text-white text-xs">
                  {q.created_at ? new Date(q.created_at).toLocaleString() : '—'}
                </td>
              </tr>
            ))}
            {!questions.length && (
              <tr><td colSpan={3} className="text-center py-12 text-white/40 text-sm">No questions found</td></tr>
            )}
          </tbody>
        </table>
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
