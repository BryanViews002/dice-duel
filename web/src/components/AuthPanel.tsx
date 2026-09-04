'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { createClient } from '@/lib/supabase/client';

type Mode = 'signup' | 'signin' | 'magic';

const TABS: { id: Mode; label: string }[] = [
  { id: 'signup', label: 'Join' },
  { id: 'signin', label: 'Sign in' },
  { id: 'magic', label: 'Email link' },
];

export function AuthPanel({ next }: { next: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('signup');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const supabase = createClient();

    try {
      if (mode === 'magic') {
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: {
            emailRedirectTo: `${location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
          },
        });
        if (error) throw error;
        setNotice('Check your inbox for a sign-in link.');
      } else if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { username: username.trim() } },
        });
        if (error) throw error;
        if (!data.session) setNotice('Account created. Confirm your email, then sign in.');
        else { router.push(next as never); router.refresh(); }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push(next as never);
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  const field =
    'w-full rounded-lg border border-felt-700 bg-felt-950/60 px-3.5 py-2.5 text-[15px] ' +
    'outline-none transition-colors placeholder:text-ivory-dim/25 focus:border-brass-500/70';

  return (
    <div className="surface p-7">
      <h2 className="display mb-1 text-[26px]">Take a seat</h2>
      <p className="mb-6 text-[13px] text-ivory-dim/70">
        {mode === 'signup'
          ? 'Free to join. Fund your balance when you are ready to play.'
          : mode === 'signin'
            ? 'Welcome back to the table.'
            : "We'll email you a link — no password needed."}
      </p>

      <div className="mb-6 flex gap-5 border-b border-felt-800">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => { setMode(t.id); setError(null); setNotice(null); }}
            className={`relative -mb-px pb-2.5 text-[13px] transition-colors ${
              mode === t.id ? 'text-ivory' : 'text-ivory-dim/50 hover:text-ivory-dim'
            }`}
          >
            {t.label}
            {mode === t.id && (
              <motion.span
                layoutId="auth-underline"
                className="absolute inset-x-0 -bottom-px h-px bg-brass-400"
                transition={{ type: 'spring', stiffness: 500, damping: 40 }}
              />
            )}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="space-y-4">
        <AnimatePresence initial={false}>
          {mode === 'signup' && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <label className="eyebrow mb-2 block" htmlFor="username">Table name</label>
              <input
                id="username" value={username} onChange={(e) => setUsername(e.target.value)}
                placeholder="how rivals see you" minLength={3} maxLength={20} required
                className={field}
              />
            </motion.div>
          )}
        </AnimatePresence>

        <div>
          <label className="eyebrow mb-2 block" htmlFor="email">Email</label>
          <input
            id="email" type="email" autoComplete="email" value={email}
            onChange={(e) => setEmail(e.target.value)} required className={field}
          />
        </div>

        {mode !== 'magic' && (
          <div>
            <label className="eyebrow mb-2 block" htmlFor="password">Password</label>
            <input
              id="password" type="password" value={password}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              onChange={(e) => setPassword(e.target.value)} minLength={8} required
              className={field}
            />
          </div>
        )}

        {error && (
          <p className="rounded-lg border border-oxblood/35 bg-oxblood/10 px-3.5 py-2.5 text-[13px] text-oxblood">
            {error}
          </p>
        )}
        {notice && (
          <p className="rounded-lg border border-jade/35 bg-jade/10 px-3.5 py-2.5 text-[13px] text-jade">
            {notice}
          </p>
        )}

        <button
          type="submit" disabled={busy}
          className="btn-brass hover:btn-brass-hover w-full py-3 text-[15px] active:translate-y-px disabled:opacity-45"
        >
          {busy ? 'One moment…'
            : mode === 'signup' ? 'Join the table'
            : mode === 'signin' ? 'Sign in'
            : 'Send the link'}
        </button>
      </form>
    </div>
  );
}
