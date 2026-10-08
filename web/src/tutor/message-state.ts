import type { ActivityItem, ActivityTrail, Message, Source } from '../types';

export function mergeSources(existing: Source[] = [], incoming: Source[] = []): Source[] {
  const merged = new Map<string, Source>();
  for (const source of [...existing, ...incoming]) {
    if (!source || typeof source.url !== 'string' || !/^https?:\/\//i.test(source.url)) continue;
    merged.set(source.url, { ...merged.get(source.url), ...source });
  }
  return [...merged.values()];
}

export function ensureTutorMessage(messages: Message[], id: string, isVoice = false): Message[] {
  if (messages.some(message => message.id === id)) return messages;
  return [...messages, { id, role: 'assistant', text: '', isVoice, activity: { items: [] } }];
}

function mutateTutor(messages: Message[], id: string, change: (message: Message) => Message, isVoice = false): Message[] {
  const ensured = ensureTutorMessage(messages, id, isVoice);
  return ensured.map(message => message.id === id ? change(message) : message);
}

export function appendReasoning(messages: Message[], id: string, text: string, itemId: string, isVoice = false): Message[] {
  if (!text) return messages;
  return mutateTutor(messages, id, message => {
    const trail: ActivityTrail = message.activity ?? { items: [] };
    const items = [...trail.items];
    const previous = items.at(-1);
    if (previous?.kind === 'reasoning') items[items.length - 1] = { ...previous, text: previous.text + text };
    else items.push({ kind: 'reasoning', id: itemId, text });
    return { ...message, activity: { ...trail, items } };
  }, isVoice);
}

export function upsertStep(messages: Message[], id: string, step: Extract<ActivityItem, { kind: 'step' }>, isVoice = false): Message[] {
  return mutateTutor(messages, id, message => {
    const trail = message.activity ?? { items: [] };
    const index = trail.items.findIndex(item => item.kind === 'step' && item.id === step.id);
    const items = [...trail.items];
    if (index < 0) items.push(step);
    else {
      const old = items[index];
      items[index] = old?.kind === 'step' ? { ...old, ...step, imageId: step.imageId ?? old.imageId } : step;
    }
    return { ...message, activity: { ...trail, items } };
  }, isVoice);
}

export function upsertSearch(messages: Message[], id: string, searchId: string, query: string, sources: Source[], isVoice = false): Message[] {
  return mutateTutor(messages, id, message => {
    const trail = message.activity ?? { items: [] };
    const index = trail.items.findIndex(item => item.kind === 'search' && item.id === searchId);
    const prior = index < 0 ? [] : trail.items[index]?.kind === 'search' ? trail.items[index].sources : [];
    const item: ActivityItem = { kind: 'search', id: searchId, query, sources: mergeSources(prior, sources) };
    const items = [...trail.items];
    if (index < 0) items.push(item); else items[index] = item;
    return { ...message, sources: mergeSources(message.sources, sources), activity: { ...trail, items } };
  }, isVoice);
}

export function setStepImage(messages: Message[], id: string, stepId: string, imageId: string, label = 'Looked at the board', isVoice = false): Message[] {
  return mutateTutor(messages, id, message => {
    const trail = message.activity ?? { items: [] };
    const index = trail.items.findIndex(item => item.kind === 'step' && item.id === stepId);
    const items = [...trail.items];
    if (index < 0) items.push({ kind: 'step', id: stepId, tool: 'view_board', label, imageId });
    else {
      const old = items[index];
      if (old?.kind === 'step') items[index] = { ...old, imageId };
    }
    return { ...message, activity: { ...trail, items } };
  }, isVoice);
}

export function appendAnswer(messages: Message[], id: string, text: string, isVoice = false): Message[] {
  if (!text) return messages;
  return mutateTutor(messages, id, message => ({ ...message, text: message.text + text, isVoice: message.isVoice || isVoice }), isVoice);
}

export function finishTutorMessage(messages: Message[], id: string, duration: number): Message[] {
  return messages.map(message => message.id === id && message.activity
    ? { ...message, activity: { ...message.activity, duration: Math.max(0, duration) } }
    : message);
}
