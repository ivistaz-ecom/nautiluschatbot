'use client';
import { useState, useEffect, useRef } from 'react';
import { api, Document, Category } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Upload, Trash2, RefreshCw, FileText, ChevronLeft, Search, Filter } from 'lucide-react';

export default function AdminDocuments() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [docs, setDocs]         = useState<Document[]>([]);
  const [cats, setCats]         = useState<Category[]>([]);
  const [total, setTotal]       = useState(0);
  const [page, setPage]         = useState(1);
  const [search, setSearch]     = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadForm, setUploadForm] = useState<{ title: string; category_id: string }>({ title: '', category_id: '' });
  const [showUpload, setShowUpload] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!loading && (!user || user.role !== 'admin')) router.push('/login');
  }, [user, loading, router]);

  useEffect(() => {
    if (user?.role === 'admin') {
      load();
      api.admin.categories.list().then(r => setCats(r.data));
    }
  }, [user, page, catFilter, statusFilter]);

  async function load() {
    const params: Record<string, string | number> = { page };
    if (search) params.search = search;
    if (catFilter) params.category_id = catFilter;
    if (statusFilter) params.status = statusFilter;
    const r = await api.admin.documents.list(params);
    setDocs(r.data);
    setTotal(r.meta.total);
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file || !uploadForm.category_id) return;

    const fd = new FormData();
    fd.append('file', file);
    fd.append('category_id', uploadForm.category_id);
    fd.append('title', uploadForm.title || file.name.replace(/\.[^.]+$/, ''));

    setUploading(true);
    try {
      const res = await api.admin.documents.upload(fd) as { message?: string; data?: { status?: string; error?: string } };
      if (res.data?.status === 'error') {
        alert(res.data.error || res.message || 'Parsing failed');
      }
      setShowUpload(false);
      setUploadForm({ title: '', category_id: '' });
      if (fileRef.current) fileRef.current.value = '';
      load();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this document and all its chunks?')) return;
    await api.admin.documents.delete(id);
    load();
  }

  async function handleReparse(id: number) {
    await api.admin.documents.reparse(id);
    load();
  }

  return (
    <div className="min-h-screen bg-brand">
      <div className="max-w-6xl mx-auto px-6 py-6">
        <div className="flex items-center gap-3 mb-6">
          <Link href="/admin" className="text-gray-400 hover:text-gray-600"><ChevronLeft className="w-5 h-5" /></Link>
          <h1 className="text-xl font-bold text-gray-900">Documents</h1>
          <span className="text-gray-400 text-sm ml-1">{total} total</span>
          <button onClick={() => setShowUpload(!showUpload)} className="btn-primary ml-auto flex items-center gap-2 text-sm">
            <Upload className="w-4 h-4" />Upload document
          </button>
        </div>

        {/* Upload form */}
        {showUpload && (
          <div className="card p-5 mb-6">
            <h2 className="font-semibold text-gray-800 mb-4 text-sm">Upload new document</h2>
            <form onSubmit={handleUpload} className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Title (optional)</label>
                <input className="input" placeholder="Leave blank to use filename"
                  value={uploadForm.title} onChange={e => setUploadForm(p => ({ ...p, title: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Category *</label>
                <select className="input" required value={uploadForm.category_id}
                  onChange={e => setUploadForm(p => ({ ...p, category_id: e.target.value }))}>
                  <option value="">Select category</option>
                  {cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">File (PDF or DOCX, max 50MB) *</label>
                <input ref={fileRef} type="file" accept=".pdf,.docx" required className="input text-sm file:mr-2 file:text-xs file:border-0 file:bg-gray-100 file:rounded file:px-2 file:py-1" />
              </div>
              <div className="md:col-span-3 flex gap-2">
                <button type="submit" className="btn-primary text-sm" disabled={uploading}>
                  {uploading ? 'Uploading…' : 'Upload & parse'}
                </button>
                <button type="button" className="btn-secondary text-sm" onClick={() => setShowUpload(false)}>Cancel</button>
              </div>
            </form>
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-wrap gap-3 mb-4">
          <div className="relative flex-1 min-w-48">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
            <input className="input pl-9 text-sm" placeholder="Search documents…"
              value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}
              onKeyDown={e => e.key === 'Enter' && load()} />
          </div>
          <select className="input text-sm w-44" value={catFilter} onChange={e => { setCatFilter(e.target.value); setPage(1); }}>
            <option value="">All categories</option>
            {cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select className="input text-sm w-36" value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1); }}>
            <option value="">All statuses</option>
            <option value="ready">Ready</option>
            <option value="pending">Pending</option>
            <option value="processing">Processing</option>
            <option value="error">Error</option>
          </select>
        </div>

        {/* Table */}
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Document</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Category</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Pages</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Status</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Uploaded</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {docs.map(doc => (
                <tr key={doc.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <FileText className="w-4 h-4 text-gray-400 flex-shrink-0" />
                      <div>
                        <p className="font-medium text-gray-900">{doc.title}</p>
                        <p className="text-xs text-gray-400">{doc.original_filename}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{doc.category_name}</td>
                  <td className="px-4 py-3 text-gray-600">{doc.page_count ?? '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`badge-${doc.status}`}>{doc.status}</span>
                    {doc.status === 'error' && doc.error_message && (
                      <p className="text-xs text-red-400 mt-1 max-w-xs">{doc.error_message}</p>
                    )}
                    {doc.status === 'pending' && (
                      <p className="text-xs text-amber-400 mt-1">Not indexed yet — click re-parse</p>
                    )}
                    {doc.file_on_disk === false && (
                      <p className="text-xs text-red-500 mt-1 font-medium">File missing on server — re-upload PDF</p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{new Date(doc.created_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <button onClick={() => handleReparse(doc.id)} title="Re-parse" className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded">
                        <RefreshCw className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => handleDelete(doc.id)} title="Delete" className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!docs.length && (
                <tr><td colSpan={6} className="text-center py-12 text-gray-400 text-sm">No documents found</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {total > 20 && (
          <div className="flex items-center justify-between mt-4 text-sm">
            <p className="text-gray-400">Showing {(page - 1) * 20 + 1}–{Math.min(page * 20, total)} of {total}</p>
            <div className="flex gap-2">
              <button onClick={() => setPage(p => p - 1)} disabled={page === 1} className="btn-secondary text-xs px-3 py-1.5">Previous</button>
              <button onClick={() => setPage(p => p + 1)} disabled={page * 20 >= total} className="btn-secondary text-xs px-3 py-1.5">Next</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
