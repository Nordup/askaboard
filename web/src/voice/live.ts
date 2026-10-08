import { json, request } from '../api/client';
import type { Message } from '../types';

export interface LiveState {
  phase: 'idle' | 'connecting' | 'live' | 'listening' | 'thinking' | 'talking' | 'resting' | 'closing' | 'error';
  muted: boolean; sessionId: string | null;
  inputTranscript: string; outputTranscript: string; error: string | null;
  inputLevel?: number; outputLevel?: number;
}
interface Fragment { speaker: 'user' | 'assistant'; text: string; start: number; end: number; id: string; }
const UTTERANCE_GAP_MS = 1800;
const MAX_DELEGATION_CHARS = 100_000;
// GPT-Live accepts at most 500 tokens per append. A 450-byte UTF-8 ceiling
// stays under that limit even for token-dense text without adding a tokenizer.
export const MAX_LIVE_APPEND_BYTES = 450;

export function capLiveAppend(content: string, maxBytes = MAX_LIVE_APPEND_BYTES): string {
  const encoder = new TextEncoder();
  let usedBytes = 0;
  let result = '';
  for (const character of content) {
    const size = encoder.encode(character).byteLength;
    if (usedBytes + size > maxBytes) break;
    result += character;
    usedBytes += size;
  }
  return result;
}
export class TranscriptLedger {
  fragments: Fragment[] = [];
  seen = new Set<string>();
  add(event: Record<string, unknown>): boolean {
    const id = typeof event.event_id === 'string' ? event.event_id : '';
    if (id && this.seen.has(id)) return false;
    if (typeof event.delta !== 'string' || !Number.isFinite(event.start_ms) || !Number.isFinite(event.end_ms)) return false;
    if (id) this.seen.add(id);
    this.fragments.push({ speaker: event.type === 'session.input_transcript.delta' ? 'user' : 'assistant',
      text: event.delta, start: Number(event.start_ms), end: Number(event.end_ms), id });
    return true;
  }
  caption(speaker: Fragment['speaker']) {
    const parts = this.fragments.filter(f => f.speaker === speaker).sort((a, b) => a.start - b.start || a.end - b.end);
    const end = parts.reduce((latest, fragment) => Math.max(latest, fragment.end), 0);
    return parts.filter(f => f.end > end - 15000).map(f => f.text).join('');
  }
  private groups(speaker: Fragment['speaker'], offset = Infinity) {
    const groups: Array<{ speaker: Fragment['speaker']; text: string; start: number; end: number }> = [];
    const fragments = this.fragments.filter(f => f.speaker === speaker && f.start <= offset)
      .sort((a, b) => a.start - b.start || a.end - b.end);
    for (const fragment of fragments) {
      const previous = groups.at(-1);
      if (previous && fragment.start - previous.end < UTTERANCE_GAP_MS && fragment.start >= previous.start) {
        previous.text += fragment.text;
        previous.end = Math.max(previous.end, fragment.end);
      } else groups.push({ speaker, text: fragment.text, start: fragment.start, end: fragment.end });
    }
    return groups;
  }
  intent(offset: number) {
    const utterance = this.groups('user', offset).at(-1)?.text ?? '';
    if (utterance.length > MAX_DELEGATION_CHARS) {
      throw new Error(`That spoken request is longer than ${MAX_DELEGATION_CHARS.toLocaleString()} characters. Please split it into shorter requests.`);
    }
    return utterance;
  }
  messages(prefix: string): Message[] {
    return [...this.groups('user'), ...this.groups('assistant')].sort((a, b) => a.start - b.start)
      .map(g => ({ id: `${prefix}-${g.speaker}-${g.start}`, role: g.speaker, text: g.text, isVoice: true }));
  }
}

