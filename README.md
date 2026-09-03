# Dice Duel

Two players, two dice each, one pot. **Most sixes wins. Equal sixes and you roll again.**

Next.js 16 + Supabase (Postgres, Auth, Realtime). Every roll is provably fair and
independently verifiable in the player's own browser.

---

## The rules, precisely

Your score for a round is **how many sixes you rolled** — 0, 1, or 2.

| Player A | Player B | Outcome |
|---|---|---|
| one six | no sixes | **A wins** |
| double six | one six | **A wins** |
| one six | one six | tie → replay the round |
| no sixes | no sixes | tie → replay the round |
| double six | double six | tie → replay the round |

Non-six faces are irrelevant: `5·5` does **not** beat `1·1`. Both are zero sixes, so it's a tie.

Derived properties, proven in `prototype/test.js` by exhaustive enumeration of all
1,296 dice combinations:

- `P(0 sixes) = 25/36`, `P(1 six) = 10/36`, `P(2 sixes) = 1/36`
- **Tie rate 726/1296 ≈ 56.0%** → about **2.27 rounds per match** on average
- **Each player wins exactly 50%.** Seat order confers no advantage.
- The only house edge is the configured rake (default 2.5% of the pot).

---

## Setup

### 1. Create the database

In your Supabase project → **SQL Editor** → paste and run:

```
supabase/migrations/0001_init.sql          schema, RLS, game engine
supabase/migrations/0002_seal_match_secrets.sql   revoke seed table privileges
supabase/migrations/0003_fix_enum_cast.sql        round_result -> seat cast
supabase/migrations/0004_fix_win_pct.sql          NULL win% on one-sided records
supabase/migrations/0005_queue_race.sql           simultaneous-queue deadlock
```

Run them **in order**. 0002-0005 are fixes found by testing against a live
project; 0001 already contains the 0002/0003 corrections, so a brand new
database still needs 0004 and 0005 but will not be affected by the others.

This creates the tables, RLS policies, the game functions, and turns on Realtime
for `matches`, `match_rounds`, `chat_messages` and `profiles`.

### 2. Point the app at your project

```bash
cd web
cp .env.example .env.local
```

Fill in from **Project Settings → API**:

```
NEXT_PUBLIC_SUPABASE_URL=https://YOUR-REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

> Never add the `service_role` key. It bypasses every RLS policy, and nothing here needs it.

### 3. Auth settings

In **Authentication → URL Configuration**, add `http://localhost:3000/auth/callback`
to the redirect allow-list. For local testing it's easiest to turn **off** "Confirm email"
(Authentication → Providers → Email) so accounts work immediately.

### 4. Run

```bash
npm run dev
```

Open two different browsers (or one normal + one private window) so you have two
real accounts, and queue both at the same stake.

---

## Security model

The browser holds the **anon key**, which anyone can read out of the page source.
That is only safe because the database is built so a hostile client can't do damage:

| Threat | Defence |
|---|---|
| Player rewrites their own balance | No `INSERT`/`UPDATE`/`DELETE` grant on any game table. All mutations go through `SECURITY DEFINER` functions that re-derive the caller from `auth.uid()`. |
| Player reads the seed early and knows the outcome | The server seed lives in `match_secrets` — **RLS on, zero policies**, so PostgREST can never select it. It's copied into `matches.revealed_server_seed` only when the match ends. |
| House picks a favourable seed after seeing the bets | The SHA-256 of the seed is published when the match is created. Reveal + hash check proves it was fixed in advance. |
| Player re-rolls until they win | Both players' dice are computed **when the round is dealt**, before anyone acts. `roll()` takes a `FOR UPDATE` row lock and player B's roll resolves the round in the same transaction. |
| Player spams roll to duplicate rounds | Same transaction + row lock. (This was a real bug in the prototype — see `prototype/test-server.js`, which spams the endpoint deliberately as a regression guard.) |
| Rival reads your bankroll | `profiles` RLS is **own row only**. Usernames/avatars are published via the `public_profiles` view, which has no money columns. |
| Negative balances from a logic bug | `CHECK (balance_cents >= 0)` on `profiles`. A bad path aborts the transaction instead of minting chips. |
| Opponent stalls forever | Every turn carries a 30s `roll_deadline`; the waiting player can call `claim_timeout()` to roll on their behalf. The dice were already committed, so this cannot change the outcome. |
| Infinite tie loop | After 64 tied rounds (p ≈ 1e-16) the match voids and both stakes are refunded. |

