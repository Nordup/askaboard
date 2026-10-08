import { useEffect, useState } from 'react';
import type { ActivityTrail as ActivityTrailData, ActivityItem } from '../types';
import { loadMedia, mediaDataUrl } from '../workspace/media';
import { Icon } from '../design/Icon';

function durationLabel(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return minutes ? `Worked for ${minutes}m ${remainder}s` : `Worked for ${remainder}s`;
}

function searchLabel(item: Extract<ActivityItem, { kind: 'search' }>): string {
  return `Searched ${item.sources.length} ${item.sources.length === 1 ? 'website' : 'websites'}`;
}

function iconFor(item: ActivityItem): string {
  if (item.kind === 'reasoning') return 'trail/terminal';
  if (item.kind === 'search') return 'trail/globe';
  const tool = `${item.tool} ${item.label}`.toLowerCase();
  if (tool.includes('board') || tool.includes('view')) return 'trail/eye';
  if (tool.includes('search') || tool.includes('research')) return 'trail/search';
  if (tool.includes('plan')) return 'trail/plan';
  if (tool.includes('code') || tool.includes('python') || tool.includes('comput')) return 'trail/terminal';
  return 'trail/globe';
}

function Crop({ sessionId, imageId, label }: { sessionId: string; imageId: string; label: string }) {
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void loadMedia(sessionId, imageId).then(value => { if (current && value) setSource(mediaDataUrl(value)); });
    return () => { current = false; };
  }, [sessionId, imageId]);
  return source ? <img className="tutor-trail-crop" src={source} alt={`Board region: ${label}`} /> : <span className="tutor-trail-crop-missing">Board image unavailable</span>;
}

export function ActivityTrail({ trail, sessionId }: { trail: ActivityTrailData; sessionId: string }) {
  const [expanded, setExpanded] = useState(!Number.isFinite(trail.duration));
  const [expandedItem, setExpandedItem] = useState<string | null>(null);
  useEffect(() => { if (Number.isFinite(trail.duration)) setExpanded(false); }, [trail.duration]);
  if (!trail.items.length && trail.duration === undefined) return null;
  const summary = trail.duration === undefined ? 'Working…' : durationLabel(trail.duration);

  return <section className={`tutor-trail ${trail.duration === undefined ? 'is-active' : 'is-complete'}`} aria-label="Tutor activity">
    {trail.duration !== undefined && <button className="tutor-trail-summary" type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <span>{summary}</span><Icon name="ui/chevron-down" size={16} />
    </button>}
    {expanded && <ol className="tutor-trail-list">
      {trail.items.map(item => {
        const expandable = (item.kind === 'search' && item.sources.length > 0) || (item.kind === 'step' && Boolean(item.imageId));
        const isOpen = expandedItem === item.id;
        const text = item.kind === 'search' ? searchLabel(item) : item.kind === 'step' ? item.label : item.text;
        return <li className="tutor-trail-item" key={`${item.kind}-${item.id}`}>
          {expandable ? <button className="tutor-trail-row tutor-trail-row--expandable" type="button" aria-expanded={isOpen} aria-label={item.kind === 'search' ? `${text} for ${item.query}` : text} onClick={() => setExpandedItem(value => value === item.id ? null : item.id)}>
            <Icon name={iconFor(item)} size={16} /><span>{text}</span><Icon name="ui/chevron-down" size={14} />
          </button> : <div className="tutor-trail-row"><Icon name={iconFor(item)} size={16} /><span>{text}</span></div>}
          {isOpen && item.kind === 'search' && <ul className="tutor-trail-sources" aria-label={`${item.sources.length} sources for ${item.query}`}>
            {item.sources.map(source => {
              const safe = /^https?:\/\//i.test(source.url);
              let domain = source.domain;
              if (!domain && safe) { try { domain = new URL(source.url).hostname.replace(/^www\./, ''); } catch { domain = source.url; } }
              return <li key={source.url}>{safe ? <a href={source.url} target="_blank" rel="noreferrer"><span className="tutor-trail-source-title">{source.title || domain || source.url}</span><span className="tutor-trail-source-domain">{domain}</span></a> : <span>{source.title || source.url}</span>}</li>;
            })}
          </ul>}
          {isOpen && item.kind === 'step' && item.imageId && <Crop sessionId={sessionId} imageId={item.imageId} label={item.label} />}
        </li>;
      })}
    </ol>}
  </section>;
}