export interface LiveCallbacks {
  state(state: LiveState): void;
  transcripts(sessionId: string, messages: Message[]): void;
  delegate(sessionId: string, text: string, delegationId: string): Promise<string>;
  error(message: string): void;
}
export class LiveCall {
  state: LiveState = { phase: 'idle', muted: false, sessionId: null, inputTranscript: '', outputTranscript: '', error: null };
  ledger = new TranscriptLedger();
  private peer?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private microphone?: MediaStream;
  private audio?: HTMLAudioElement;
  private providerId?: string;
  private sequence = 0;
  private seconds = 0;
  private finalized = false;
  private closeTimer?: ReturnType<typeof setTimeout>;
  private seenDelegations = new Set<string>();
  private tasks = Promise.resolve();
  private ending = false;
  private generation = 0;
  private waitingForTutor = false;
  private levelTimer?: ReturnType<typeof setInterval>;
  private levelSnapshots = new Map<string, { energy: number; duration: number }>();
  constructor(private callbacks: LiveCallbacks) {}
  private update(patch: Partial<LiveState>) { this.state = { ...this.state, ...patch }; this.callbacks.state(this.state); }
  private send(type: string, content?: string, delegationId: string | null = null) {
    if (this.channel?.readyState !== 'open') throw new Error('Voice is disconnected.');
    this.channel.send(JSON.stringify({ type, event_id: crypto.randomUUID(), ...(content === undefined ? {} : { content, delegation_id: delegationId }) }));
  }
  async start(sessionId: string) {
    if (this.peer || this.state.phase === 'connecting') return;
    const generation = ++this.generation;
    this.ledger = new TranscriptLedger(); this.seconds = 0; this.sequence = 0;
    this.providerId = undefined; this.finalized = false; this.ending = false; this.waitingForTutor = false; this.seenDelegations.clear(); this.levelSnapshots.clear();
    this.update({ phase: 'connecting', sessionId, error: null, muted: false, inputTranscript: '', outputTranscript: '', inputLevel: 0, outputLevel: 0 });
    try {
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (generation !== this.generation) { microphone.getTracks().forEach(track => track.stop()); return; }
      this.microphone = microphone;
      const peer = new RTCPeerConnection(); this.peer = peer;
      const audio = new Audio(); audio.autoplay = true; this.audio = audio;
      audio.addEventListener('playing', () => {
        if (generation === this.generation && !this.ending && this.state.phase !== 'resting') this.update({ phase: 'talking' });
      });
      const notPlaying = () => {
        if (generation === this.generation && !this.ending && this.state.phase !== 'resting') this.update({ phase: this.waitingForTutor ? 'thinking' : 'listening' });
      };
      audio.addEventListener('pause', notPlaying); audio.addEventListener('ended', notPlaying); audio.addEventListener('waiting', notPlaying);
      peer.addEventListener('track', event => {
        audio.srcObject = new MediaStream([event.track]);
        void audio.play().catch(() => this.callbacks.error('Your browser blocked voice playback. Start voice again from its button.'));
      });
      for (const track of microphone.getTracks()) peer.addTrack(track, microphone);
      this.levelTimer = setInterval(() => { void this.sampleLevels(peer, generation); }, 150);
      const channel = peer.createDataChannel('oai-events'); this.channel = channel;
      channel.addEventListener('message', event => {
        if (generation !== this.generation || this.channel !== channel) return;
        try { this.receive(JSON.parse(event.data)); }
        catch (error) { this.callbacks.error(error instanceof Error ? error.message : 'Invalid voice event.'); }
      });
      channel.addEventListener('close', () => {
        if (!this.finalized && this.peer === peer) this.fail('Voice disconnected before final usage was confirmed.');
      });
      peer.addEventListener('connectionstatechange', () => {
        if (peer.connectionState === 'failed' && this.peer === peer) this.fail('The voice connection failed.');
      });
      await peer.setLocalDescription(await peer.createOffer());
      if (generation !== this.generation) return;
      if (peer.iceGatheringState !== 'complete') await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { peer.removeEventListener('icegatheringstatechange', changed); reject(new Error('Voice connection setup timed out.')); }, 10000);
        function changed() { if (peer.iceGatheringState === 'complete') { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', changed); resolve(); } }
        peer.addEventListener('icegatheringstatechange', changed); changed();
      });
      const result = await request<{ session: { id: string }; transport: { sdp: string } }>('/v1/live/calls', json({ session_id: sessionId, sdp: peer.localDescription?.sdp }));
      if (generation !== this.generation) {
        const usage = { session_id: sessionId, live_session_id: result.session.id, model: 'gpt-live-1', duration_seconds: 0 };
        if (typeof navigator.sendBeacon === 'function') navigator.sendBeacon('/v1/live/usage', new Blob([JSON.stringify(usage)], { type: 'application/json' }));
        return;
      }
      this.providerId = result.session.id;
      await peer.setRemoteDescription({ type: 'answer', sdp: result.transport.sdp });
      if (generation !== this.generation) return;
      // HTTP creates the Live session. Do not send the Realtime session.start event.
      this.closeTimer = setTimeout(() => { if (this.state.phase === 'connecting') this.fail('Voice did not start. Please try again.'); }, 20000);
    } catch (error) {
      if (generation === this.generation) this.fail(error instanceof Error ? error.message : 'Could not start voice.');
    }
  }
  private receive(event: Record<string, unknown>) {
    switch (event.type) {
      case 'session.started':
        clearTimeout(this.closeTimer); this.update({ phase: 'listening' }); break;
      case 'session.input_transcript.delta': case 'session.output_transcript.delta':
        if (this.ledger.add(event)) {
          this.update({
            inputTranscript: this.ledger.caption('user'), outputTranscript: this.ledger.caption('assistant'),
            ...(event.type === 'session.input_transcript.delta' && this.state.phase !== 'talking' ? { phase: 'listening' as const } : {}),
          });
          if (this.state.sessionId) this.callbacks.transcripts(this.state.sessionId, this.ledger.messages(this.providerId ?? 'voice'));
        }
        break;
      case 'session.delegation.created': {
        const d = event.delegation as { id?: string; target?: string } | undefined;
        if (!d?.id || d.target !== 'client' || this.seenDelegations.has(d.id) || this.ending) break;
        this.waitingForTutor = true;
        if (this.state.phase !== 'talking') this.update({ phase: 'thinking' });
        this.seenDelegations.add(d.id);
        const revision = ++this.sequence; const generation = this.generation;
        const sessionId = this.state.sessionId; const id = d.id;
        const offset = typeof event.offset_ms === 'number' ? event.offset_ms : Infinity;
        this.tasks = this.tasks.then(async () => {
          if (!sessionId || generation !== this.generation || revision !== this.sequence || this.ending) return;
          try {
            const text = this.ledger.intent(offset);
            if (!text.trim()) { this.send('session.commentary.append', 'I did not receive enough of your request. Please repeat it.', id); return; }
            const result = await this.callbacks.delegate(sessionId, text, id);
            if (generation === this.generation && revision === this.sequence && !this.ending && this.channel?.readyState === 'open') {
              this.send('session.commentary.append', capLiveAppend(result) || 'The board work is complete.', id);
              this.waitingForTutor = false;
              if (this.state.phase !== 'talking') this.update({ phase: 'listening' });
            }
          } catch (error) {
            if (generation === this.generation && revision === this.sequence) { this.waitingForTutor = false; if (this.state.phase !== 'talking') this.update({ phase: 'listening' }); }
            if (generation === this.generation && !this.ending && this.channel?.readyState === 'open') this.send('session.commentary.append', 'The tutor could not finish that work. Your writing is saved. Please try again.', id);
            if (generation === this.generation && !this.ending) this.callbacks.error(error instanceof Error ? error.message : 'Delegated work failed.');
          }
        });
        break;
      }
      case 'session.usage.updated': {
        const usage = event.usage as { seconds?: number } | undefined;
        if (typeof usage?.seconds === 'number' && Number.isFinite(usage.seconds) && usage.seconds >= 0) {
          this.seconds = Math.max(this.seconds, usage.seconds); void this.reportUsage();
        }
        break;
      }
      case 'session.closed': {
        const usage = event.usage as { seconds?: number } | undefined;
        if (typeof usage?.seconds === 'number' && Number.isFinite(usage.seconds) && usage.seconds >= 0) this.seconds = Math.max(this.seconds, usage.seconds);
        this.finalized = true; void this.reportUsage(); this.sequence++; this.ending = true; this.cleanup(); this.update({ phase: 'idle', sessionId: null }); break;
      }
      case 'error': this.callbacks.error('The voice service rejected an event. Check the connection and try again.'); break;
    }
  }
  toggleMute() {
    const muted = !this.state.muted; this.microphone?.getAudioTracks().forEach(t => { t.enabled = !muted; });
    this.update({ muted });
  }
  async rest() {
    // Closing avoids charging for an indefinitely idle full-duplex session.
    const sessionId = this.state.sessionId; if (!sessionId) return;
    await this.end();
    if (this.state.phase === 'idle') this.update({ phase: 'resting', sessionId, muted: true });
  }
  async wake() { const id = this.state.sessionId; if (id && this.state.phase === 'resting') await this.start(id); }
  context(content: string) {
    if (this.state.phase === 'live' || this.state.phase === 'listening' || this.state.phase === 'thinking' || this.state.phase === 'talking') {
      this.send('session.thinking.append', capLiveAppend(content));
    }
  }
  commentary(content: string) {
    if (this.state.phase === 'live' || this.state.phase === 'listening' || this.state.phase === 'thinking' || this.state.phase === 'talking') {
      this.send('session.commentary.append', capLiveAppend(content), null);
    }
  }
  async end() {
    if (!this.peer) {
      this.generation++; this.sequence++; this.ending = true; this.cleanup(); this.update({ phase: 'idle', sessionId: null }); return;
    }
    this.ending = true; this.update({ phase: 'closing' });
    this.sequence++;
    // Finish our client-delegated backend work before closing the voice transport.
    await this.tasks;
    if (!this.peer) return;
    try { this.send('session.close'); }
    catch { this.fail('Voice disconnected before final usage was confirmed.'); return; }
    await new Promise<void>(resolve => {
      const poll = setInterval(() => { if (!this.peer) { clearInterval(poll); resolve(); } }, 100);
      this.closeTimer = setTimeout(() => { clearInterval(poll); this.fail('Voice ended without confirmed final usage.'); resolve(); }, 15000);
    });
  }
  /** Best-effort final accounting and transport close while a document is leaving. */
  pageHide() {
    const sessionId = this.state.sessionId;
    const providerId = this.providerId;
    if (sessionId && providerId) {
      try { if (this.channel?.readyState === 'open') this.send('session.close'); } catch { /* The peer is already closing. */ }
      const body = JSON.stringify({ session_id: sessionId, live_session_id: providerId, model: 'gpt-live-1', duration_seconds: Math.ceil(this.seconds) });
      try { if (typeof navigator.sendBeacon === 'function') navigator.sendBeacon('/v1/live/usage', new Blob([body], { type: 'application/json' })); }
      catch { /* Unload-time accounting is best effort. */ }
    }
    this.generation++; this.sequence++; this.ending = true; this.cleanup();
  }
  private async reportUsage() {
    if (!this.providerId || !this.state.sessionId) return;
    try { await request('/v1/live/usage', json({ session_id: this.state.sessionId, live_session_id: this.providerId, model: 'gpt-live-1', duration_seconds: Math.ceil(this.seconds) })); }
    catch { this.callbacks.error('Voice ended, but its usage report could not be saved.'); }
  }
  private async sampleLevels(peer: RTCPeerConnection, generation: number) {
    if (generation !== this.generation || peer !== this.peer) return;
    try {
      const stats = await peer.getStats();
      let inputLevel = 0; let outputLevel = 0;
      for (const item of stats.values()) {
        if (item.type !== 'inbound-rtp' && item.type !== 'outbound-rtp') continue;
        const report = item as RTCStats & {
          kind?: string; mediaType?: string; totalAudioEnergy?: number; totalSamplesDuration?: number;
        };
        if (report.kind !== 'audio' && report.mediaType !== 'audio') continue;
        const previous = this.levelSnapshots.get(report.id);
        const energy = report.totalAudioEnergy;
        const duration = report.totalSamplesDuration;
        let level = 0;
        if (typeof energy === 'number' && typeof duration === 'number' && previous && duration > previous.duration) {
          level = Math.sqrt(Math.max(0, (energy - previous.energy) / (duration - previous.duration)));
        }
        if (typeof energy === 'number' && typeof duration === 'number') this.levelSnapshots.set(report.id, { energy, duration });
        if (report.type === 'outbound-rtp') inputLevel = Math.max(inputLevel, level);
        else outputLevel = Math.max(outputLevel, level);
      }
      if (generation === this.generation && peer === this.peer) this.update({ inputLevel: Math.min(1, inputLevel), outputLevel: Math.min(1, outputLevel) });
    } catch { /* Some browsers expose no audio-energy stats; phase motion still follows playback. */ }
  }
  private fail(message: string) {
    void this.reportUsage(); this.generation++; this.sequence++; this.ending = true; this.cleanup(); this.update({ phase: 'error', error: message }); this.callbacks.error(message);
  }
  private cleanup() {
    clearTimeout(this.closeTimer); clearInterval(this.levelTimer); this.levelTimer = undefined; const peer = this.peer; this.peer = undefined;
    this.channel?.close(); peer?.close(); this.microphone?.getTracks().forEach(t => t.stop());
    if (this.audio) { this.audio.pause(); this.audio.srcObject = null; }
    this.channel = undefined; this.microphone = undefined; this.audio = undefined; this.levelSnapshots.clear(); this.waitingForTutor = false;
  }
}
