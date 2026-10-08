import { useEffect, useRef, useState } from 'react';
import type { Attachment, Capture, LearningSignal } from '../types';
import type { VoiceState } from '../ui-types';
import { Icon, VoiceChatIcon } from '../design/Icon';
import { SessionDrafts, type SessionDraft } from './session-drafts';

interface ComposerProps {
  sessionId: string;
  ready: boolean;
  selectedCapture: Capture | null;
  voice: VoiceState;
  dictationState: 'idle' | 'recording' | 'transcribing';
  busy: boolean;
  liveAvailable: boolean;
  selectionMode: boolean;
  canSelectBoard: boolean;
  editDraft: { messageId: string; text: string } | null;
  onStop(): void;
  onSend(text: string, attachments: Attachment[], capture: Capture | null, signal?: LearningSignal): Promise<void>;
  onSubmitEdit(messageId: string, text: string): Promise<void>;
  onCancelEdit(): void;
  onAttach(files: File[]): Promise<Attachment[]>;
  onClearCapture(): void;
  onToggleSelection(): void;
  onDictation(): Promise<string>;
  onVoiceAction(action: 'start' | 'end' | 'mute' | 'rest' | 'wake' | 'return'): Promise<void> | void;
}

const attachmentLimit = 5;
const activeVoice = (voice: VoiceState) => voice.phase !== 'idle' && voice.phase !== 'error';
const wasAccepted = (error: unknown) => Boolean(error && typeof error === 'object' && 'turnAccepted' in error && (error as { turnAccepted?: unknown }).turnAccepted === true);

