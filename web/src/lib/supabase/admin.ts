import 'server-only';
import { createClient } from '@supabase/supabase-js';

/**
 * Service-role Supabase client.
 *
 * This key BYPASSES EVERY RLS POLICY. It exists for exactly one reason: the
 * settlement functions (credit_deposit, mark_withdrawal_sent,
 * settle_withdrawal) are revoked from `authenticated` on purpose, because a
 * player who could call settle_withdrawal could mark their own successful
 * payout as failed and be refunded money they already have.
 *
 * Rules for this file:
 *   - `server-only` makes importing it from a client component a build error.
 *   - It is used ONLY inside route handlers under /api, never in a page or
 *     component, and never to serve data the user could have read themselves
 *     through their own session.
 *   - Every handler that uses it re-derives the acting user from their own
 *     session first. The service key authorises the WRITE; it never decides
 *     WHO is asking.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. ' +
        'The service role key is required for payment settlement and must be set ' +
        'server-side only — never with a NEXT_PUBLIC_ prefix.',
    );
  }

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
