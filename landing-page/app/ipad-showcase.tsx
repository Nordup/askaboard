'use client';

import Image from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';

const scenarios = [
  {
    src: '/assets/app-showcase/01-voice-mode-fullscreen-whiteboard.png',
    title: 'Learn Out Loud',
    description: 'Voice mode keeps the tutor present while the whiteboard stays full screen.',
  },
  {
    src: '/assets/app-showcase/02-tutor-reviews-handwritten-work.png',
    title: 'Check Your Work',
    description: 'The tutor verifies handwritten work and pinpoints a misconception.',
  },
  {
    src: '/assets/app-showcase/03-fullscreen-chat-session-history.png',
    title: 'Talk It Through',
    description: 'Full-screen chat keeps past sessions and the current learning conversation in view.',
  },
] as const;

const AUTO_ADVANCE_MS = 5000;
const SWIPE_THRESHOLD = 44;

type PointerStart = { x: number; y: number; id: number } | null;

export function IpadShowcase({ className = '' }: { className?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const pointerStart = useRef<PointerStart>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [isVisible, setIsVisible] = useState(true);
  const [pageIsVisible, setPageIsVisible] = useState(true);
  const [reduceMotion, setReduceMotion] = useState(false);

  const showScenario = useCallback((nextIndex: number) => {
    const wrappedIndex = (nextIndex + scenarios.length) % scenarios.length;
    setActiveIndex(wrappedIndex);
  }, []);

  const step = useCallback((amount: number) => {
    setActiveIndex((current) => (current + amount + scenarios.length) % scenarios.length);
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const syncPreference = () => setReduceMotion(media.matches);
    syncPreference();
    media.addEventListener('change', syncPreference);
    return () => media.removeEventListener('change', syncPreference);
  }, []);

  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      ([entry]) => setIsVisible(entry.isIntersecting && entry.intersectionRatio >= 0.35),
      { threshold: [0, 0.35, 1] },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const syncVisibility = () => setPageIsVisible(document.visibilityState === 'visible');
    syncVisibility();
    document.addEventListener('visibilitychange', syncVisibility);
    return () => document.removeEventListener('visibilitychange', syncVisibility);
  }, []);

  useEffect(() => {
    const shouldAdvance =
      !reduceMotion &&
      !isHovered &&
      !isFocused &&
      isVisible &&
      pageIsVisible;

    if (!shouldAdvance) return;
    const timeout = window.setTimeout(() => showScenario(activeIndex + 1), AUTO_ADVANCE_MS);
    return () => window.clearTimeout(timeout);
  }, [activeIndex, isFocused, isHovered, isVisible, pageIsVisible, reduceMotion, showScenario]);

  const activeScenario = scenarios[activeIndex];

  return (
    <div
      ref={rootRef}
      className={`ipad-showcase ${className}`.trim()}
      role="group"
      aria-roledescription="carousel"
      aria-label={`Interactive iPad showcase: ${activeScenario.title}. ${activeScenario.description} Click or swipe to change examples; use the left and right arrow keys for manual control.`}
      tabIndex={0}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onFocus={() => setIsFocused(true)}
      onBlur={() => setIsFocused(false)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          step(-1);
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          step(1);
        }
      }}
      onPointerDown={(event) => {
        pointerStart.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
      }}
      onPointerUp={(event) => {
        const start = pointerStart.current;
        pointerStart.current = null;
        if (!start || start.id !== event.pointerId) return;

        const deltaX = event.clientX - start.x;
        const deltaY = event.clientY - start.y;
        if (Math.abs(deltaX) > SWIPE_THRESHOLD && Math.abs(deltaX) > Math.abs(deltaY) * 1.15) {
          step(deltaX < 0 ? 1 : -1);
        } else if (Math.abs(deltaX) < 8 && Math.abs(deltaY) < 8) {
          step(1);
        }
        event.currentTarget.blur();
      }}
      onPointerCancel={() => {
        pointerStart.current = null;
      }}
    >
      <Image
        className="ipad-showcase-frame"
        src="/assets/ipad-paper-showcase-frame@2x.png"
        width={834}
        height={617}
        sizes="(max-width: 900px) calc(100vw - 48px), 834px"
        alt=""
        aria-hidden="true"
        priority
        unoptimized
      />
      <div className="ipad-showcase-screen" aria-live="off">
        {scenarios.map((scenario, index) => {
          const position = index === activeIndex ? 'active' : index < activeIndex ? 'past' : 'future';
          return (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={scenario.src}
              className="ipad-showcase-scenario"
              data-position={position}
              src={scenario.src}
              alt={`${scenario.title}. ${scenario.description}`}
              loading={index < 2 ? 'eager' : 'lazy'}
              fetchPriority={index < 2 ? 'high' : 'auto'}
              decoding="async"
              draggable={false}
            />
          );
        })}
      </div>
      <span className="sr-only">Showing {activeScenario.title}, example {activeIndex + 1} of {scenarios.length}.</span>
    </div>
  );
}
