import { describe, expect, it } from 'vitest';
import { consumeSSE, parseFrame } from './client';

function streamed(chunks: Uint8Array[]) {
  return new Response(new ReadableStream({ start(c) { chunks.forEach(chunk => c.enqueue(chunk)); c.close(); } }));
}
describe('application SSE protocol', () => {
  it('handles CRLF, comments and multi-line data', () => {
    expect(parseFrame(': ping\r\nevent: update\r\ndata: {"type":"text_delta",\r\ndata: "text":"hi"}')).toEqual({ type: 'text_delta', text: 'hi' });
    expect(parseFrame(': keepalive')).toBeNull();
  });
  it('preserves split UTF-8 and arbitrary frame boundaries', async () => {
    const bytes = new TextEncoder().encode('data: {"type":"text_delta","text":"π 🖊"}\r\n\r\ndata: {"type":"done"}\n\n');
    const chunks = [...bytes].map(b => new Uint8Array([b]));
    const events: unknown[] = [];
    await consumeSSE(streamed(chunks), e => { events.push(e); });
    expect(events).toEqual([{ type: 'text_delta', text: 'π 🖊' }, { type: 'done' }]);
  });
  it('never treats truncated output or an error as a completed answer', async () => {
    const encoder = new TextEncoder();
    await expect(consumeSSE(streamed([encoder.encode('data: {"type":"text_delta","text":"partial"}\n\n')]), () => {})).rejects.toThrow('before finishing');
    await expect(consumeSSE(streamed([encoder.encode('data: {"type":"error","message":"Failed"}\n\n')]), () => {})).rejects.toThrow('Failed');
  });
});
