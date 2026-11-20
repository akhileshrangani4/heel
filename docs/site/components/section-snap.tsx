'use client';

import Lenis from 'lenis';
import Snap from 'lenis/snap';
import 'lenis/dist/lenis.css';
import { useEffect } from 'react';

/**
 * Smooth scrolling on the home page, settling onto a section when a scroll stops near one.
 * Lenis eases the wheel itself, so the settle continues the same motion instead of starting a
 * second one after the trackpad's momentum ends. Each section settles just under the 56px nav.
 * Off with reduced motion (Lenis then follows the wheel 1:1 and jumps).
 */

const NAV = 56;

export function SectionSnap() {
  useEffect(() => {
    // smoothWheel off: the wheel and trackpad scroll natively; only the settle is animated.
    const lenis = new Lenis({ autoRaf: true, smoothWheel: false });
    const snap = new Snap(lenis, {
      type: 'proximity',
      distanceThreshold: '30%',
      debounce: 150,
      duration: 1.2,
      easing: (t) => 1 - (1 - t) ** 4,
    });

    let remove: (() => void)[] = [];
    const place = () => {
      for (const off of remove) off();
      remove = [...document.querySelectorAll<HTMLElement>('[data-snap]')].map((el) =>
        snap.add(Math.max(0, el.getBoundingClientRect().top + window.scrollY - NAV)),
      );
    };
    place();
    const resize = new ResizeObserver(place);
    resize.observe(document.body);

    return () => {
      resize.disconnect();
      snap.destroy();
      lenis.destroy();
    };
  }, []);

  return null;
}
