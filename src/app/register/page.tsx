'use client';
import { useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { User, Mail, Lock, CheckCircle, AlertCircle } from 'lucide-react';
import { Logo } from '@/components/Logo';

export default function RegisterPage() {
  const [name, setName]         = useState('');
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [done, setDone]         = useState(false);
  const [loading, setLoading]   = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.auth.register(name, email, password);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Registration failed');
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="min-h-screen bg-brand flex items-center justify-center p-4">
        <div className="card p-8 max-w-md w-full text-center">
          <CheckCircle className="w-12 h-12 text-green-400 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-white mb-2">Check your email</h2>
          <p className="text-white/60 text-sm">We sent a verification link to <strong className="text-white">{email}</strong>. Click it to activate your account.</p>
          <Link href="/login" className="btn-primary inline-block mt-6">Go to login</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-brand flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="flex justify-center mb-8">
          <Logo size="lg" />
        </div>

        <div className="card p-8">
          <h2 className="text-lg font-semibold text-white mb-6">Create account</h2>

          {error && (
            <div className="flex items-center gap-2 bg-red-500/10 text-red-300 border border-red-500/30 rounded-lg px-4 py-3 mb-4 text-sm">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />{error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-white/80 mb-1">Full name</label>
              <div className="relative">
                <User className="absolute left-3 top-2.5 w-4 h-4 text-white/40" />
                <input type="text" required className="input pl-9" placeholder="Jane Smith"
                  value={name} onChange={e => setName(e.target.value)} />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-white/80 mb-1">Email address</label>
              <div className="relative">
                <Mail className="absolute left-3 top-2.5 w-4 h-4 text-white/40" />
                <input type="email" required className="input pl-9" placeholder="you@company.com"
                  value={email} onChange={e => setEmail(e.target.value)} />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-white/80 mb-1">Password <span className="text-white/40 font-normal">(min. 8 chars)</span></label>
              <div className="relative">
                <Lock className="absolute left-3 top-2.5 w-4 h-4 text-white/40" />
                <input type="password" required minLength={8} className="input pl-9" placeholder="••••••••"
                  value={password} onChange={e => setPassword(e.target.value)} />
              </div>
            </div>

            <button type="submit" className="btn-primary w-full" disabled={loading}>
              {loading ? 'Creating account…' : 'Create account'}
            </button>
          </form>

          <p className="text-center text-sm text-white/50 mt-6">
            Already have an account?{' '}
            <Link href="/login" className="text-brand-accent font-medium hover:underline">Sign in</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
