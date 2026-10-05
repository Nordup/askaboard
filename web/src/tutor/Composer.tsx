import { useEffect, useRef, useState } from 'react';
import type { Attachment, Capture } from '../types';
import type { VoiceState } from '../ui-types';
import { Icon, VoiceChatIcon } from '../design/Icon';

interface DraftAttachment { attachment: Attachment; preview: string | null }
interface ComposerProps {
  ready: boolean;
  selectedCapture: Capture | null;
  voice: VoiceState;
  dictationState: 'idle' | 'recording' | 'transcribing';
  busy: boolean;
  liveAvailable: boolean;
  onStop(): void;
  onSend(text: string, attachmentIds: string[], capture: Capture | null): Promise<void>;
  onAttach(files: File[]): Promise<Attachment[]>;
  onClearCapture(): void;
  onDictation(): Promise<string>;
  onVoiceAction(action: 'start' | 'end' | 'mute' | 'rest' | 'wake' | 'return'): Promise<void> | void;
}

export function Composer(props: ComposerProps) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dictating, setDictating] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const previewUrls = useRef(new Set<string>());
  useEffect(() => () => { previewUrls.current.forEach(URL.revokeObjectURL); previewUrls.current.clear(); }, []);
  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    try {
      const loaded = await props.onAttach(files);
      setAttachments(current => [...current, ...loaded.map((attachment, index) => { const preview = files[index]?.type.startsWith('image/') ? URL.createObjectURL(files[index]) : null; if (preview) previewUrls.current.add(preview); return { attachment, preview }; })]);
    } catch { /* Root surfaces attachment errors through status. */ } finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  const removeAttachment = (id: string) => setAttachments(current => {
    const removed = current.find(item => item.attachment.id === id);
    if (removed?.preview) { URL.revokeObjectURL(removed.preview); previewUrls.current.delete(removed.preview); }
    return current.filter(item => item.attachment.id !== id);
  });
  const submit = async () => {
    const submittedText = text;
    const value = text.trim();
    if ((!value && !attachments.length && !props.selectedCapture) || !props.ready || props.busy || uploading) return;
    try { await props.onSend(value, attachments.map(item => item.attachment.id), props.selectedCapture); } catch { return; }
    attachments.forEach(item => { if (item.preview) { URL.revokeObjectURL(item.preview); previewUrls.current.delete(item.preview); } });
    setAttachments([]);
    setText(current => current === submittedText ? '' : current);
    props.onClearCapture();
    textRef.current?.focus();
  };
  const handleDictation = async () => {
    if (props.dictationState === 'transcribing') return;
    if (dictating) { try { await props.onDictation(); } catch { /* Root surfaces dictation errors. */ } return; }
    setDictating(true);
    try {
      const transcript = await props.onDictation();
      if (transcript.trim()) setText(current => [current.trimEnd(), transcript.trim()].filter(Boolean).join(current.trim() ? ' ' : ''));
      textRef.current?.focus();
    } catch { /* The root surfaces dictation failures through status. */ } finally { setDictating(false); }
  };
  const sendDisabled = props.busy || uploading || (!text.trim() && !attachments.length && !props.selectedCapture);
  return <div className="composer-wrap">
    {props.selectedCapture && <div className="selection-preview">
      <img src={`data:image/png;base64,${props.selectedCapture.image_base64}`} alt="Selected board region" />
      <div><div className="selection-label">Selection</div><div className="status-sync">Attached to this question</div></div>
      <button className="icon-button" style={{ marginLeft: 'auto' }} aria-label="Remove board selection" onClick={props.onClearCapture}><Icon name="composer/dismiss" /></button>
    </div>}
    {attachments.length > 0 && <div className="attachment-list">{attachments.map(({ attachment, preview }) => <div className="attachment-chip" key={attachment.id} title={attachment.filename}>{preview && <img src={preview} alt="" width={22} height={22} style={{ borderRadius: 4, objectFit: 'cover' }} />}<span>{attachment.filename}</span><button className="icon-button" style={{ width: 24, height: 24, flexBasis: 24 }} aria-label={`Remove ${attachment.filename}`} onClick={() => removeAttachment(attachment.id)}><Icon name="composer/dismiss" size={14} /></button></div>)}</div>}
    <form className="composer" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <input ref={fileRef} hidden type="file" multiple accept="image/*,.pdf,.txt,.md" onChange={event => void addFiles(Array.from(event.target.files ?? []))} />
      <button className="icon-button" type="button" aria-label="Attach image or file" disabled={!props.ready || uploading} onClick={() => fileRef.current?.click()}><Icon name="ui/plus" size={20} /></button>
      <textarea ref={textRef} disabled={!props.ready} rows={1} value={text} onChange={event => setText(event.target.value)} placeholder="Ask anything..." aria-label="Message the tutor" onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); } }} />
      <button className="icon-button" type="button" aria-label={dictating || props.dictationState === 'recording' ? 'Stop dictation' : 'Dictate message'} disabled={!props.ready || props.dictationState === 'transcribing'} onClick={() => void handleDictation()}><Icon name="composer/voice" size={22} /></button>
      {props.busy ? <button className="send-button stop-button" type="button" aria-label="Stop response" onClick={props.onStop}><Icon name="composer/dismiss" size={22} /></button> : text.trim() || attachments.length || props.selectedCapture ? <button className="send-button" type="submit" aria-label="Send message" disabled={sendDisabled}><Icon name="composer/send" size={24} /></button> : props.voice.phase !== 'idle' && props.voice.phase !== 'error' ? <button className="send-button stop-button" type="button" aria-label="End voice conversation" onClick={() => void props.onVoiceAction('end')}><Icon name="composer/dismiss" size={22} /></button> : <button className="send-button" type="button" aria-label={props.liveAvailable ? 'Start voice conversation' : 'Voice conversation unavailable'} title={props.liveAvailable ? 'Start a voice conversation' : 'Voice is not configured'} disabled={!props.liveAvailable} onClick={() => void props.onVoiceAction('start')}><VoiceChatIcon /></button>}
    </form>
    {(props.dictationState !== 'idle' || props.voice.phase !== 'idle') && <div className="composer-footer">
      {props.dictationState !== 'idle' && <span className="voice-dock-controls"><i className="recording-dot" />{props.dictationState === 'recording' ? 'Listening' : 'Transcribing'}</span>}
      {props.voice.phase !== 'idle' && <span className="voice-dock-controls"><span>{props.voice.phase === 'live' ? 'Voice live' : props.voice.phase === 'resting' ? 'Resting' : props.voice.phase === 'connecting' ? 'Connecting' : props.voice.phase === 'error' ? 'Voice unavailable' : 'Ending'}</span><button className="voice-action" aria-label={props.voice.muted ? 'Unmute voice' : 'Mute voice'} onClick={() => void props.onVoiceAction('mute')}>{props.voice.muted ? 'Unmute' : 'Mute'}</button><button className="voice-action" aria-label={props.voice.phase === 'resting' ? 'Wake voice' : 'Rest voice'} onClick={() => void props.onVoiceAction(props.voice.phase === 'resting' ? 'wake' : 'rest')}>{props.voice.phase === 'resting' ? 'Wake' : 'Rest'}</button><button className="icon-button" aria-label="End voice" onClick={() => void props.onVoiceAction('end')}><Icon name="composer/dismiss" /></button></span>}
    </div>}
    {props.voice.inputTranscript && <div className="voice-transcript" aria-live="polite">You: {props.voice.inputTranscript}</div>}
    {props.voice.outputTranscript && <div className="voice-transcript" aria-live="polite">Tutor: {props.voice.outputTranscript}</div>}
  </div>;
}
