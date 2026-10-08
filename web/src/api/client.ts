import type { Attachment, Capture, Workspace } from '../types';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export class TutorTurnFailure extends Error {
  constructor(public retryable: boolean) {
    super(retryable ? 'The tutor is busy right now — try again in a moment.' : "I couldn't reach the tutor service just now.");
    this.name = 'TutorTurnFailure';
  }
}
export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init });
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const body = await response.json();
      if (typeof body.detail === 'string') message = body.detail;
    } catch { /* A proxy may return a non-JSON failure. */ }
    throw new ApiError(response.status, message);
  }
  return response.status === 204 ? undefined as T : await response.json() as T;
}
export const json = (body: unknown): RequestInit => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
export interface WebStatus {
  authenticated: boolean;
  models: string[];
  efforts_for_model: Record<string, string[]>;
  live_available: boolean;
}
export interface StoredWorkspace { workspace: Workspace; revision: number; }
export const api = {
  status: () => request<WebStatus>('/v1/web/status'),
  login: (code: string) => request('/v1/web/login', json({ code })),
  logout: () => request('/v1/web/logout', json({})),
  workspace: (id: string) => request<StoredWorkspace>(`/v1/sessions/${id}/workspace`),
  save: (workspace: Workspace, revision: number) => request<StoredWorkspace>(`/v1/sessions/${workspace.id}/workspace`, {
    ...json({ workspace, expected_revision: revision }), method: 'PUT',
  }),
  sessions: async () => (await request<{ sessions: Array<Record<string, unknown>> }>('/v1/sessions')).sessions,
  transcript: (workspace: Workspace) => request<void>(`/v1/sessions/${workspace.id}/transcript`, {
    ...json({ messages: workspace.messages.map(m => ({ role: m.role === 'user' ? 'learner' : 'tutor', text: m.text, ...(m.signal ? { signal: m.signal } : {}) })) }),
    method: 'PUT',
  }),
  close: (id: string) => request<void>(`/v1/sessions/${id}/close`, json({})),
  delete: (id: string) => request<void>(`/v1/sessions/${id}`, { method: 'DELETE' }),
  boardReply: (turnId: string, callId: string, capture: Capture | Error) => request<void>(`/v1/turn/${turnId}/board`, json({
    call_id: callId, ...(capture instanceof Error ? { error: capture.message } : { image_base64: capture.image_base64 }),
  })),
  upload: async (sessionId: string, file: File): Promise<Attachment> => {
    const form = new FormData(); form.append('session_id', sessionId); form.append('file', file);
    const result = await request<Attachment>('/v1/attachments', { method: 'POST', body: form });
    return { ...result, filename: file.name };
  },
};

export type StreamEvent = { type: string; [key: string]: unknown };
// SSE field parsing is kept separate to test real network chunk boundaries.
export function parseFrame(frame: string): StreamEvent | null {
  const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).replace(/^ /, '')).join('\n');
  if (!data) return null;
  const parsed: unknown = JSON.parse(data);
  if (!parsed || typeof parsed !== 'object' || !('type' in parsed) || typeof parsed.type !== 'string') {
    throw new Error('The tutor sent an invalid event.');
  }
  return parsed as StreamEvent;
}
export async function consumeSSE(response: Response, onEvent: (event: StreamEvent) => void | Promise<void>) {
  if (!response.ok) throw new ApiError(response.status, 'The tutor connection failed.');
  if (!response.body) throw new Error('The tutor returned an empty stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder(); let buffer = ''; let terminal = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const event = parseFrame(frame);
        if (!event) continue;
        await onEvent(event);
        if (event.type === 'error') throw new TutorTurnFailure(event.retryable === true);
        if (event.type === 'done') terminal = true;
      }
      if (done) break;
    }
    if (!terminal) throw new Error('The tutor disconnected before finishing. Your work is saved; try again.');
  } finally { reader.releaseLock(); }
}
