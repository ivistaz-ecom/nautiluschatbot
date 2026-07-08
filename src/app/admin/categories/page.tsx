'use client';
import { useState, useEffect } from 'react';
import { api, Category } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft, Plus, Trash2, Edit2, FolderOpen, Check, X } from 'lucide-react';

export default function AdminCategories() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [cats, setCats]     = useState<Category[]>([]);
  const [form, setForm]     = useState({ name: '', description: '', parent_id: '' });
  const [editing, setEditing] = useState<Category | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!loading && (!user || user.role !== 'admin')) router.push('/login');
  }, [user, loading, router]);

  useEffect(() => {
    if (user?.role === 'admin') load();
  }, [user]);

  async function load() {
    const r = await api.admin.categories.list();
    setCats(r.data);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.admin.categories.create({ ...form, parent_id: form.parent_id ? Number(form.parent_id) : undefined });
      setForm({ name: '', description: '', parent_id: '' });
      load();
    } finally { setSaving(false); }
  }

  async function handleUpdate() {
    if (!editing) return;
    setSaving(true);
    try {
      await api.admin.categories.update(editing.id, editing);
      setEditing(null);
      load();
    } finally { setSaving(false); }
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this category? Documents in it cannot be deleted this way.')) return;
    try {
      await api.admin.categories.delete(id);
      load();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Cannot delete');
    }
  }

  return (
    <div className="min-h-screen bg-brand">
      <div className="max-w-3xl mx-auto px-6 py-6">
        <div className="flex items-center gap-3 mb-6">
          <Link href="/admin" className="text-gray-400 hover:text-gray-600"><ChevronLeft className="w-5 h-5" /></Link>
          <FolderOpen className="w-5 h-5 text-[#1B4F8A]" />
          <h1 className="text-xl font-bold text-gray-900">Categories</h1>
        </div>

        {/* Create form */}
        <div className="card p-5 mb-6">
          <h2 className="font-semibold text-gray-800 mb-4 text-sm">New category</h2>
          <form onSubmit={handleCreate} className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <input className="input" placeholder="Category name *" required
              value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
            <input className="input" placeholder="Description (optional)"
              value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} />
            <select className="input" value={form.parent_id} onChange={e => setForm(p => ({ ...p, parent_id: e.target.value }))}>
              <option value="">No parent</option>
              {cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <div className="md:col-span-3">
              <button type="submit" className="btn-primary text-sm flex items-center gap-1" disabled={saving}>
                <Plus className="w-4 h-4" />{saving ? 'Creating…' : 'Create category'}
              </button>
            </div>
          </form>
        </div>

        {/* List */}
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Name</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Parent</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Docs</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {cats.map(cat => (
                <tr key={cat.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    {editing?.id === cat.id ? (
                      <input className="input text-sm" value={editing.name}
                        onChange={e => setEditing(p => p ? { ...p, name: e.target.value } : p)} />
                    ) : (
                      <span className="font-medium text-gray-900">{cat.name}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{(cat as Record<string, unknown>).parent_name as string || '—'}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{cat.doc_count ?? 0}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      {editing?.id === cat.id ? (
                        <>
                          <button onClick={handleUpdate} className="p-1.5 text-green-600 hover:bg-green-50 rounded">
                            <Check className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => setEditing(null)} className="p-1.5 text-gray-400 hover:bg-gray-50 rounded">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => setEditing(cat)} className="p-1.5 text-gray-400 hover:text-blue-600 rounded">
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => handleDelete(cat.id)} className="p-1.5 text-gray-400 hover:text-red-600 rounded">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {!cats.length && <tr><td colSpan={4} className="text-center py-8 text-gray-400 text-sm">No categories yet</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
