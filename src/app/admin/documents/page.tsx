'use client';
import { useState, useEffect, useRef } from 'react';
import { api, Document, Category } from '@/lib/api';
import { Upload, Trash2, RefreshCw, FileText, Search, Edit2, X, Check } from 'lucide-react';

type EditForm = { title: string; original_filename: string; category_id: string };

function formatStatusLabel(status: Document['status']): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function statusBadgeClass(status: Document['status']): string {
  switch (status) {
    case 'ready':
      return 'inline-flex items-center rounded-full border border-green-500/50 bg-green-500/20 px-2 py-0.5 text-xs font-semibold text-green-400';
    case 'pending':
      return 'inline-flex items-center rounded-full bg-yellow-500/20 px-2 py-0.5 text-xs font-medium text-yellow-300';
    case 'processing':
      return 'inline-flex items-center rounded-full bg-blue-500/20 px-2 py-0.5 text-xs font-medium text-blue-300';
    case 'error':
      return 'inline-flex items-center rounded-full bg-red-500/20 px-2 py-0.5 text-xs font-medium text-red-300';
    default:
      return 'inline-flex items-center rounded-full bg-white/10 px-2 py-0.5 text-xs font-medium text-white/70';
  }
}

export default function AdminDocuments() {
  const [docs, setDocs] = useState<Document[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadForm, setUploadForm] = useState<{ title: string; category_id: string }>({ title: '', category_id: '' });
  const [showUpload, setShowUpload] = useState(false);
  const [reparsingId, setReparsingId] = useState<number | null>(null);
  const [editingDoc, setEditingDoc] = useState<Document | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({ title: '', original_filename: '', category_id: '' });
  const [savingEdit, setSavingEdit] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const reparseFileRef = useRef<HTMLInputElement>(null);
  const reparseTargetRef = useRef<number | null>(null);

  useEffect(() => {
    load();
    api.admin.categories.list().then((r) => setCats(r.data));
  }, [page, catFilter, statusFilter]);

  useEffect(() => {
    if (!successMessage) return;
    const timer = setTimeout(() => setSuccessMessage(null), 4000);
    return () => clearTimeout(timer);
  }, [successMessage]);

  async function load() {
    const params: Record<string, string | number> = { page };
    if (search) params.search = search;
    if (catFilter) params.category_id = catFilter;
    if (statusFilter) params.status = statusFilter;
    const r = await api.admin.documents.list(params);

    let merged = r.data;
    try {
      const ovRes = await fetch('/api/admin/documents/overrides');
      if (ovRes.ok) {
        const ovPayload = await ovRes.json() as {
          data?: Record<string, { title: string; original_filename?: string; category_id: number; category_name?: string }>;
        };
        const overrides = ovPayload.data ?? {};
        merged = r.data.map((doc) => {
          const o = overrides[String(doc.id)];
          if (!o) return doc;
          return {
            ...doc,
            title: o.title,
            original_filename: o.original_filename ?? doc.original_filename,
            category_id: o.category_id,
            category_name: o.category_name ?? doc.category_name,
          };
        });
      }
    } catch {
      // ignore override merge errors
    }

    setDocs(merged);
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
      const res = await api.admin.documents.upload(fd) as {
        message?: string;
        data?: { status?: string; error?: string };
      };
      if (res.data?.status === 'error') {
        alert(res.data.error || res.message || 'Parsing failed. Deploy latest PHP files, then click Re-parse.');
        setUploading(false);
        load();
        return;
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

  function openEdit(doc: Document) {
    const categoryId =
      doc.category_id != null
        ? String(doc.category_id)
        : String(cats.find(c => c.name === doc.category_name)?.id ?? '');

    setEditingDoc(doc);
    setEditForm({
      title: doc.title,
      original_filename: doc.original_filename,
      category_id: categoryId,
    });
  }

  function closeEdit() {
    setEditingDoc(null);
    setEditForm({ title: '', original_filename: '', category_id: '' });
  }

  async function handleSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingDoc || !editForm.title.trim() || !editForm.category_id) return;

    setSavingEdit(true);
    try {
      await api.admin.documents.update(editingDoc.id, {
        title: editForm.title.trim(),
        category_id: Number(editForm.category_id),
        original_filename: editForm.original_filename.trim() || undefined,
        category_name: cats.find((c) => String(c.id) === editForm.category_id)?.name,
      });

      closeEdit();
      load();
      setSuccessMessage('Document updated successfully.');
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Failed to update document');
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this document and all its chunks?')) return;
    await api.admin.documents.delete(id);
    load();
  }

  async function handleReparse(id: number, status?: string) {
    setReparsingId(id);
    try {
      let formData: FormData | undefined;

      if (status === 'error') {
        reparseTargetRef.current = id;
        const picked = await new Promise<File | null>((resolve) => {
          const input = reparseFileRef.current;
          if (!input) {
            resolve(null);
            return;
          }
          input.onchange = () => resolve(input.files?.[0] ?? null);
          input.value = '';
          input.click();
        });

        if (picked) {
          formData = new FormData();
          formData.append('file', picked);
        }
      }

      const res = await api.admin.documents.reparse(id, formData);
      if (res.data?.status === 'error') {
        alert(res.data.error || res.message || 'Re-parse failed');
      }
      load();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Re-parse failed');
    } finally {
      setReparsingId(null);
      reparseTargetRef.current = null;
    }
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-6">
      {successMessage && (
        <div className="mb-4 rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-300">
          {successMessage}
        </div>
      )}
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-xl font-bold text-white">Documents</h1>
          <span className="text-gray-400 text-sm ml-1">{total} total</span>
          <button onClick={() => setShowUpload(!showUpload)} className="btn-primary ml-auto flex items-center gap-2 text-sm">
            <Upload className="w-4 h-4" />Upload document
          </button>
        </div>

        {/* Edit modal */}
        {editingDoc && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
            <div className="card w-full max-w-md p-5">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-semibold text-white text-sm">Edit document</h2>
                <button onClick={closeEdit} className="p-1 text-white/50 hover:text-white rounded">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <form onSubmit={handleSaveEdit} className="space-y-4">
                <div>
                  <label className="text-xs text-white/50 mb-1 block">Document name *</label>
                  <input
                    className="input"
                    required
                    value={editForm.title}
                    onChange={e => setEditForm(p => ({ ...p, title: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="text-xs text-white/50 mb-1 block">File name</label>
                  <input
                    className="input"
                    placeholder="e.g. Manual.pdf"
                    value={editForm.original_filename}
                    onChange={e => setEditForm(p => ({ ...p, original_filename: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="text-xs text-white/50 mb-1 block">Category *</label>
                  <select
                    className="input"
                    required
                    value={editForm.category_id}
                    onChange={e => setEditForm(p => ({ ...p, category_id: e.target.value }))}
                  >
                    <option value="">Select category</option>
                    {cats.map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div className="flex gap-2 pt-1">
                  <button type="submit" className="btn-primary text-sm flex items-center gap-1" disabled={savingEdit}>
                    <Check className="w-4 h-4" />
                    {savingEdit ? 'Saving…' : 'Save changes'}
                  </button>
                  <button type="button" className="btn-secondary text-sm" onClick={closeEdit}>
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Hidden file input for re-parse with local PDF */}
        <input
          ref={reparseFileRef}
          type="file"
          accept=".pdf,.docx"
          className="hidden"
          aria-hidden
        />

        {/* Upload form */}
        {showUpload && (
          <div className="card p-5 mb-6">
            <h2 className="font-semibold text-gray-200 mb-4 text-sm">Upload new document</h2>
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
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Status</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Uploaded</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {docs.map(doc => (
                <tr key={doc.id} className="hover:bg-white/10 hover:shadow-sm">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <FileText className="w-4 h-4 text-gray-400 flex-shrink-0" />
                      <div>
                        <p className="font-medium text-gray-100">{doc.title}</p>
                        <p className="text-xs text-gray-400">{doc.original_filename}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-100">{doc.category_name}</td>
                  <td className="px-4 py-3">
                    <span className={statusBadgeClass(doc.status)}>{formatStatusLabel(doc.status)}</span>
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
                  <td className="px-4 py-3 text-gray-100 text-xs">{new Date(doc.created_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => openEdit(doc)}
                        title="Edit"
                        className="p-1.5 text-gray-100 hover:text-blue-400 hover:bg-blue-500/10 rounded"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleReparse(doc.id, doc.status)}
                        title={doc.status === 'error' ? 'Re-parse (pick PDF file)' : 'Re-parse'}
                        disabled={reparsingId === doc.id}
                        className="p-1.5 text-gray-100 hover:text-blue-600 hover:bg-blue-50 rounded disabled:opacity-50"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${reparsingId === doc.id ? 'animate-spin' : ''}`} />
                      </button>
                      <button onClick={() => handleDelete(doc.id)} title="Delete" className="p-1.5 text-gray-100 hover:text-red-600 hover:bg-red-50 rounded">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!docs.length && (
                <tr><td colSpan={5} className="text-center py-12 text-gray-400 text-sm">No documents found</td></tr>
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
  );
}
