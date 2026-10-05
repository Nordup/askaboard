import { consumeSSE } from '../api/client';

export function pcmWav(chunks: Float32Array[], rate: number): Blob {
  const length = chunks.reduce((n, c) => n + c.length, 0);
  const buffer = new ArrayBuffer(44 + length * 2); const view = new DataView(buffer);
  function label(offset: number, value: string) { [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0))); }
  label(0, 'RIFF'); view.setUint32(4, 36 + length * 2, true); label(8, 'WAVE'); label(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  label(36, 'data'); view.setUint32(40, length * 2, true);
  let offset = 44; for (const chunk of chunks) for (const sample of chunk) {
    const s = Math.max(-1, Math.min(1, sample)); view.setInt16(offset, s < 0 ? s * 32768 : s * 32767, true); offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export class Dictation {
  private stream?: MediaStream;
  private context?: AudioContext;
  private node?: AudioWorkletNode;
  private chunks: Float32Array[] = [];
  private complete?: (text: string) => void;
  private reject?: (error: Error) => void;
  private timer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private starting = false;
  private cancelled = false;
  private sessionId: string | null = null;
  private controller?: AbortController;
  constructor(private state: (state: 'idle' | 'recording' | 'transcribing') => void) {}
  async start(sessionId: string): Promise<string> {
    if (this.stream || this.starting || this.stopping) { void this.stop(); return ''; }
    this.starting = true; this.cancelled = false; this.sessionId = sessionId; this.chunks = [];
    const result = new Promise<string>((resolve, reject) => { this.complete = resolve; this.reject = reject; });
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (this.cancelled) { this.complete?.(''); await this.cleanup(); return result; }
      this.context = new AudioContext();
      const module = URL.createObjectURL(new Blob([`class Capture extends AudioWorkletProcessor {
        process(inputs) { const channel = inputs[0]?.[0]; if (channel) this.port.postMessage(new Float32Array(channel)); return true; }
      } registerProcessor('math-tutor-capture', Capture);`], { type: 'text/javascript' }));
      try { await this.context.audioWorklet.addModule(module); } finally { URL.revokeObjectURL(module); }
      if (this.cancelled) { this.complete?.(''); await this.cleanup(); return result; }
      this.node = new AudioWorkletNode(this.context, 'math-tutor-capture');
      this.node.port.onmessage = event => { this.chunks.push(event.data); };
      const mute = this.context.createGain(); mute.gain.value = 0;
      this.context.createMediaStreamSource(this.stream).connect(this.node); this.node.connect(mute).connect(this.context.destination);
      await this.context.resume();
      if (this.cancelled) { this.complete?.(''); await this.cleanup(); return result; }
      this.starting = false; this.state('recording');
      this.timer = setTimeout(() => { void this.stop(); }, 60000);
    } catch (error) {
      if (this.cancelled) this.complete?.('');
      else this.reject?.(error instanceof Error ? error : new Error('Dictation could not start.'));
      await this.cleanup();
    }
    return result;
  }
  async stop() {
    if (this.starting) {
      this.cancelled = true; this.state('transcribing');
      return;
    }
    if (!this.context || this.stopping || !this.sessionId) return;
    this.stopping = true; clearTimeout(this.timer); this.state('transcribing');
    const audio = pcmWav(this.chunks, this.context.sampleRate);
    const form = new FormData(); form.append('session_id', this.sessionId); form.append('audio', audio, 'speech.wav');
    try {
      this.stream?.getTracks().forEach(t => t.stop()); this.stream = undefined;
      this.controller = new AbortController();
      const response = await fetch('/v1/dictation', { method: 'POST', credentials: 'same-origin', body: form, signal: this.controller.signal });
      let text = '';
      await consumeSSE(response, e => { if (e.type === 'done') text = typeof e.text === 'string' ? e.text : ''; });
      this.complete?.(text);
    } catch (error) { this.reject?.(error instanceof Error ? error : new Error('Dictation failed.')); }
    finally { await this.cleanup(); }
  }
  cancel() {
    clearTimeout(this.timer); this.cancelled = true;
    if (this.starting) { this.state('idle'); this.complete?.(''); return; }
    this.controller?.abort(); this.complete?.(''); void this.cleanup();
  }
  async cleanup() {
    clearTimeout(this.timer); this.stream?.getTracks().forEach(t => t.stop()); this.node?.disconnect();
    await this.context?.close(); this.context = undefined; this.stream = undefined; this.node = undefined;
    this.complete = undefined; this.reject = undefined; this.stopping = false; this.state('idle');
    this.starting = false; this.cancelled = false; this.sessionId = null; this.controller = undefined;
  }
}
