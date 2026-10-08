import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import type { Message } from '../types';
import { mediaDataUrl, loadMedia } from '../workspace/media';
import { Icon } from '../design/Icon';
import { ActivityTrail } from './ActivityTrail';

export function adaptLatexDelimiters(source: string): string {
  const saved: string[] = [];
  const protect = (value: string) => `\u0000${saved.push(value) - 1}\u0000`;
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let fence: '`' | '~' | null = null;
  let fenceLength = 0;
  let text = lines.map(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      const literal = protect(line);
      if (marker && marker[1][0] === fence && marker[1].length >= fenceLength && /^ {0,3}(`+|~+)[ \t]*(?:\n)?$/.test(line)) fence = null;
      return literal;
    }
    if (marker) {
      fence = marker[1][0] as '`' | '~';
      fenceLength = marker[1].length;
      return protect(line);
    }
    return line;
  }).join('');
  text = text.replace(/(`+)[^`\n]*?\1/g, protect);
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, (_, formula: string) => `$$\n${formula.trim()}\n$$`);
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, (_, formula: string) => `$${formula}$`);
  return text.replace(/\u0000(\d+)\u0000/g, (_, index: string) => saved[Number(index)] ?? '');
}

export function RichText({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{adaptLatexDelimiters(text)}</ReactMarkdown>;
}

function SelectionImage({ sessionId, imageId, label }: { sessionId: string; imageId: string; label: string }) {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void loadMedia(sessionId, imageId).then(value => { if (current && value) setImage(mediaDataUrl(value)); });
    return () => { current = false; };
  }, [sessionId, imageId]);
  return image ? <img className="tutor-message-capture" src={image} alt={label || 'Selected board region'} /> : null;
}

export function MessageView({ message, sessionId, onEdit, onCopy }: {
  message: Message;
  sessionId: string;
  onEdit?: (messageId: string) => void;
  onCopy?: (text: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const trail = useMemo(() => {
    const current = message.activity ?? { items: [] };
    const hasSearch = current.items.some(item => item.kind === 'search');
    return message.sources?.length && !hasSearch
      ? { ...current, items: [...current.items, { kind: 'search' as const, id: `${message.id}-sources`, query: '', sources: message.sources }] }
      : current;
  }, [message.activity, message.id, message.sources]);

  if (message.role === 'user') {
    const attachments = message.attachments ?? [];
    const canEdit = !!onEdit && !attachments.length && !message.capture && !message.signal && !message.isVoice;
    return <div className="tutor-message-row tutor-message-row--user">
      <div className="tutor-message-sent-media">
        {message.capture && <SelectionImage sessionId={sessionId} imageId={message.capture.imageId} label="Selected board region attached to this message" />}
        {attachments.map(attachment => <div className="tutor-message-attachment" key={attachment.id} title={attachment.filename}>
          {attachment.thumbnail_base64 && <img src={mediaDataUrl(attachment.thumbnail_base64, 'image/jpeg')} alt="" />}
          <span>{attachment.filename}</span>
        </div>)}
      </div>
      {message.text && <div className="tutor-message-user"><div className="tutor-message-copy">{message.text}</div>{message.isVoice && <span className="tutor-message-voice-mark" aria-label="Spoken message"><Icon name="composer/voice" size={14} /></span>}</div>}
      <div className="tutor-message-actions">
        {message.text && <button type="button" aria-label={copied ? 'Copied message' : 'Copy message'} onClick={() => {
          if (onCopy) onCopy(message.text); else void navigator.clipboard?.writeText(message.text);
          setCopied(true); window.setTimeout(() => setCopied(false), 1200);
        }}>{copied ? 'Copied' : 'Copy'}</button>}
        {canEdit && <button type="button" aria-label="Edit and resend message" onClick={() => onEdit(message.id)}><Icon name="ui/retry" size={16} /></button>}
      </div>
    </div>;
  }

  return <div className="tutor-message-row tutor-message-row--assistant">
    {(trail.items.length > 0 || trail.duration !== undefined) && <ActivityTrail trail={trail} sessionId={sessionId} />}
    {message.text && <div className="tutor-message-assistant"><RichText text={message.text} /></div>}
    {message.isVoice && message.text && <span className="tutor-message-voice-mark tutor-message-voice-mark--assistant"><Icon name="composer/voice" size={14} /><span>Spoken</span></span>}
  </div>;
}
