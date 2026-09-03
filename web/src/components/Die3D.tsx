'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * A real 3D die.
 *
 * Six faces on a CSS cube (`transform-style: preserve-3d`) rather than a canvas,
 * because the landing face has to be exact: the server already decided the
 * result, so the animation must be guaranteed to settle showing that number.
 * A physics simulation would only approximate it.
 *
 * The tumble is therefore choreographed, not simulated — several whole
 * revolutions on two axes, then a decelerating settle onto the target face with
 * a small overshoot so it reads as weight rather than a slideshow.
 */

// Opposite faces sum to 7, as on a real die.
const FACE_ROTATION: Record<number, { x: number; y: number }> = {
  1: { x: 0, y: 0 },
  6: { x: 0, y: 180 },
  3: { x: 0, y: -90 },
  4: { x: 0, y: 90 },
  5: { x: -90, y: 0 },
  2: { x: 90, y: 0 },
};

// Pip grid positions, in units of the face (0..1) on a 3x3 layout.
const PIPS: Record<number, [number, number][]> = {
  1: [[0.5, 0.5]],
  2: [[0.25, 0.25], [0.75, 0.75]],
  3: [[0.25, 0.25], [0.5, 0.5], [0.75, 0.75]],
  4: [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]],
  5: [[0.25, 0.25], [0.75, 0.25], [0.5, 0.5], [0.25, 0.75], [0.75, 0.75]],
  6: [[0.25, 0.22], [0.75, 0.22], [0.25, 0.5], [0.75, 0.5], [0.25, 0.78], [0.75, 0.78]],
};

const FACES: { value: number; transform: (h: number) => string }[] = [
  { value: 1, transform: (h) => `translateZ(${h}px)` },
  { value: 6, transform: (h) => `rotateY(180deg) translateZ(${h}px)` },
  { value: 3, transform: (h) => `rotateY(90deg) translateZ(${h}px)` },
  { value: 4, transform: (h) => `rotateY(-90deg) translateZ(${h}px)` },
  { value: 5, transform: (h) => `rotateX(90deg) translateZ(${h}px)` },
  { value: 2, transform: (h) => `rotateX(-90deg) translateZ(${h}px)` },
];

const SIZES = { sm: 26, md: 44, lg: 66 } as const;

export function Die3D({
  value,
  size = 'lg',
  delay = 0,
  idle = false,
}: {
  value: number | null;
  size?: keyof typeof SIZES;
  /** Stagger, so a pair doesn't land in lockstep. */
  delay?: number;
  /** Slow hover-tumble for the empty state, before a roll exists. */
  idle?: boolean;
}) {
  const px = SIZES[size];
  const half = px / 2;
  const [rot, setRot] = useState({ x: -24, y: 18 });
  const [settling, setSettling] = useState(false);
  const spins = useRef(0);
  const prev = useRef<number | null>(null);

  useEffect(() => {
    if (value == null) {
      prev.current = null;
      return;
    }
    if (value === prev.current) return;
    prev.current = value;

    const target = FACE_ROTATION[value];
    spins.current += 1;

    // Whole revolutions keep the landing face correct; the odd tilt on the way
    // makes two dice in a pair look independent rather than cloned.
    const turns = 2 + (spins.current % 2);
    const wobble = ((spins.current * 37) % 15) - 7;

    setSettling(true);
    const id = window.setTimeout(() => {
      setRot({
        x: target.x - 360 * turns,
        y: target.y + 360 * turns + wobble * 0.15,
      });
    }, delay);

    const done = window.setTimeout(() => setSettling(false), delay + 1150);
    return () => {
      window.clearTimeout(id);
      window.clearTimeout(done);
    };
  }, [value, delay]);

  const isSix = value === 6;
  const empty = value == null;

  return (
    <div
      className="relative"
      style={{ width: px, height: px, perspective: px * 6 }}
      role="img"
      aria-label={empty ? 'not yet rolled' : `die showing ${value}`}
    >
      <div
        className={idle && empty ? 'animate-drift' : undefined}
        style={{
          width: px,
          height: px,
          transformStyle: 'preserve-3d',
          transform: `rotateX(${rot.x}deg) rotateY(${rot.y}deg)`,
          // A long decelerating curve with a touch of overshoot at the end.
          transition: settling
            ? 'transform 1.15s cubic-bezier(0.13, 0.9, 0.16, 1.02)'
            : 'transform 0.6s ease-out',
        }}
      >
        {FACES.map((face) => (
          <div
            key={face.value}
            className="absolute inset-0 rounded-[18%]"
            style={{
              transform: face.transform(half),
              backfaceVisibility: 'hidden',
              background: empty
                ? 'linear-gradient(150deg, #16241d, #0d1712)'
                : isSix
                  ? 'linear-gradient(150deg, #f6e3ad 0%, #dfb85c 45%, #a2801b 100%)'
                  : 'linear-gradient(150deg, #fbf8f0 0%, #e6e0d1 45%, #c3bcab 100%)',
              border: empty ? '1px dashed rgba(237,232,220,.18)' : '1px solid rgba(0,0,0,.16)',
              boxShadow: empty
                ? 'none'
                : 'inset 0 1px 2px rgba(255,255,255,.7), inset 0 -2px 6px rgba(0,0,0,.18)',
            }}
          >
            {!empty &&
              PIPS[face.value].map(([px_, py], i) => (
                <span
                  key={i}
                  className="absolute rounded-full"
                  style={{
                    left: `${px_ * 100}%`,
                    top: `${py * 100}%`,
                    width: Math.max(3, px * 0.17),
                    height: Math.max(3, px * 0.17),
                    transform: 'translate(-50%, -50%)',
                    background: isSix
                      ? 'radial-gradient(circle at 35% 30%, #3a2c07, #140f02)'
                      : 'radial-gradient(circle at 35% 30%, #3b3a35, #121210)',
                    boxShadow: 'inset 0 1px 1px rgba(255,255,255,.25), 0 0.5px 0 rgba(255,255,255,.35)',
                  }}
                />
              ))}
          </div>
        ))}
      </div>

      {/* Contact shadow — sells the die as sitting on the felt. */}
      {!empty && (
        <div
          className="pointer-events-none absolute left-1/2 -z-10 rounded-[50%] blur-[6px]"
          style={{
            width: px * 0.9,
            height: px * 0.22,
            bottom: -px * 0.16,
            transform: 'translateX(-50%)',
            background: isSix ? 'rgba(201,162,39,.35)' : 'rgba(0,0,0,.55)',
          }}
        />
      )}
    </div>
  );
}

/** A player's pair, staggered so they settle a beat apart. */
export function DicePair({
  dice,
  size = 'lg',
  idle,
}: {
  dice: number[] | null;
  size?: keyof typeof SIZES;
  idle?: boolean;
}) {
  const pair = dice ?? [null, null];
  return (
    <div className="flex items-end justify-center gap-4">
      {pair.map((d, i) => (
        <Die3D key={i} value={d} size={size} delay={i * 130} idle={idle} />
      ))}
    </div>
  );
}
