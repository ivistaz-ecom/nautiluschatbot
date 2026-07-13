'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';

export default function HomePage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (user?.role === 'admin') {
      router.replace('/admin');
      return;
    }
    if (user) {
      router.replace('/chat');
      return;
    }
    router.replace('/login');
  }, [user, loading, router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-brand">
      <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
