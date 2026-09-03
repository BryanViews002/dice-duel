'use client';

import { createBrowserClient } from '@supabase/ssr';

/**
 * Browser Supabase client.
 *
 * This carries the ANON key, which is public by design - anyone can read it out
 * of the page source. That is safe here only because the database grants no
 * write access to any game table; every mutation goes through a SECURITY
 * DEFINER function that re-checks who you are. Never put the service_role key
 * in anything under src/ - it bypasses RLS entirely.
 */
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. ' +
        'Copy .env.example to .env.local and fill both in.',
    );
  }

  return createBrowserClient(url, key);
}
