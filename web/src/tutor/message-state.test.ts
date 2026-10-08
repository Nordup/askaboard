import { describe, expect, it } from 'vitest';
import type { Message } from '../types';
import { consumeSSE } from '../api/client';
import { appendAnswer, appendReasoning, finishTutorMessage, setStepImage, upsertSearch, upsertStep } from './message-state';

describe('ordered tutor activity', () => {
  it('keeps the learner turn first and groups adjacent reasoning on the lazily-created tutor turn', () => {
    const empty: Message[] = [{ id: 'learner', role: 'user', text: 'Why?' }];
    expect(empty.map(message => message.id)).toEqual(['learner']);
    const first = appendReasoning(empty, 'turn', 'Checking ', 'reason-1');
    const second = appendReasoning(first, 'turn', 'the diagram.', 'reason-2');
    const answer = appendAnswer(second, 'turn', ' It balances.');
    expect(answer.at(-1)).toMatchObject({
      id: 'turn', text: ' It balances.', activity: { items: [{ kind: 'reasoning', id: 'reason-1', text: 'Checking the diagram.' }] },
    });
  });

  it('keeps step order stable while refining an existing step and attaching its crop', () => {
    let messages: Message[] = [];
    messages = upsertStep(messages, 'turn', { kind: 'step', id: 'call-1', tool: 'view_board', label: 'Looking at your board' });
    messages = upsertStep(messages, 'turn', { kind: 'step', id: 'call-2', tool: 'python', label: 'Running a check' });
    messages = upsertStep(messages, 'turn', { kind: 'step', id: 'call-1', tool: 'view_board', label: 'Read the marked angle' });
    messages = setStepImage(messages, 'turn', 'call-1', 'crop-1');
    const items = messages[0].activity?.items;
    expect(items?.map(item => item.id)).toEqual(['call-1', 'call-2']);
    expect(items?.[0]).toMatchObject({ label: 'Read the marked angle', imageId: 'crop-1' });
  });

  it('merges source batches by URL within the matching search and records completion duration', () => {
    let messages: Message[] = [];
    messages = upsertSearch(messages, 'turn', 'search-1', 'triangle area', [{ url: 'https://example.org/a', title: 'A' }]);
    messages = upsertSearch(messages, 'turn', 'search-1', 'triangle area', [
      { url: 'https://example.org/a', title: 'Updated A' },
      { url: 'https://example.org/b', title: 'B' },
      { url: 'javascript:alert(1)', title: 'invalid' },
    ]);
    messages = finishTutorMessage(messages, 'turn', 3.25);
    expect(messages[0].sources?.map(source => source.url)).toEqual(['https://example.org/a', 'https://example.org/b']);
    expect(messages[0].activity).toMatchObject({ duration: 3.25, items: [{ kind: 'search', sources: [{ title: 'Updated A' }, { title: 'B' }] }] });
  });

  it('keeps accepted partial prose and leaves its trail unfinished when the server fails', async () => {
    let messages: Message[] = [];
    const body = new TextEncoder().encode([
      'data: {"type":"reasoning_delta","text":"Checking the first line. "}\n\n',
      'data: {"type":"text_delta","text":"The partial result is x = 4."}\n\n',
      'data: {"type":"error","retryable":true,"message":"provider account details"}\n\n',
    ].join(''));
    await expect(consumeSSE(new Response(body), event => {
      if (event.type === 'reasoning_delta') messages = appendReasoning(messages, 'turn', String(event.text), 'reason');
      if (event.type === 'text_delta') messages = appendAnswer(messages, 'turn', String(event.text));
    })).rejects.toMatchObject({ message: 'The tutor is busy right now — try again in a moment.' });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ text: 'The partial result is x = 4.', activity: { items: [{ kind: 'reasoning', text: 'Checking the first line. ' }] } });
    expect(messages[0].activity?.duration).toBeUndefined();
  });
});
