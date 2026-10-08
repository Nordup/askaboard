import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { AppConfig, TutorSettings } from '../ui-types';
import { Icon } from '../design/Icon';

const modelNames: Record<string, string> = {
  'gpt-5.6-sol': 'Sol',
  'gpt-5.6-terra': 'Terra',
  'gpt-5.6-luna': 'Luna',
  'gemini-3.7-flash': 'Flash',
  'gemini-3.5-flash-lite': 'Flash-Lite',
};
const modelCaptions: Record<string, string> = {
  'gpt-5.6-sol': 'Focused route',
  'gpt-5.6-terra': 'Balanced route',
  'gpt-5.6-luna': 'Vision route',
  'gemini-3.7-flash': 'Wide context',
  'gemini-3.5-flash-lite': 'Cheaper, less capable',
};
const effortCaptions: Record<string, string> = {
  low: 'Light reasoning',
  medium: 'Balanced depth',
  high: 'Deep reasoning',
  xhigh: 'Extra-deep reasoning',
  max: 'Maximum depth',
};

function displayModel(value: string) { return modelNames[value] ?? value; }
function displayEffort(value: string) { return value === 'xhigh' ? 'X-High' : `${value[0]?.toUpperCase()}${value.slice(1)}`; }

function SettingsPicker({ label, value, options, selectedTitle, captionFor, onSelect }: {
  label: string;
  value: string;
  options: string[];
  selectedTitle: string;
  captionFor(value: string): string;
  onSelect(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };

  useEffect(() => {
    if (open) selected.current?.focus();
  }, [open]);

  const choose = (next: string) => {
    onSelect(next);
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[index]?.focus();
  };

  return <div className="settings-picker-wrap">
    <button
      ref={trigger}
      className="settings-picker"
      type="button"
      aria-label={label}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? `settings-options-${label.replaceAll(' ', '-')}` : undefined}
      onClick={() => setOpen(value => !value)}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); setOpen(true);
        }
      }}
    >
      <span>{selectedTitle}</span><Icon name="ui/chevron-down" size={16} />
    </button>
    {open && <>
      <button className="settings-picker-shield" type="button" aria-label="Close choices" onClick={close} />
      <div
        ref={menu}
        className="settings-picker-menu"
        id={`settings-options-${label.replaceAll(' ', '-')}`}
        role="listbox"
        aria-label={label}
        onKeyDown={event => {
          moveFocus(event);
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
          if (event.key === 'Tab') setOpen(false);
        }}
      >
        {options.map(option => <button
          key={option}
          ref={option === value ? selected : undefined}
          type="button"
          className="settings-picker-option"
          role="option"
          aria-selected={option === value}
          onClick={() => choose(option)}
        >
          <span><strong>{label === 'Tutor model' ? displayModel(option) : displayEffort(option)}</strong><small>{captionFor(option)}</small></span>
          {option === value && <Icon name="ui/check" size={18} />}
        </button>)}
      </div>
    </>}
  </div>;
}

export function Settings(props: {
  settings: TutorSettings;
  config?: AppConfig;
  busy: boolean;
  error: string | null;
  onSave(value: TutorSettings): void;
  onClose(): void;
  onReset(): void;
}) {
  const { settings, busy, error, onSave, onClose, onReset } = props;
  const [tab, setTab] = useState<'tutor' | 'session'>('tutor');
  const [model, setModel] = useState(settings.model);
  const [effort, setEffort] = useState(settings.reasoningEffort);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { setModel(settings.model); setEffort(settings.reasoningEffort); }, [settings.model, settings.reasoningEffort]);
  useEffect(() => { closeRef.current?.focus(); }, []);

  const availableModels = props.config?.models.length ? props.config.models : [settings.model];
  const availableEfforts = props.config?.effortsForModel[model] ?? [settings.reasoningEffort];
  const update = (nextModel: string, nextEffort = effort) => {
    const options = props.config?.effortsForModel[nextModel] ?? [];
    const normalizedEffort = options.includes(nextEffort) ? nextEffort : options[0] ?? nextEffort;
    setModel(nextModel);
    setEffort(normalizedEffort);
    onSave({ model: nextModel, reasoningEffort: normalizedEffort });
  };

  return <div className="settings-scrim" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="settings-window" role="dialog" aria-modal="true" aria-label="Settings">
      <nav className="settings-sidebar" aria-label="Settings sections">
        <button className={`settings-tab ${tab === 'tutor' ? 'is-selected' : ''}`} aria-current={tab === 'tutor' ? 'page' : undefined} onClick={() => setTab('tutor')}>Tutor</button>
        <button className={`settings-tab ${tab === 'session' ? 'is-selected' : ''}`} aria-current={tab === 'session' ? 'page' : undefined} onClick={() => setTab('session')}>Session</button>
      </nav>
      <button ref={closeRef} className="icon-button settings-close" aria-label="Close settings" onClick={onClose}><Icon name="composer/dismiss" size={22} /></button>
      {tab === 'tutor' ? <div className="settings-pane">
        <header className="settings-heading"><h2>Tutor</h2><p>How the tutor thinks and speaks. Changes apply to your next message; the conversation so far is left alone.</p></header>
        <div className="settings-row">
          <div className="settings-row-copy"><strong>Tutor model</strong><span>Which route answers you</span></div>
          <SettingsPicker label="Tutor model" value={model} options={availableModels} selectedTitle={displayModel(model)} captionFor={value => modelCaptions[value] ?? value} onSelect={value => update(value)} />
        </div>
        <div className="settings-row">
          <div className="settings-row-copy"><strong>Reasoning effort</strong><span>How long it thinks before replying</span></div>
          <SettingsPicker label="Reasoning effort" value={effort} options={availableEfforts} selectedTitle={displayEffort(effort)} captionFor={value => effortCaptions[value] ?? value} onSelect={value => update(model, value)} />
        </div>
        <div className="settings-row">
          <div className="settings-row-copy"><strong>Voice model</strong><span>Which voice answers out loud</span></div>
          <button className="settings-picker settings-picker--fixed" type="button" disabled aria-label="Voice model GPT-Live 1"><span>GPT-Live 1</span><Icon name="ui/chevron-down" size={16} /></button>
        </div>
        {error && <div className="status-error" role="status">{error}</div>}
      </div> : <div className="settings-pane">
        <header className="settings-heading"><h2>Session</h2><p>Resetting clears the conversation and the goal it was working toward. It does not touch your board or its ink.</p></header>
        <div className="settings-row settings-row--destructive">
          <div className="settings-row-copy"><strong>Reset this session</strong><span>Clear the conversation and goal</span></div>
          <button className="settings-reset" onClick={onReset}>Reset</button>
        </div>
      </div>}
      {busy && <div className="settings-saving" aria-live="polite">Saving</div>}
    </section>
  </div>;
}
