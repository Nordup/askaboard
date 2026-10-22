import { describe, expect, it } from 'vitest';
import type { Message, Workspace } from '../types';
import { condensed, leadingClause, sessionTitle, UNTITLED_SESSION, withDerivedTitle } from './title';

const learner = (text: string): Message => ({ id: crypto.randomUUID(), role: 'user', text });
const tutor = (text: string): Message => ({ id: crypto.randomUUID(), role: 'assistant', text });

describe('session titles follow iPad LearningSession.title', () => {
  it('derives rename, then plan headline, then first learner line, then "New session"', () => {
    const plan = { title: 'Solve a two-step linear equation', goal: '', steps: [], outcomes: [] };
    const messages = [tutor('Hi!'), learner('   '), learner('Can you help me solve 2x + 6 = 14?')];
    // Sweep every combination of the three sources; the highest present wins.
    for (const customTitle of [null, 'My algebra']) for (const withPlan of [false, true]) for (const withMessages of [false, true]) {
      const workspace = { customTitle, plan: withPlan ? plan : null, messages: withMessages ? messages : [] };
      const expected = customTitle ?? (withPlan ? plan.title : withMessages ? 'Can you help me solve 2x + 6 = 14?' : UNTITLED_SESSION);
      expect(sessionTitle(workspace)).toBe(expected);
    }
  });

  it('cuts plan titles at the first break unless the head is a fragment', () => {
    expect(leadingClause('Radical equations, one careful step at a time')).toBe('Radical equations');
    expect(leadingClause('Limits: the squeeze theorem')).toBe('Limits');
    expect(leadingClause('No, we square both sides first')).toBe('No, we square both sides first');
    expect(leadingClause('   ')).toBeNull();
  });

  it('condenses a pasted paragraph to one short line', () => {
    expect(condensed('Solve   for x\nwhere 2x + 6 = 14')).toBe('Solve for x');
    const long = condensed('Please help me understand why the derivative of sine is cosine and not something else');
    expect([...long].length).toBeLessThanOrEqual(49);
    expect(long.endsWith('…')).toBe(true);
  });

  it('keeps legacy renames and drops legacy placeholders when migrating', () => {
    const legacy = (title: string): Workspace => {
      // Saved before `customTitle` existed: no such key at all.
      return { version: 1, id: 'legacy', title, strokes: [], scene: { elements: [] }, camera: { center: [0, 0], zoom: 1 },
        messages: [learner('help me solve 2x + 6 = 14')], model: 'gpt-5.6-luna', reasoningEffort: 'high', plan: null, exercise: null,
        updatedAt: '2026-10-22T00:00:00.000Z' };
    };
    expect(withDerivedTitle(legacy('New session')).title).toBe('help me solve 2x + 6 = 14');
    expect(withDerivedTitle(legacy('Untitled session')).title).toBe('help me solve 2x + 6 = 14');
    expect(withDerivedTitle(legacy('Fractions homework'))).toMatchObject({ title: 'Fractions homework', customTitle: 'Fractions homework' });
  });
});
