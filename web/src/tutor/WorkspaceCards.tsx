import type { Activity, Source, Workspace } from '../types';
import { Icon } from '../design/Icon';

export function ActivityCard({ activity, sources }: { activity: Activity[]; sources: Source[] }) {
  if (!activity.length && !sources.length) return null;
  const iconFor = (item: Activity) => {
    const key = `${item.label} ${item.status ?? ''}`.toLowerCase();
    return key.includes('search') || key.includes('research') ? 'trail/search' : key.includes('board') || key.includes('inspect') ? 'trail/eye' : key.includes('plan') ? 'trail/plan' : key.includes('code') || key.includes('comput') ? 'trail/terminal' : 'trail/globe';
  };
  return <section className="activity-card" aria-label="Tutor activity">
    {activity.map(item => <div className="activity-row" key={item.id}><Icon name={iconFor(item)} size={20} /><div>{item.label}{item.detail && <small>{item.detail}</small>}</div></div>)}
    {!!sources.length && <div className="source-list" aria-label="Sources">{sources.map((source, index) => <a className="source-link" key={`${source.url}-${index}`} href={source.url} target="_blank" rel="noreferrer">{source.title || source.url}</a>)}</div>}
  </section>;
}

interface Plan { title: string; goal: string; outcomes: string[]; steps: string[]; currentStep: number }
interface Exercise { title: string; prompt: string; hint: string; context: string }
const objectValue = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' ? value as Record<string, unknown> : null;

export function PlanCard({ value, onStart }: { value: unknown; onStart(prompt: string): void }) {
  const raw = objectValue(value);
  if (!raw || typeof raw.title !== 'string') return null;
  const plan: Plan = { title: raw.title, goal: typeof raw.goal === 'string' ? raw.goal : '', outcomes: Array.isArray(raw.outcomes) ? raw.outcomes.filter((item): item is string => typeof item === 'string') : [], steps: Array.isArray(raw.steps) ? raw.steps.filter((item): item is string => typeof item === 'string') : [], currentStep: typeof raw.currentStep === 'number' ? raw.currentStep : 0 };
  return <section className="plan-card">
    <p className="kicker">Session plan</p><h2>{plan.title}</h2>{plan.goal && <div className="goal">{plan.goal}</div>}
    {plan.steps.map((step, index) => <div className="plan-step" key={`${index}-${step}`}><span className="plan-step-number">{index + 1}</span><span>{step}</span></div>)}
    {!!plan.outcomes.length && <><p className="kicker" style={{ marginTop: 6 }}>What success looks like</p>{plan.outcomes.map((outcome, index) => <div className="plan-outcome" key={`${index}-${outcome}`}><Icon name="ui/check" size={22} /><span>{outcome}</span></div>)}</>}
    {plan.steps.length > 0 && <button className="primary-button" onClick={() => onStart(plan.steps[Math.min(Math.max(plan.currentStep, 0), plan.steps.length - 1)])}>Start on the board</button>}
  </section>;
}

export function ExerciseCard({ value, onTry }: { value: unknown; onTry(prompt: string): void }) {
  const raw = objectValue(value);
  if (!raw || typeof raw.prompt !== 'string') return null;
  const exercise: Exercise = { title: typeof raw.title === 'string' ? raw.title : 'Exercise', prompt: raw.prompt, hint: typeof raw.hint === 'string' ? raw.hint : '', context: typeof raw.context === 'string' ? raw.context : '' };
  return <section className="exercise-card"><p className="kicker">Practice</p><h2>{exercise.title}</h2>{exercise.context && <div className="context">{exercise.context}</div>}<div className="exercise-prompt">{exercise.prompt}</div>{exercise.hint && <div className="exercise-hint"><strong>Hint</strong> · {exercise.hint}</div>}<button className="primary-button" onClick={() => onTry(exercise.prompt)}>Try this</button></section>;
}

export function WorkspaceCards({ workspace, activity, sources, onStartPlan }: { workspace: Workspace; activity: Activity[]; sources: Source[]; onStartPlan(prompt: string): void }) {
  return <>
    {workspace.plan && <PlanCard value={workspace.plan} onStart={onStartPlan} />}
    {workspace.exercise && <ExerciseCard value={workspace.exercise} onTry={onStartPlan} />}
    <ActivityCard activity={activity} sources={sources} />
  </>;
}