Money is stored as **integer cents** everywhere. Rake rounds *down*, so rounding never
costs the player. Every movement writes an append-only `ledger` row.

---

## Provably fair

```
bytes = HMAC_SHA256(key = server_seed,
                    msg = "<clientSeedA>:<clientSeedB>:<round>:<seat>:<counter>")

for each byte:
    if byte >= 252: skip          # 252 = 6 * 42, keeps every face exactly 1/6
    die = (byte % 6) + 1
```

The `>= 252` rejection is not decoration: 256 isn't divisible by 6, so a plain
`byte % 6` would make faces 1–4 measurably likelier than 5–6.

This construction is implemented **three times** and all three must agree:

| Where | File | Purpose |
|---|---|---|
| Postgres | `public.fair_dice()` in the migration | rolls the real dice |
| Browser/TS | `web/src/lib/game.ts` | independent verification |
| Node | `prototype/game.js` | reference implementation with the test suite |

`tests/parity.mjs` proves the TypeScript and Node implementations are byte-identical
across 400 seed/round/seat combinations.

---

## Features

- **Email + password auth** and passwordless email links, via Supabase Auth.
- **Realtime play** — matchmaking, dice reveals, balances and chat all arrive over
  Postgres changes subscriptions. A 3s poll runs *only* while sitting in the lobby,
  as a recovery net for a dropped socket.
- **Quick match** — queue at a stake, get paired with `FOR UPDATE SKIP LOCKED` so two
  simultaneous joins can't claim the same opponent.
- **Private tables** — 6-character invite code from an ambiguity-free alphabet (no O/0, I/1).
- **In-match chat + emotes**, rate limited to 5 messages per 10 seconds server-side.
- **Leaderboard** — win rate, biggest pot, lifetime profit.
- **Match history** with a per-match verify link.
- **Public verifier** at `/verify` — paste any finished match id and recompute every die locally.
- **Faucet** — $25 in play chips every 12 hours, once you're under $5.

## Interface

- **3D dice.** Six faces on a CSS cube. The tumble is choreographed rather than
  simulated: the server has already decided the result, so the animation is
  guaranteed to settle on the right face — several whole revolutions, then a
  decelerating landing with a slight overshoot for weight.
- **3D table backdrop** (`TableBackground.tsx`). three.js, dynamically imported
  so it stays out of the initial bundle. Ivory and brass dice tumbling through
  fog under one warm key light, capped at 40fps, paused when the tab is hidden,
  and skipped entirely under `prefers-reduced-motion`.
- **Visual system** in `globals.css`: a felt-and-brass palette, Instrument Serif
  for display against Inter for UI, lit surfaces (top highlight + long shadow)
  rather than flat cards, and a film-grain overlay.

---

## Tests

```bash
node prototype/test.js          # rules, odds, RNG uniformity, pot math, 100k-match Monte Carlo
node prototype/test-server.js   # end-to-end match over HTTP, incl. roll-spam regression
node --experimental-strip-types tests/parity.mjs   # browser verifier == reference engine
cd web && npx tsc --noEmit && npx next build
```

---

## Layout

```
supabase/migrations/0001_init.sql   schema, RLS, and the whole game engine
web/                                Next.js 16 app (App Router, Tailwind 4)
  src/lib/game.ts                   dice derivation + verifier
  src/lib/supabase/                 browser and server clients
  src/proxy.ts                      session refresh + route guard
  src/components/                   Die, MatchTable, Lobby, Chat, Verifier, AuthPanel
prototype/                          the zero-dependency Node prototype and its tests
tests/parity.mjs                    cross-implementation dice parity
```

---

## Scope

Play chips only. There is no payment rail, no deposit, no withdrawal, and no KYC —
the chips are issued by the app and have no cash value.

Turning this into real-money wagering is not a code change. In most jurisdictions
peer-to-peer betting requires a gambling licence, verified identity and age checks,
AML monitoring, segregated player funds, and per-territory geoblocking, and app
stores and payment processors enforce their own rules on top. Get that advice before
wiring up a payment provider, not after.
