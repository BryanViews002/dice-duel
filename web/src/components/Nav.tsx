'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { createClient } from '@/lib/supabase/client';
import { money } from '@/lib/format';
import { Avatar } from './Avatar';

const LINKS = [
  { href: '/dashboard', label: 'Home' },
  { href: '/play', label: 'Table' },
  { href: '/leaderboard', label: 'Standings' },
  { href: '/history', label: 'History' },
  { href: '/wallet', label: 'Wallet' },
  { href: '/verify', label: 'Verify' },
] as const;

export function Nav({
  username,
  avatarSeed,
  balanceKobo,
  isAdmin = false,
}: {
  username: string | null;
  avatarSeed: string | null;
  balanceKobo: number | null;
  isAdmin?: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();

  // The nav is rendered on the server, so without this the balance only moved
  // on navigation. Subscribing here means a stake, a win, a deposit or a payout
  // updates the number in place on every page.
  const [balance, setBalance] = useState(balanceKobo);
  useEffect(() => setBalance(balanceKobo), [balanceKobo]);

  useEffect(() => {
    if (balanceKobo === null) return;
    const supabase = createClient();
    const channel = supabase
      .channel('nav-balance')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, (payload) => {
        const next = payload.new as { balance_kobo?: number };
        // RLS means only our own row ever reaches us here.
        if (typeof next.balance_kobo === 'number') setBalance(next.balance_kobo);
      })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [balanceKobo]);

  async function signOut() {
    await createClient().auth.signOut();
    router.push('/');
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-40 border-b border-felt-800/80 bg-felt-950/72 backdrop-blur-xl">
      <div className="mx-auto flex h-[62px] max-w-6xl items-center gap-8 px-6">
        <Link href="/" className="group flex items-baseline gap-2.5">
          <span className="display text-[19px] tracking-tight">Dice&nbsp;Duel</span>
          <span className="hidden h-1 w-1 rounded-full bg-brass-500 sm:block" />
        </Link>

        <nav className="flex items-center gap-0.5 text-[13.5px]">
          {[...LINKS, ...(isAdmin ? [{ href: '/admin/payouts', label: 'Payouts' } as const] : [])].map((l) => {
            const active = pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`relative rounded-lg px-3 py-1.5 transition-colors ${
                  active ? 'text-ivory' : 'text-ivory-dim/65 hover:text-ivory'
                }`}
              >
                {active && (
                  <motion.span
                    layoutId="nav-active"
                    className="absolute inset-x-2 -bottom-[19px] h-px bg-brass-400"
                    transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                  />
                )}
                {l.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-4">
          {balance !== null && (
            <div className="text-right leading-none">
              <div className="money text-[19px] font-semibold">{money(balance)}</div>
              <div className="eyebrow mt-1 text-[9.5px]">balance</div>
            </div>
          )}
          {username && (
            <div className="flex items-center gap-2.5 border-l border-felt-800 pl-4">
              <Avatar seed={avatarSeed ?? username} name={username} size={30} />
              <button
                onClick={signOut}
                className="text-xs text-ivory-dim/50 transition-colors hover:text-oxblood"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
