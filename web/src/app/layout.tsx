import type { Metadata } from 'next';
import Link from 'next/link';
import { Inter, Instrument_Serif, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';
import { Nav } from '@/components/Nav';
import { createClient } from '@/lib/supabase/server';

// A high-contrast serif carries the display voice; the sans stays invisible and
// does the UI work. Numbers get a mono with real character for seeds and codes.
const inter = Inter({ variable: '--font-inter', subsets: ['latin'] });
const instrument = Instrument_Serif({
  variable: '--font-instrument',
  subsets: ['latin'],
  weight: '400',
});
const plexMono = IBM_Plex_Mono({
  variable: '--font-plex-mono',
  subsets: ['latin'],
  weight: ['400', '500'],
});

export const metadata: Metadata = {
  title: 'Dice Duel',
  description:
    'Two players, two dice each, one pot. Most sixes wins — equal sixes and you roll again. Provably fair.',
};

export default async function RootLayout({ children }: LayoutProps<'/'>) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const { data: profile } = user
    ? await supabase
        .from('profiles')
        .select('username, avatar_seed, balance_kobo, is_admin')
        .eq('id', user.id)
        .maybeSingle()
    : { data: null };

  return (
    <html
      lang="en"
      className={`${inter.variable} ${instrument.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        {user && (
          <Nav
            username={profile?.username ?? null}
            avatarSeed={profile?.avatar_seed ?? null}
            balanceKobo={profile?.balance_kobo ?? null}
            isAdmin={profile?.is_admin ?? false}
          />
        )}
        <main className="flex-1">{children}</main>
        <footer className="mt-16 border-t border-felt-800/70 px-6 py-8">
          <div className="mx-auto max-w-6xl space-y-4">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
              <Link href="/responsible" className="text-brass-300/90 transition-colors hover:text-brass-200">
                Responsible play
              </Link>
              <Link href="/legal/terms" className="text-ivory-dim/60 transition-colors hover:text-ivory">
                Terms
              </Link>
              <Link href="/legal/privacy" className="text-ivory-dim/60 transition-colors hover:text-ivory">
                Privacy
              </Link>
              <Link href="/legal/complaints" className="text-ivory-dim/60 transition-colors hover:text-ivory">
                Complaints
              </Link>
              <Link href="/verify" className="text-ivory-dim/60 transition-colors hover:text-ivory">
                Verify a match
              </Link>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-ivory-dim/45">
              <span>
                <span className="mr-2 rounded border border-ivory-dim/30 px-1.5 py-0.5 font-semibold">18+</span>
                Licensed real-money gaming. Play with money you can afford to lose.
              </span>
              <span>
                Support:{' '}
                <a href="tel:+2348062106493" className="underline-offset-4 hover:underline">
                  0806 210 6493
                </a>
              </span>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
