'use client';

import { avatarColors } from '@/lib/format';

/**
 * Deterministic identity badge. The same seed always renders the same disc, so
 * a player is recognisable across the table, the standings and their history.
 * Struck-metal treatment rather than a flat colour circle.
 */
export function Avatar({
  seed,
  name,
  size = 40,
}: {
  seed: string;
  name: string;
  size?: number;
}) {
  const [from, to] = avatarColors(seed || name);
  return (
    <span
      className="relative inline-grid shrink-0 place-items-center rounded-full font-semibold text-felt-950"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.36,
        letterSpacing: '0.02em',
        background: `linear-gradient(145deg, ${from}, ${to})`,
        boxShadow:
          'inset 0 1px 0 rgba(255,255,255,.45), inset 0 -1px 2px rgba(0,0,0,.3), 0 2px 6px -2px rgba(0,0,0,.6)',
      }}
      aria-hidden
    >
      {name.slice(0, 2).toUpperCase()}
    </span>
  );
}
