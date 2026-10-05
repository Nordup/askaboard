import { describe, expect, it, vi } from 'vitest';
import { LiveCall, TranscriptLedger } from './live';
import { request } from '../api/client';

vi.mock('../api/client', () => ({ json: (body: unknown) => ({ body: JSON.stringify(body) }), request: vi.fn() }));

describe('full duplex transcript context', () => {
  it('keeps overlapping speakers separate and deduplicates retransmitted events', () => {
    const ledger = new TranscriptLedger();
    const a = { type: 'session.input_transcript.delta', event_id: '1', delta: 'Try ', start_ms: 100, end_ms: 200 };
    ledger.add(a);
    ledger.add({ type: 'session.output_transcript.delta', event_id: '2', delta: 'Okay', start_ms: 150, end_ms: 250 });
    ledger.add({ type: 'session.input_transcript.delta', event_id: '3', delta: 'another exercise', start_ms: 210, end_ms: 400 });
    ledger.add(a);
    expect(ledger.messages('call').map(m => m.text)).toEqual(['Try another exercise', 'Okay']);
    expect(ledger.intent(450)).toBe('Try another exercise');
  });
  it('uses only context available at the delegation timeline position', () => {
    const ledger = new TranscriptLedger();
    ledger.add({ type: 'session.input_transcript.delta', delta: 'Explain it', start_ms: 100, end_ms: 500 });
    ledger.add({ type: 'session.input_transcript.delta', delta: 'Actually, give a hint', start_ms: 3000, end_ms: 4000 });
    expect(ledger.intent(1000)).toBe('Explain it');
  });

  it('selects only the latest contiguous question even when two questions are within twenty seconds', () => {
    const ledger = new TranscriptLedger();
    ledger.add({ type: 'session.input_transcript.delta', delta: 'What is a fraction?', start_ms: 100, end_ms: 1800 });
    ledger.add({ type: 'session.input_transcript.delta', delta: 'Now explain division.', start_ms: 7000, end_ms: 9000 });
    expect(ledger.intent(9500)).toBe('Now explain division.');
  });

  it('keeps a continuous request intact past twenty seconds and joins overlapping corrections', () => {
    const ledger = new TranscriptLedger();
    ledger.add({ type: 'session.input_transcript.delta', delta: 'Show me ', start_ms: 0, end_ms: 4000 });
    ledger.add({ type: 'session.input_transcript.delta', delta: 'how to solve ', start_ms: 3900, end_ms: 15000 });
    ledger.add({ type: 'session.input_transcript.delta', delta: 'this equation,', start_ms: 14900, end_ms: 27000 });
    ledger.add({ type: 'session.input_transcript.delta', delta: ' including the negative root.', start_ms: 26900, end_ms: 34000 });
    expect(ledger.intent(35000)).toBe('Show me how to solve this equation, including the negative root.');
  });

  it('rejects overlong delegated speech with guidance instead of silently truncating it', () => {
    const ledger = new TranscriptLedger();
    ledger.add({ type: 'session.input_transcript.delta', delta: 'x'.repeat(100_001), start_ms: 0, end_ms: 1000 });
    expect(() => ledger.intent(1000)).toThrow(/split it into shorter requests/i);
  });

  it('keeps usage monotonic when a final event is stale and reports the provider duration', async () => {
    const call = new LiveCall({ state() {}, transcripts() {}, async delegate() { return ''; }, error() {} });
    call.state = { phase: 'live', muted: false, sessionId: 'session-1', inputTranscript: '', outputTranscript: '', error: null };
    const internal = call as unknown as { providerId: string; receive(event: Record<string, unknown>): void };
    internal.providerId = 'provider-call-1';
    internal.receive({ type: 'session.usage.updated', usage: { seconds: 19 } });
    internal.receive({ type: 'session.closed', usage: { seconds: 8 } });
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    const bodies = vi.mocked(request).mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit & { body: string }).body)));
    expect(bodies.map(body => body.duration_seconds)).toEqual([19, 19]);
  });

  it('does not send a completed delegation from an ended call into the next call channel', async () => {
    let finish!: (value: string) => void;
    const delegate = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    const call = new LiveCall({ state() {}, transcripts() {}, delegate, error() {} });
    const oldChannel = { readyState: 'open', send: vi.fn(), close() {} };
    const internal = call as unknown as { channel: typeof oldChannel; generation: number; receive(event: Record<string, unknown>): void; fail(message: string): void };
    internal.channel = oldChannel;
    call.state = { phase: 'live', muted: false, sessionId: 'session-1', inputTranscript: '', outputTranscript: '', error: null };
    call.ledger.add({ type: 'session.input_transcript.delta', delta: 'Explain this.', start_ms: 0, end_ms: 400 });
    internal.receive({ type: 'session.delegation.created', offset_ms: 500, delegation: { id: 'd-1', target: 'client' } });
    await vi.waitFor(() => expect(delegate).toHaveBeenCalledOnce());
    internal.fail('connection closed');
    const nextChannel = { readyState: 'open', send: vi.fn(), close() {} };
    internal.channel = nextChannel;
    finish('stale result');
    await Promise.resolve(); await Promise.resolve();
    expect(oldChannel.send).not.toHaveBeenCalled();
    expect(nextChannel.send).not.toHaveBeenCalled();
  });

  it('beacons the last known usage and closes the channel during pagehide', async () => {
    const beacons: Array<{ url: string | URL; data?: BodyInit | null }> = [];
    const sendBeacon: Navigator['sendBeacon'] = (url, data) => { beacons.push({ url, data }); return true; };
    vi.stubGlobal('navigator', { sendBeacon });
    const call = new LiveCall({ state() {}, transcripts() {}, async delegate() { return ''; }, error() {} });
    const channel = { readyState: 'open', send: vi.fn(), close: vi.fn() };
    const internal = call as unknown as { providerId: string; channel: typeof channel; seconds: number };
    internal.providerId = 'provider-call-2'; internal.channel = channel; internal.seconds = 13;
    call.state = { phase: 'live', muted: false, sessionId: 'session-2', inputTranscript: '', outputTranscript: '', error: null };
    call.pageHide();
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('session.close'));
    expect(beacons).toHaveLength(1);
    expect(beacons[0].url).toBe('/v1/live/usage');
    const usageBlob = beacons[0].data as Blob;
    expect(usageBlob.type).toBe('application/json');
    expect(JSON.parse(await usageBlob.text())).toMatchObject({ session_id: 'session-2', live_session_id: 'provider-call-2', duration_seconds: 13 });
  });

  it('does not enter resting state when the provider failed to confirm close', async () => {
    const call = new LiveCall({ state() {}, transcripts() {}, async delegate() { return ''; }, error() {} });
    call.state = { phase: 'error', muted: false, sessionId: 'session-3', inputTranscript: '', outputTranscript: '', error: 'close failed' };
    vi.spyOn(call, 'end').mockImplementation(async () => {});
    await call.rest();
    expect(call.state.phase).toBe('error');
  });
});
