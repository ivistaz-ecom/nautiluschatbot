'use client';
import { useState, useEffect } from 'react';
import { api, User } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft, Users, Search, UserCheck, UserX } from 'lucide-react';

export default function AdminUsers() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [users, setUsers]   = useState<User[]>([]);
  const [total, setTotal]   = useState(0);
  const [page, setPage]     = useState(1);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');

  useEffect(() => {
    if (!loading && (!user || user.role !== 'admin')) router.push('/login');
  }, [user, loading, router]);

  useEffect(() => {
    if (user?.role === 'admin') load();
  }, [user, page, roleFilter]);

  async function load() {
    const params: Record<string, string | number> = { page };
    if (search) params.search = search;
    if (roleFilter) params.role = roleFilter;
    const r = await api.admin.users.list(params);
    setUsers(r.data);
    setTotal(r.meta.total);
  }

  async function handleToggle(id: number) {
    await api.admin.users.toggle(id);
    load();
  }

  return (
    <div className="min-h-screen bg-brand">
      <div className="max-w-5xl mx-auto px-6 py-6">
        <div className="flex items-center gap-3 mb-6">
          <Link href="/admin" className="text-gray-400 hover:text-gray-600"><ChevronLeft className="w-5 h-5" /></Link>
          <Users className="w-5 h-5 text-[#1B4F8A]" />
          <h1 className="text-xl font-bold text-gray-900">Users</h1>
          <span className="text-gray-400 text-sm ml-1">{total} total</span>
        </div>

        {/* Filters */}
        <div className="flex gap-3 mb-4">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
            <input className="input pl-9 text-sm" placeholder="Search name or email…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && load()} />
          </div>
          <select className="input text-sm w-32" value={roleFilter} onChange={e => { setRoleFilter(e.target.value); setPage(1); }}>
            <option value="">All roles</option>
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </div>

        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">User</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Role</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Verified</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Joined</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map(u => (
                <tr key={u.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 bg-[#D5E8F4] rounded-full flex items-center justify-center text-[#1B4F8A] text-xs font-bold flex-shrink-0">
                        {u.name[0]}
                      </div>
                      <div>
                        <p className="font-medium text-gray-900">{u.name}</p>
                        <p className="text-xs text-gray-400">{u.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${u.role === 'admin' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-600'}`}>
                      {u.role}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {u.email_verified_at
                      ? <span className="text-green-600 text-xs">Verified</span>
                      : <span className="text-amber-600 text-xs">Pending</span>}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-400">
                    {u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${u.is_active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                      {u.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <button onClick={() => handleToggle(u.id)}
                      className={`p-1.5 rounded transition-colors ${u.is_active ? 'text-gray-400 hover:text-red-600 hover:bg-red-50' : 'text-gray-400 hover:text-green-600 hover:bg-green-50'}`}
                      title={u.is_active ? 'Deactivate' : 'Activate'}>
                      {u.is_active ? <UserX className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
                    </button>
                  </td>
                </tr>
              ))}
              {!users.length && <tr><td colSpan={6} className="text-center py-12 text-gray-400 text-sm">No users found</td></tr>}
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
    </div>
  );
}
