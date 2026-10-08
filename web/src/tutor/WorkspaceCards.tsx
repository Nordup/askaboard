import type { Workspace } from '../types';
import { Icon } from '../design/Icon';

interface Plan {
  title: string;
  goal: string;
  outcomes: string[];
  steps: string[];
}
const objectValue = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' ? value as Record<string, unknown> : null;

function parsePlan(value: unknown): Plan | null {
  const raw = objectValue(value);
  if (!raw || typeof raw.title !== 'string') return null;
  return {
    title: raw.title,
    goal: typeof raw.goal === 'string' ? raw.goal : '',
    outcomes: Array.isArray(raw.outcomes) ? raw.outcomes.filter((item): item is string => typeof item === 'string') : [],
    steps: Array.isArray(raw.steps) ? raw.steps.filter((item): item is string => typeof item === 'string') : [],
  };
}

export function WorkspaceCards({ workspace, onStartPlan, onReturnToChat }: {
  workspace: Workspace;
  onStartPlan(): void;
  onReturnToChat(): void;
}) {
  // The current Swift screen only shows the plan while its matching exercise exists,
  // then moves to board work mode. Returning is owned by the shell presentation control.
  void onReturnToChat;
  if (workspace.isWorkspace || !workspace.exercise) return null;
  const plan = parsePlan(workspace.plan);
  if (!plan) return null;
  return <section className="tutor-session-plan" aria-label="Session plan">
    <p className="tutor-plan-kicker">Session plan</p>
    <h2>{plan.title}</h2>
    <p className="tutor-plan-goal">{plan.goal}</p>
    <ol className="tutor-plan-steps">{plan.steps.map((step, index) => <li key={`${index}-${step}`}><span>{index + 1}</span><p>{step}</p></li>)}</ol>
    <p className="tutor-plan-kicker tutor-plan-outcomes-label">What success looks like</p>
    <ul className="tutor-plan-outcomes">{plan.outcomes.map((outcome, index) => <li key={`${index}-${outcome}`}><Icon name="ui/check" size={20} /><span>{outcome}</span></li>)}</ul>
    <button className="tutor-plan-action" type="button" onClick={onStartPlan}>Start on the board</button>
  </section>;
}
