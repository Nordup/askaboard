import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { VoicePhase } from '../ui-types';

const lens = 'radial-gradient(ellipse 46% 44% at 38% 40% in oklab, oklab(87.4% 0.048 -0.042 / 75%) 0%, oklab(89.8% 0.036 -0.034 / 34%) 46%, oklab(93% 0.022 -0.023 / 0%) 74%), radial-gradient(ellipse 46% 44% at 64% 57.99999999999999% in oklab, oklab(86.7% 0.001 -0.054 / 70%) 0%, oklab(90.5% .0006 -0.038 / 30%) 48%, oklab(93.4% -.0005 -0.026 / 0%) 76%), radial-gradient(ellipse 27% 26% at 50% 47% in oklab, oklab(83.6% 0.029 -0.058) 0%, oklab(86.2% 0.024 -0.050) 58%, oklab(86.2% 0.024 -0.050 / 50%) 80%, oklab(86.2% 0.024 -0.050 / 0%) 100%)';
const liveHalo = 'radial-gradient(ellipse 46% 44% at 38% 40% in oklab, oklab(87.4% 0.048 -0.042 / 85%) 0%, oklab(89.8% 0.036 -0.034 / 42%) 46%, oklab(93% 0.022 -0.023 / 0%) 74%), radial-gradient(ellipse 46% 44% at 64% 57.99999999999999% in oklab, oklab(86.7% 0.001 -0.054 / 80%) 0%, oklab(90.5% .0006 -0.038 / 38%) 48%, oklab(93.4% -.0005 -0.026 / 0%) 76%)';
const dockHalo = 'radial-gradient(ellipse 46% 44% at 38% 40% in oklab, oklab(87.4% 0.048 -0.042 / 75%) 0%, oklab(89.8% 0.036 -0.034 / 34%) 46%, oklab(93% 0.022 -0.023 / 0%) 74%), radial-gradient(ellipse 46% 44% at 64% 57.99999999999999% in oklab, oklab(86.7% 0.001 -0.054 / 70%) 0%, oklab(90.5% .0006 -0.038 / 30%) 48%, oklab(93.4% -.0005 -0.026 / 0%) 76%), radial-gradient(ellipse 28.999999999999996% 28.000000000000004% at 50% 47% in oklab, oklab(83.6% 0.029 -0.058) 0%, oklab(86.2% 0.024 -0.050) 58%, oklab(86.2% 0.024 -0.050 / 50%) 80%, oklab(86.2% 0.024 -0.050 / 0%) 100%)';
const body = 'linear-gradient(in oklab 180deg, oklab(25.4% -0.001 -0.053) 0%, oklab(17.5% -0.009 -0.032) 46%, oklab(13% -0.010 -0.019) 100%)';

/** Paper's face is the visual base; a damped motion value follows voice phase and audio level. */
export function Orb({ variant = 'greeting', phase = 'idle', inputLevel = 0, outputLevel = 0 }: {
  variant?: 'greeting' | 'panel' | 'hero' | 'dock' | 'thread' | 'live' | 'resting' | 'collapsed';
  phase?: VoicePhase;
  inputLevel?: number;
  outputLevel?: number;
}) {
  const root = useRef<HTMLDivElement>(null);
  const levels = useRef({ energy: 0, listening: 0, speaking: 0 });
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const clamp = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
    const targetEnergy = phase === 'talking' ? 0.12 + clamp(outputLevel) * 0.88
      : phase === 'listening' || phase === 'live' ? 0.08 + clamp(inputLevel) * 0.72
        : phase === 'thinking' ? 0.24 : phase === 'connecting' || phase === 'closing' ? 0.18 : 0.04;
    if (reduce) {
      element.style.setProperty('--orb-energy', '0');
      element.style.setProperty('--orb-listening', '0');
      element.style.setProperty('--orb-speaking', '0');
      return;
    }
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const delta = Math.min(80, now - previous);
      previous = now;
      const smooth = (current: number, target: number, tau: number) => current + (target - current) * (1 - Math.exp(-delta / tau));
      const state = levels.current;
      state.energy = smooth(state.energy, targetEnergy, targetEnergy > state.energy ? 170 : 430);
      state.listening = smooth(state.listening, phase === 'listening' || phase === 'live' ? clamp(inputLevel) : 0, 210);
      state.speaking = smooth(state.speaking, phase === 'talking' ? clamp(outputLevel) : 0, 130);
      element.style.setProperty('--orb-energy', state.energy.toFixed(3));
      element.style.setProperty('--orb-listening', state.listening.toFixed(3));
      element.style.setProperty('--orb-speaking', state.speaking.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase, inputLevel, outputLevel]);

  const style: CSSProperties = { '--orb-energy': 0, '--orb-listening': 0, '--orb-speaking': 0 } as CSSProperties;
  if (variant === 'collapsed' || variant === 'dock') return <div ref={root} className={`paper-orb paper-orb--dock paper-orb--phase-${phase}`} style={style} aria-hidden="true"><div className="paper-orb__halo" style={{ backgroundImage: dockHalo, width: 130, height: 128, left: -33, top: -32 }} /><div className="paper-orb__body paper-orb__body--dock" style={{ backgroundImage: body }}><i /><i /></div></div>;
  if (variant === 'greeting' || variant === 'panel') return <div ref={root} className={`paper-orb paper-orb--${variant} paper-orb--phase-${phase}`} style={style} aria-hidden="true"><div className="paper-orb__halo" style={{ backgroundImage: lens, width: 190, height: 180, left: -47, top: -49 }} /><div className="paper-orb__body paper-orb__body--panel" style={{ backgroundImage: body }}><i /><i /></div></div>;
  if (variant === 'hero') return <div ref={root} className={`paper-orb paper-orb--hero paper-orb--phase-${phase}`} style={style} aria-hidden="true"><div className="paper-orb__halo" style={{ backgroundImage: lens, width: 296, height: 282, left: -73, top: -77 }} /><div className="paper-orb__body paper-orb__body--hero" style={{ backgroundImage: body }}><i /><i /><svg className="paper-orb__smile" viewBox="0 0 18 10" aria-hidden="true"><path d="M1.6 1.6C4 6.4 14 6.4 16.4 1.6" /></svg></div></div>;
  if (variant === 'thread') return <div ref={root} className={`paper-orb paper-orb--thread paper-orb--phase-${phase}`} style={style} aria-hidden="true"><div className="paper-orb__halo" style={{ backgroundImage: dockHalo, width: 94, height: 92, left: -24, top: -23 }} /><div className="paper-orb__body paper-orb__body--thread" style={{ backgroundImage: body }}><i /><i /></div></div>;
  return <div ref={root} className={`paper-orb paper-orb--${variant} paper-orb--phase-${phase}`} style={style} aria-hidden="true">
    {variant === 'resting' ? <div className="paper-orb__rest-ring" /> : <><div className="paper-orb__halo" style={{ backgroundImage: liveHalo, width: 240, height: 228, left: 30, top: -60 }} /><div className="paper-orb__bloom" style={{ backgroundImage: 'radial-gradient(ellipse 40% 38% at 50% 47% in oklab, oklab(83.6% 0.029 -0.058) 0%, oklab(86.2% 0.024 -0.050 / 70%) 55%, oklab(86.2% 0.024 -0.050 / 0%) 100%)', width: 150, height: 143, left: 75, top: -18 }} /></>}
    <div className={`paper-orb__body paper-orb__body--${variant}`} style={{ backgroundImage: body }}>{variant === 'live' ? <><i /><i /></> : <><i /><i /></>}</div>
  </div>;
}
