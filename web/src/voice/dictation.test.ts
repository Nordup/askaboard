import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dictation } from './dictation';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('dictation session binding', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('uploads a recording to the session where recording began after the active session changes', async () => {
    const posted: FormData[] = [];
    const tracks = [{ stop: vi.fn() }];
    class FakeAudioContext {
      sampleRate = 48000; destination = {}; audioWorklet = { addModule: async () => {} };
      createGain() { return { gain: { value: 1 }, connect(target: unknown) { return target; } }; }
      createMediaStreamSource() { return { connect(target: unknown) { return target; } }; }
      async resume() {}
      async close() {}
    }
    class FakeWorkletNode {
      port = { onmessage: null as null | ((event: MessageEvent) => void) };
      connect(target: unknown) { return target; }
      disconnect() {}
    }
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => tracks }) } });
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:dictation-test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      posted.push(init.body as FormData);
      return new Response('data: {"type":"done","text":"hello"}\n\n');
    }));

    let state = 'idle';
    const dictation = new Dictation(value => { state = value; });
    const first = dictation.start('session-at-start');
    while (state !== 'recording') await tick();
    expect(await dictation.start('new-active-session')).toBe('');
    await expect(first).resolves.toBe('hello');
    expect(posted[0]?.get('session_id')).toBe('session-at-start');
    expect(tracks[0].stop).toHaveBeenCalledOnce();
  });

  it('stops a late permission grant when recording is cancelled during startup', async () => {
    let grant!: (stream: MediaStream) => void;
    const tracks = [{ stop: vi.fn() }];
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise(resolve => { grant = resolve; }) } });
    const dictation = new Dictation(() => {});
    const first = dictation.start('session-1');
    await Promise.resolve();
    expect(await dictation.start('session-2')).toBe('');
    grant({ getTracks: () => tracks } as unknown as MediaStream);
    await expect(first).resolves.toBe('');
    expect(tracks[0].stop).toHaveBeenCalledOnce();
  });
});
