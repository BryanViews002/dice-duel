'use client';

import { useEffect, useRef } from 'react';
// Types only — the runtime module is imported dynamically below so three
// stays out of the initial bundle.
import type { Euler, Vector3, Group } from 'three';

/**
 * Ambient 3D backdrop for the table: ivory dice tumbling slowly through a dark
 * volume, lit by a single warm key light from above — the same lamp the CSS
 * vignette implies.
 *
 * Deliberately restrained. It sits at -z behind the whole dashboard, runs at a
 * low frame budget, fades out toward the centre so it never fights the content
 * for attention, and stops entirely when the tab is hidden or the user has
 * asked for reduced motion.
 *
 * three is imported dynamically so its ~600KB stays out of the initial bundle.
 */
export function TableBackground({ intensity = 1 }: { intensity?: number }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;

    let disposed = false;
    let cleanup: (() => void) | undefined;

    (async () => {
      const THREE = await import('three');
      if (disposed || !host.current) return;

      const scene = new THREE.Scene();
      scene.fog = new THREE.FogExp2(0x070f0c, 0.028);

      const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
      camera.position.set(0, 0, 16);

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
      renderer.setClearColor(0x000000, 0);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
      host.current.appendChild(renderer.domElement);

      // --- lighting: one warm key from above, cool fill, faint brass rim ---
      scene.add(new THREE.AmbientLight(0x3d5a4a, 1.9));
      const key = new THREE.DirectionalLight(0xffe2a3, 3.6);
      key.position.set(3, 9, 6);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0xc9a227, 1.7);
      rim.position.set(-6, -2, -4);
      scene.add(rim);

      // --- dice ---------------------------------------------------------
      // Pip positions per face on a unit face, opposite faces summing to 7.
      const pipLayout: Record<number, [number, number][]> = {
        1: [[0, 0]],
        2: [[-0.26, -0.26], [0.26, 0.26]],
        3: [[-0.26, -0.26], [0, 0], [0.26, 0.26]],
        4: [[-0.26, -0.26], [0.26, -0.26], [-0.26, 0.26], [0.26, 0.26]],
        5: [[-0.26, -0.26], [0.26, -0.26], [0, 0], [-0.26, 0.26], [0.26, 0.26]],
        6: [[-0.26, -0.28], [0.26, -0.28], [-0.26, 0], [0.26, 0], [-0.26, 0.28], [0.26, 0.28]],
      };
      // face index -> [value, rotation applied to the pip plane]
      const faceSpec: [number, Euler, Vector3][] = [
        [3, new THREE.Euler(0, Math.PI / 2, 0), new THREE.Vector3(0.5, 0, 0)],
        [4, new THREE.Euler(0, -Math.PI / 2, 0), new THREE.Vector3(-0.5, 0, 0)],
        [5, new THREE.Euler(-Math.PI / 2, 0, 0), new THREE.Vector3(0, 0.5, 0)],
        [2, new THREE.Euler(Math.PI / 2, 0, 0), new THREE.Vector3(0, -0.5, 0)],
        [1, new THREE.Euler(0, 0, 0), new THREE.Vector3(0, 0, 0.5)],
        [6, new THREE.Euler(0, Math.PI, 0), new THREE.Vector3(0, 0, -0.5)],
      ];

      const bodyMat = new THREE.MeshStandardMaterial({
        color: 0xf1ece0, roughness: 0.42, metalness: 0.03,
      });
      const brassMat = new THREE.MeshStandardMaterial({
        color: 0xd8b45a, roughness: 0.3, metalness: 0.65,
      });
      const pipMat = new THREE.MeshStandardMaterial({ color: 0x14120d, roughness: 0.6 });

      const pipGeo = new THREE.CircleGeometry(0.075, 14);
      const cubeGeo = new THREE.BoxGeometry(1, 1, 1);

      function makeDie(brass: boolean) {
        const g = new THREE.Group();
        g.add(new THREE.Mesh(cubeGeo, brass ? brassMat : bodyMat));
        for (const [value, euler, offset] of faceSpec) {
          for (const [u, v] of pipLayout[value]) {
            const pip = new THREE.Mesh(pipGeo, pipMat);
            pip.rotation.copy(euler);
            // Place on the face plane, nudged out to avoid z-fighting.
            const local = new THREE.Vector3(u, v, 0.001).applyEuler(euler);
            pip.position.copy(offset.clone().multiplyScalar(1.002)).add(local);
            g.add(pip);
          }
        }
        return g;
      }

      type Floater = {
        group: Group;
        spin: Vector3;
        bobPhase: number;
        bobAmp: number;
        baseY: number;
      };

      const dice: Floater[] = [];
      const COUNT = 11;
      for (let i = 0; i < COUNT; i++) {
        const brass = i % 5 === 0;
        const g = makeDie(brass);
        const scale = 0.55 + Math.random() * 1.15;
        g.scale.setScalar(scale);
        g.position.set(
          (Math.random() - 0.5) * 26,
          (Math.random() - 0.5) * 15,
          -1 - Math.random() * 11,
        );
        g.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
        scene.add(g);
        dice.push({
          group: g,
          spin: new THREE.Vector3(
            (Math.random() - 0.5) * 0.13,
            (Math.random() - 0.5) * 0.13,
            (Math.random() - 0.5) * 0.09,
          ),
          bobPhase: Math.random() * Math.PI * 2,
          bobAmp: 0.25 + Math.random() * 0.5,
          baseY: g.position.y,
        });
      }

      // --- sizing ---------------------------------------------------------
      const resize = () => {
        const w = el.clientWidth || window.innerWidth;
        const h = el.clientHeight || window.innerHeight;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(el);

      // --- parallax: the scene leans very slightly toward the pointer -----
      const pointer = { x: 0, y: 0 };
      const onPointer = (e: PointerEvent) => {
        pointer.x = (e.clientX / window.innerWidth - 0.5) * 2;
        pointer.y = (e.clientY / window.innerHeight - 0.5) * 2;
      };
      window.addEventListener('pointermove', onPointer, { passive: true });

      // --- loop, capped at ~40fps; this is wallpaper, not gameplay --------
      let raf = 0;
      let last = 0;
      let running = true;
      const FRAME = 1000 / 40;
      const clock = new THREE.Clock();

      const tick = (t: number) => {
        raf = requestAnimationFrame(tick);
        if (!running || t - last < FRAME) return;
        last = t;

        const time = clock.getElapsedTime();
        for (const d of dice) {
          d.group.rotation.x += d.spin.x * 0.05;
          d.group.rotation.y += d.spin.y * 0.05;
          d.group.rotation.z += d.spin.z * 0.05;
          d.group.position.y = d.baseY + Math.sin(time * 0.35 + d.bobPhase) * d.bobAmp;
        }
        camera.position.x += (pointer.x * 1.1 - camera.position.x) * 0.02;
        camera.position.y += (-pointer.y * 0.7 - camera.position.y) * 0.02;
        camera.lookAt(0, 0, -6);
        renderer.render(scene, camera);
      };
      raf = requestAnimationFrame(tick);

      const onVisibility = () => { running = !document.hidden; };
      document.addEventListener('visibilitychange', onVisibility);

      cleanup = () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        window.removeEventListener('pointermove', onPointer);
        document.removeEventListener('visibilitychange', onVisibility);
        renderer.domElement.remove();
        renderer.dispose();
        cubeGeo.dispose();
        pipGeo.dispose();
        bodyMat.dispose();
        brassMat.dispose();
        pipMat.dispose();
      };
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
      style={{ opacity: 0.85 * intensity }}
    >
      <div ref={host} className="h-full w-full" />
      {/* Fade the centre so content always sits on quiet ground. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(52% 46% at 50% 45%, rgba(6,13,10,.9) 0%, rgba(6,13,10,.55) 52%, transparent 82%)',
        }}
      />
    </div>
  );
}
