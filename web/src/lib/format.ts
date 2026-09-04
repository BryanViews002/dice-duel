/**
 * Money formatting. Everything in this app is NGN, stored as integer KOBO.
 *
 * 1 naira = 100 kobo. Never use floats for money, and never divide by 100
 * outside of here and flutterwave.ts's koboToNaira() — those are the only two
 * places a unit conversion is allowed to exist.
 */

const NGN = new Intl.NumberFormat('en-NG', {
  style: 'currency',
  currency: 'NGN',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** ₦12,500.00 */
export const money = (kobo: number | null | undefined): string =>
  NGN.format((kobo ?? 0) / 100);

/** ₦12,500 — drops the kobo when it is a whole number of naira. */
export const moneyShort = (kobo: number | null | undefined): string => {
  const k = kobo ?? 0;
  return k % 100 === 0
    ? new Intl.NumberFormat('en-NG', {
        style: 'currency', currency: 'NGN', maximumFractionDigits: 0,
      }).format(k / 100)
    : money(k);
};

export const signedMoney = (kobo: number): string =>
  `${kobo >= 0 ? '+' : '−'}${money(Math.abs(kobo))}`;

/** Parse a typed naira amount ("2,500.50") into kobo. Returns null if invalid. */
export function nairaInputToKobo(input: string): number | null {
  const cleaned = input.replace(/[₦,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

export function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Deterministic avatar colours from a seed. Hues are pulled toward the brass /
 * jade / clay end of the wheel rather than spread over the full 360, so a table
 * of avatars still reads as one palette instead of a bag of highlighters.
 */
export function avatarColors(seed: string): [string, string] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const anchors = [38, 96, 168, 14, 268, 208];
  const base = anchors[h % anchors.length] + ((h >> 5) % 18) - 9;
  const sat = 34 + ((h >> 9) % 22);
  return [
    `hsl(${base} ${sat + 14}% 62%)`,
    `hsl(${(base + 22) % 360} ${sat}% 40%)`,
  ];
}

/**
 * Table stakes, in kobo: ₦2,000 · ₦5,000 · ₦10,000 · ₦50,000 · ₦200,000 · ₦1,000,000
 *
 * Each player posts the stake, so the smallest pot is ₦4,000. The floor matches
 * the ₦2,000 minimum deposit — the smallest deposit buys exactly one match at
 * the smallest table — and the ceiling matches the ₦1,000,000 deposit limit.
 *
 * These are also bounded in the database (platform_settings.min_stake_kobo /
 * max_stake_kobo). The buttons are a convenience; the bounds are the rule.
 */
export const STAKES = [200_000, 500_000, 1_000_000, 5_000_000, 20_000_000, 100_000_000] as const;

/** Quick-pick deposit amounts, in kobo. Lowest equals the ₦2,000 minimum. */
export const DEPOSIT_PRESETS = [200_000, 500_000, 1_000_000, 5_000_000, 20_000_000] as const;
