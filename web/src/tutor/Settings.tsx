import { useEffect, useState } from 'react';
import type { TutorSettings } from '../ui-types';
import { Icon } from '../design/Icon';

const modelName = (value: string) => value === 'gpt-5.6-luna' ? 'Luna' : value === 'gpt-5.6-terra' ? 'Terra' : value === 'gpt-5.6-sol' ? 'Sol' : value.replaceAll('-', ' ');

export function Settings(props: {
  settings: TutorSettings; config?: { models: string[]; effortsForModel: Record<string, string[]> }; busy: boolean; error: string | null; onSave(value: TutorSettings): void; onClose(): void; onReset(): void;
}) {
  const { settings, busy, error, onSave, onClose, onReset } = props;
  const [tab, setTab] = useState<'tutor' | 'session'>('tutor');
  const [model, setModel] = useState(settings.model);
  const [effort, setEffort] = useState(settings.reasoningEffort);
  useEffect(() => { setModel(settings.model); setEffort(settings.reasoningEffort); }, [settings.model, settings.reasoningEffort]);
  const availableModels = props.config?.models.length ? props.config.models : [settings.model];
  const availableEfforts = props.config?.effortsForModel[model] ?? [settings.reasoningEffort];
  const update = (nextModel: string, nextEffort = effort) => {
    const options = props.config?.effortsForModel[nextModel] ?? [];
    const normalizedEffort = options.includes(nextEffort) ? nextEffort : options[0] ?? nextEffort;
    setModel(nextModel); setEffort(normalizedEffort);
    onSave({ model: nextModel, reasoningEffort: normalizedEffort });
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="settings-window" role="dialog" aria-modal="true" aria-label="Settings">
      <nav className="settings-sidebar" aria-label="Settings sections"><button className={`settings-tab ${tab === 'tutor' ? 'is-selected' : ''}`} onClick={() => setTab('tutor')}>Tutor</button><button className={`settings-tab ${tab === 'session' ? 'is-selected' : ''}`} onClick={() => setTab('session')}>Session</button></nav>
      <button className="icon-button settings-close" aria-label="Close settings" onClick={onClose}><Icon name="composer/dismiss" /></button>
      {tab === 'tutor' ? <div className="settings-pane">
        <header className="settings-heading"><h2>Tutor</h2><p>How the tutor thinks and speaks. Changes apply to your next message; the conversation so far is left alone.</p></header>
        <div className="settings-row"><div className="settings-row-copy"><strong>Tutor model</strong><span>Which route answers you</span></div><select className="settings-select" value={model} onChange={event => update(event.target.value)} aria-label="Tutor model">{availableModels.map(value => <option key={value} value={value}>{modelName(value)}</option>)}</select></div>
        <div className="settings-row"><div className="settings-row-copy"><strong>Reasoning effort</strong><span>How long it thinks before replying</span></div><select className="settings-select" value={effort} onChange={event => update(model, event.target.value)} aria-label="Reasoning effort">{availableEfforts.map(value => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select></div>
        {error && <div className="status-error">{error}</div>}
      </div> : <div className="settings-pane">
        <header className="settings-heading"><h2>Session</h2><p>Resetting clears the conversation and the goal it was working toward. It won't be possible to undo this.</p></header>
        <div className="settings-row"><div className="settings-row-copy"><strong>Reset this session</strong><span>Start a new conversation and board</span></div><button className="settings-reset" onClick={onReset}>Reset</button></div>
      </div>}
      {busy && <div className="settings-saving" aria-live="polite">Saving</div>}
    </section>
  </div>;
}
