'use client';
import { useState, useEffect } from 'react';
import { api, WhitelistEntry } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft, Plus, Trash2, Shield, ToggleLeft, ToggleRight } from 'lucide-react';

export default function AdminWhitelist() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [entries, setEntries] = useState<WhitelistEntry[]>([]);
  const [form, setForm]       = useState({ origin: '', note: '' });
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');

  useEffect(() => {
    if (!loading && (!user || user.role !== 'admin')) router.push('/login');
  }, [user, loading, router]);

  useEffect(() => {
    if (user?.role === 'admin') load();
  }, [user]);

  async function load() {
    const r = await api.admin.whitelist.list();
    setEntries(r.data);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await api.admin.whitelist.create(form.origin, form.note);
      setForm({ origin: '', note: '' });
      load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to add');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    if (!confirm('Remove this origin from whitelist?')) return;
    await api.admin.whitelist.delete(id);
    load();
  }

  async function handleToggle(id: number) {
    await api.admin.whitelist.toggle(id);
    load();
  }

  return (
    <div className="min-h-screen bg-brand">
      <div className="max-w-3xl mx-auto px-6 py-6">
        <div className="flex items-center gap-3 mb-6">
          <Link href="/admin" className="text-gray-400 hover:text-gray-600"><ChevronLeft className="w-5 h-5" /></Link>
          <Shield className="w-5 h-5 text-[#1B4F8A]" />
          <h1 className="text-xl font-bold text-gray-900">URL Whitelist</h1>
        </div>

        {/* Add form */}
        <div className="card p-5 mb-6">
          <h2 className="font-semibold text-gray-800 mb-4 text-sm">Add allowed origin</h2>
          {error && <p className="text-red-600 text-sm mb-3">{error}</p>}
          <form onSubmit={handleAdd} className="flex gap-3">
            <input className="input flex-1" placeholder="https://yoursite.com" required
              value={form.origin} onChange={e => setForm(p => ({ ...p, origin: e.target.value }))} />
            <input className="input w-48" placeholder="Note (optional)"
              value={form.note} onChange={e => setForm(p => ({ ...p, note: e.target.value }))} />
            <button type="submit" className="btn-primary flex items-center gap-1 text-sm" disabled={saving}>
              <Plus className="w-4 h-4" />{saving ? 'Adding…' : 'Add'}
            </button>
          </form>
        </div>

        {/* List */}
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Origin</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Note</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {entries.map(e => (
                <tr key={e.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-xs text-gray-700">{e.origin}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{e.note || '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${e.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {e.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <button onClick={() => handleToggle(e.id)} className="p-1.5 text-gray-400 hover:text-blue-600 rounded" title="Toggle">
                        {e.is_active ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
                      </button>
                      <button onClick={() => handleDelete(e.id)} className="p-1.5 text-gray-400 hover:text-red-600 rounded">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!entries.length && <tr><td colSpan={4} className="text-center py-8 text-gray-400 text-sm">No entries</td></tr>}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-gray-400 mt-4">
          Only requests with an Origin header matching an active entry will be processed. Add <code className="bg-gray-100 px-1 rounded">http://localhost:3000</code> for local development.
        </p>
      </div>
    </div>
  );
}