export function Composer(props: ComposerProps) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [attachMenu, setAttachMenu] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const drafts = useRef(new SessionDrafts());
  const sessionId = useRef(props.sessionId);
  const editId = useRef<string | null>(null);
  const savedDraftBeforeEdit = useRef<SessionDraft | null>(null);
  const previousEdit = useRef<{ messageId: string; text: string } | null>(null);

  // Composer is deliberately a single mounted component across dock/full-screen changes.
  // Session-bound upload ids stay with their owning session and can never leak into another.
  useEffect(() => {
    if (sessionId.current !== props.sessionId) {
      const oldDraft = editId.current ? savedDraftBeforeEdit.current : null;
      if (editId.current) { editId.current = null; savedDraftBeforeEdit.current = null; }
      drafts.current.set(sessionId.current, oldDraft ?? { text, attachments });
      const next = drafts.current.get(props.sessionId);
      sessionId.current = props.sessionId;
      setText(next.text); setAttachments(next.attachments); setAttachMenu(false);
      props.onClearCapture();
    }
  }, [props.sessionId, text, attachments, props.onClearCapture]);

  useEffect(() => {
    if (!editId.current) drafts.current.set(props.sessionId, { text, attachments });
  }, [props.sessionId, text, attachments]);

  useEffect(() => {
    const edit = props.editDraft;
    if (edit && edit.messageId !== previousEdit.current?.messageId) {
      savedDraftBeforeEdit.current = { text, attachments };
      editId.current = edit.messageId;
      setText(edit.text); setAttachments([]); setAttachMenu(false);
      textRef.current?.focus();
    } else if (!edit && previousEdit.current) {
      editId.current = null; savedDraftBeforeEdit.current = null;
    }
    previousEdit.current = edit;
  }, [props.editDraft, text, attachments]);

  useEffect(() => {
    const field = textRef.current;
    if (!field) return;
    field.style.height = 'auto';
    const line = Number.parseFloat(getComputedStyle(field).lineHeight) || 22;
    field.style.height = `${Math.min(field.scrollHeight, line * 5)}px`;
    field.style.overflowY = field.scrollHeight > line * 5 ? 'auto' : 'hidden';
  }, [text]);

  const addFiles = async (files: File[]) => {
    const available = Math.max(0, attachmentLimit - attachments.length);
    const selected = files.slice(0, available);
    if (!selected.length) return;
    const targetSession = props.sessionId;
    setUploading(true); setAttachMenu(false);
    try {
      const loaded = await props.onAttach(selected);
      const next = drafts.current.appendAttachments(targetSession, loaded, attachmentLimit);
      if (sessionId.current === targetSession) setAttachments(next.attachments);
    } catch { /* The parent surfaces the upload failure. */ }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; if (libraryRef.current) libraryRef.current.value = ''; if (photoRef.current) photoRef.current.value = ''; }
  };

  const submit = async () => {
    const value = text.trim();
    if ((!value && !attachments.length && !props.selectedCapture) || !props.ready || props.busy || uploading) return;
    const targetSession = props.sessionId;
    const activeEdit = editId.current;
    if (activeEdit) {
      const draftBeforeEdit = savedDraftBeforeEdit.current;
      try { await props.onSubmitEdit(activeEdit, value); }
      catch (error) {
        if (!wasAccepted(error)) return;
        const restored = draftBeforeEdit ?? { text: '', attachments: [] };
        drafts.current.set(targetSession, restored);
        savedDraftBeforeEdit.current = null; editId.current = null;
        if (sessionId.current === targetSession) { setText(restored.text); setAttachments(restored.attachments); textRef.current?.focus(); }
        return;
      }
      savedDraftBeforeEdit.current = null; editId.current = null;
      // Parent acceptance clears editDraft while the request is in flight. Keep this
      // snapshot local so that effect cleanup cannot erase the user's original draft.
      const restored = draftBeforeEdit ?? { text: '', attachments: [] };
      drafts.current.set(targetSession, restored);
      if (sessionId.current === targetSession) {
        setText(restored.text); setAttachments(restored.attachments); textRef.current?.focus();
      }
      return;
    }
    const submittedText = text;
    const voiceTakesText = activeVoice(props.voice) && props.voice.phase !== 'resting';
    if (voiceTakesText) {
      // Swift routes only typed words into an awake call. Files and a board crop remain
      // attached to the ordinary composer draft for a later tutor turn.
      if (!value) return;
      try { await props.onSend(value, [], null, undefined); }
      catch (error) {
        if (!wasAccepted(error)) return;
      }
      const remaining = drafts.current.consumeAcceptedText(targetSession, submittedText);
      if (sessionId.current === targetSession) {
        setText(remaining.text);
        textRef.current?.focus();
      }
      return;
    }
    const submittedIds = new Set(attachments.map(item => item.id));
    const settleAcceptedSend = () => {
      const remaining = drafts.current.consumeAccepted(targetSession, submittedText, submittedIds);
      if (sessionId.current === targetSession) {
        setAttachments(current => current.filter(item => !submittedIds.has(item.id)));
        setText(current => current === submittedText ? '' : current);
        if (props.selectedCapture) props.onClearCapture();
        textRef.current?.focus();
      }
      return remaining;
    };
    try { await props.onSend(value, attachments, props.selectedCapture, undefined); }
    catch (error) { if (wasAccepted(error)) settleAcceptedSend(); return; }
    settleAcceptedSend();
  };

  const handleDictation = async () => {
    if (props.dictationState === 'transcribing' || activeVoice(props.voice)) return;
    if (dictating) { try { await props.onDictation(); } catch { /* The parent surfaces dictation errors. */ } return; }
    setDictating(true);
    try {
      const transcript = await props.onDictation();
      if (transcript.trim()) setText(current => [current.trimEnd(), transcript.trim()].filter(Boolean).join(current.trim() ? ' ' : ''));
      textRef.current?.focus();
    } catch { /* The parent surfaces dictation failures. */ }
    finally { setDictating(false); }
  };

  const cancelEdit = () => {
    const draft = savedDraftBeforeEdit.current;
    editId.current = null; savedDraftBeforeEdit.current = null;
    props.onCancelEdit();
    setText(draft?.text ?? ''); setAttachments(draft?.attachments ?? []);
  };
  const hasVoice = activeVoice(props.voice);
  const voiceTakesText = hasVoice && props.voice.phase !== 'resting';
  const sendDisabled = props.busy || uploading || (voiceTakesText && !text.trim()) || (!text.trim() && !attachments.length && !props.selectedCapture);
  return <div className="tutor-composer-shell">
    {props.editDraft && <div className="tutor-editing-note"><span>Editing message</span><button type="button" onClick={cancelEdit} aria-label="Cancel edit"><Icon name="composer/dismiss" size={16} /></button></div>}
    {props.selectedCapture && <div className="tutor-selection-preview">
      <img src={`data:image/png;base64,${props.selectedCapture.image_base64}`} alt="Selected board region" />
      <div><div className="tutor-selection-label">Selection</div><div className="tutor-selection-caption">Attached to this question</div></div>
      <button type="button" aria-label="Remove board selection" onClick={props.onClearCapture}><Icon name="composer/dismiss" /></button>
    </div>}
    {!!attachments.length && <div className="tutor-attachment-list" aria-label="Attached files">{attachments.map(attachment => <div className="tutor-attachment-chip" key={attachment.id} title={attachment.filename}>
      {attachment.thumbnail_base64 && <img src={`data:image/jpeg;base64,${attachment.thumbnail_base64}`} alt="" />}
      <span>{attachment.filename}</span><button type="button" aria-label={`Remove ${attachment.filename}`} onClick={() => setAttachments(current => current.filter(item => item.id !== attachment.id))}><Icon name="composer/dismiss" size={14} /></button>
    </div>)}</div>}
    <form className="tutor-composer" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <input ref={fileRef} hidden type="file" multiple accept="image/*,.pdf,.txt,.md" onChange={event => void addFiles(Array.from(event.target.files ?? []))} />
      <input ref={libraryRef} hidden type="file" multiple accept="image/*" onChange={event => void addFiles(Array.from(event.target.files ?? []))} />
      <input ref={photoRef} hidden type="file" accept="image/*" capture="environment" onChange={event => void addFiles(Array.from(event.target.files ?? []))} />
      <div className="tutor-attach-control">
        <button className="tutor-composer-icon" type="button" aria-label="Attach a file" disabled={!props.ready || props.busy || uploading || attachments.length >= attachmentLimit} aria-expanded={attachMenu} onClick={() => setAttachMenu(value => !value)}><Icon name="ui/plus" size={20} /></button>
        {attachMenu && <div className="tutor-attach-menu" role="menu" aria-label="Attach">
          <button type="button" role="menuitem" onClick={() => libraryRef.current?.click()}>Photo Library</button>
          <button type="button" role="menuitem" onClick={() => photoRef.current?.click()}>Take Photo</button>
          <button type="button" role="menuitem" onClick={() => fileRef.current?.click()}>Files</button>
        </div>}
      </div>
      {props.canSelectBoard && !hasVoice && <button className={`tutor-composer-icon tutor-select-button ${props.selectionMode ? 'is-active' : ''}`} type="button" aria-label={props.selectionMode ? 'Cancel board selection' : 'Select board area'} aria-pressed={props.selectionMode} disabled={props.busy} onClick={props.onToggleSelection}><Icon name="ui/selection-marker" size={24} /></button>}
      <textarea ref={textRef} disabled={!props.ready} rows={1} value={text} onChange={event => setText(event.target.value)} placeholder="Ask anything..." aria-label="Message the tutor" onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); } }} />
      {hasVoice ? <button className={`tutor-composer-icon tutor-mute-button ${props.voice.muted ? 'is-active' : ''}`} type="button" aria-label={props.voice.muted ? 'Unmute voice' : 'Mute voice'} aria-pressed={props.voice.muted} onClick={() => void props.onVoiceAction('mute')}><Icon name="composer/voice" size={20} /></button>
        : <button className="tutor-composer-icon" type="button" aria-label={dictating || props.dictationState === 'recording' ? 'Stop dictation' : 'Dictate message'} disabled={!props.ready || props.dictationState === 'transcribing'} onClick={() => void handleDictation()}><Icon name="composer/voice" size={22} /></button>}
      {props.busy ? <button className="tutor-send-button tutor-stop-button" type="button" aria-label="Stop response" onClick={props.onStop}><Icon name="composer/dismiss" size={22} /></button>
        : text.trim() || attachments.length || props.selectedCapture ? <button className="tutor-send-button" type="submit" aria-label={props.editDraft ? 'Resend edited message' : 'Send message'} disabled={sendDisabled}><Icon name="composer/send" size={24} /></button>
          : hasVoice ? <button className="tutor-send-button tutor-stop-button" type="button" aria-label="End voice conversation" onClick={() => void props.onVoiceAction('end')}><Icon name="composer/dismiss" size={22} /></button>
            : <button className="tutor-send-button" type="button" aria-label={props.liveAvailable ? 'Start voice conversation' : 'Voice conversation unavailable'} title={props.liveAvailable ? 'Start a voice conversation' : 'Voice is not configured'} disabled={!props.liveAvailable} onClick={() => void props.onVoiceAction('start')}><VoiceChatIcon /></button>}
    </form>
    {(props.dictationState !== 'idle' || hasVoice || uploading) && <div className="tutor-composer-footer">
      {uploading && <span>Uploading…</span>}
      {props.dictationState !== 'idle' && <span><i className="tutor-recording-dot" />{props.dictationState === 'recording' ? 'Listening' : 'Transcribing'}</span>}
      {hasVoice && <span className="tutor-voice-controls">
        <span>{props.voice.phase === 'live' || props.voice.phase === 'listening' ? 'Listening' : props.voice.phase === 'thinking' ? 'Thinking' : props.voice.phase === 'talking' ? 'Speaking' : props.voice.phase === 'resting' ? 'Resting' : props.voice.phase === 'connecting' ? 'Connecting' : props.voice.phase === 'error' ? 'Voice unavailable' : 'Ending'}</span>
        <button type="button" onClick={() => void props.onVoiceAction(props.voice.phase === 'resting' ? 'wake' : 'rest')} aria-label={props.voice.phase === 'resting' ? 'Wake voice' : 'Rest voice'}>{props.voice.phase === 'resting' ? 'Wake' : 'Rest'}</button>
        <button type="button" aria-label="End voice" onClick={() => void props.onVoiceAction('end')}><Icon name="composer/dismiss" size={16} /></button>
      </span>}
    </div>}
    {props.voice.inputTranscript && <div className="tutor-voice-transcript" aria-live="polite">You: {props.voice.inputTranscript}</div>}
    {props.voice.outputTranscript && <div className="tutor-voice-transcript" aria-live="polite">Tutor: {props.voice.outputTranscript}</div>}
  </div>;
}
