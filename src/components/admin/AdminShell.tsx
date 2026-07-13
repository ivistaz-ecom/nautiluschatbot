'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  Users,
  MessageSquare,
  FileText,
  TrendingUp,
  Shield,
  FolderOpen,
  LogOut,
  HelpCircle,
} from 'lucide-react';
import { Logo } from '@/components/Logo';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';

const navLinks = [
  { href: '/admin', label: 'Dashboard', icon: TrendingUp, exact: true },
  { href: '/admin/documents', label: 'Documents', icon: FileText },
  { href: '/admin/categories', label: 'Categories', icon: FolderOpen },
  { href: '/admin/users', label: 'Users', icon: Users },
  { href: '/admin/whitelist', label: 'URL Whitelist', icon: Shield },
  { href: '/admin/queries', label: 'Unanswered', icon: HelpCircle, badgeKey: 'unanswered' as const },
  { href: '/admin/questions', label: 'All Questions', icon: MessageSquare },
];

function isActive(href: string, pathname: string, exact?: boolean) {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { logout } = useAuth();
  const [openQueries, setOpenQueries] = useState<number | undefined>();

  useEffect(() => {
    api.admin.metrics()
      .then((r) => setOpenQueries(r.data.unanswered_open))
      .catch(() => {});
  }, [pathname]);

  return (
    <div className="flex h-screen bg-brand">
      <aside className="w-60 bg-brand border-r border-white/10 flex flex-col flex-shrink-0">
        <div className="px-4 py-5 border-b border-white/10">
          <Logo size="sm" />
          <p className="text-white/50 text-xs mt-1 pl-1">Admin Panel</p>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {navLinks.map(({ href, label, icon: Icon, exact, badgeKey }) => {
            const active = isActive(href, pathname, exact);
            const badge = badgeKey === 'unanswered' ? openQueries : undefined;

            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors group ${
                  active
                    ? 'bg-white/15 text-white'
                    : 'text-white/70 hover:bg-white/10 hover:text-white'
                }`}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                <span className="flex-1">{label}</span>
                {badge ? (
                  <span className="bg-red-500 text-white text-xs px-1.5 py-0.5 rounded-full min-w-[20px] text-center">
                    {badge}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>

        <div className="px-3 py-4 border-t border-white/10">
          <Link
            href="/chat"
            className="flex items-center gap-3 px-3 py-2 text-white/70 hover:bg-white/10 rounded-lg text-sm"
          >
            <MessageSquare className="w-4 h-4" />
            User chat
          </Link>
          <button
            onClick={logout}
            className="flex items-center gap-3 px-3 py-2 text-white/70 hover:bg-white/10 rounded-lg text-sm w-full"
          >
            <LogOut className="w-4 h-4" />
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
