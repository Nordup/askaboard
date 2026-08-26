import type { ReactNode } from 'react';
import Image from 'next/image';
import { NewsletterForm } from './newsletter-form';

export { NewsletterForm };

export function Brand() {
  return <span className="brand"><span className="brand-mark" aria-hidden="true">L</span><span>Learn AI</span></span>;
}

type ButtonProps = { children: ReactNode; href: string; size?: 'small' | 'regular'; tone?: 'primary' | 'secondary' | 'inverse' };

export function Button({ children, href, size = 'regular', tone = 'primary' }: ButtonProps) {
  return <a className={`button button-${size} button-${tone}`} href={href}>{children}</a>;
}

export function DeviceFrame({ className = '', compact = false }: { className?: string; compact?: boolean }) {
  return <Image className={`ipad-export ${compact ? 'ipad-export-compact' : ''} ${className}`.trim()} src="/assets/ipad-paper-export-shadowless@2x.png" width={834} height={634} sizes={compact ? '(max-width: 700px) calc(100vw - 32px), 668px' : '(max-width: 900px) calc(100vw - 32px), 834px'} alt="Learn AI whiteboard and tutor interface in its shadow-free Paper-designed iPad frame" priority={!compact} />;
}

export function CapabilityCard({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return (
    <article className="capability-card">
      <p className="capability-eyebrow">{eyebrow}</p>
      <h3>{title}</h3>
      <p className="capability-body">{children}</p>
      <a className="card-arrow" href="#product" aria-label={`Learn more about ${title}`}><span aria-hidden="true">→</span></a>
    </article>
  );
}

const roadmapSteps = [
  { marker: '✓', label: 'Vectors and components', meta: 'Confident', state: 'complete' },
  { marker: '2', label: 'Linear combinations', meta: 'In progress', state: 'active' },
  { marker: '3', label: 'Span and independence', meta: '', state: 'next' },
];

export function RoadmapCard() {
  return (
    <div className="roadmap-card">
      <p className="roadmap-eyebrow">YOUR ROADMAP</p>
      <h3>Linear algebra · Foundations</h3>
      <div className="roadmap-steps">
        {roadmapSteps.map((step) => (
          <div className="roadmap-step" key={step.label}>
            <span className={`step-marker step-${step.state}`}>{step.marker}</span>
            <strong>{step.label}</strong>
            {step.meta && <small className={`step-meta step-${step.state}`}>{step.meta}</small>}
          </div>
        ))}
      </div>
      <div className="progress-chart" aria-label="Understanding increasing over time">
        {[22, 31, 39, 50, 62].map((height, index) => <span key={height} style={{ height, opacity: .36 + index * .16 }} />)}
        <small>Understanding over time</small>
      </div>
    </div>
  );
}
