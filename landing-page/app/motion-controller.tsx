'use client';

import { useEffect } from 'react';

export function MotionController() {
  useEffect(() => {
    const root = document.documentElement;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const nav = document.querySelector<HTMLElement>('.site-nav');

    function syncNav() {
      nav?.classList.toggle('is-scrolled', window.scrollY > 16);
    }

    syncNav();
    window.addEventListener('scroll', syncNav, { passive: true });

    if (reduceMotion.matches) {
      return () => window.removeEventListener('scroll', syncNav);
    }

    root.classList.add('motion-ready');
    const revealElements = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'));
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.12 },
    );

    revealElements.forEach((element) => observer.observe(element));

    return () => {
      observer.disconnect();
      root.classList.remove('motion-ready');
      window.removeEventListener('scroll', syncNav);
    };
  }, []);

  return null;
}
