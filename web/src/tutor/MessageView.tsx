import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import type { Message } from '../types';
import { Icon } from '../design/Icon';

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

export function MessageView({ message, onEdit }: { message: Message; onEdit?: (text: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (!onEdit || !draft.trim()) return;
    setSaving(true);
    try { await onEdit(draft.trim()); setEditing(false); } catch { /* Root surfaces turn errors and keeps the edit available. */ }
    finally { setSaving(false); }
  };
  if (message.role === 'user') return <div className="message-row">
    {editing ? <div><textarea className="message-edit" value={draft} onChange={event => setDraft(event.target.value)} aria-label="Edit your message" /><div className="message-tools" style={{ opacity: 1 }}><button className="icon-button" aria-label="Cancel edit" onClick={() => { setDraft(message.text); setEditing(false); }}><Icon name="composer/dismiss" /></button><button className="icon-button" aria-label="Save and resend" disabled={saving || !draft.trim()} onClick={submit}><Icon name="composer/send" /></button></div></div>
      : <><div className="message message--user"><div className="plain-copy">{message.text}</div></div>{onEdit && <div className="message-tools"><button className="icon-button" aria-label="Edit and resend message" onClick={() => setEditing(true)}><Icon name="ui/retry" /></button></div>}</>}
  </div>;
  return <div className="message"><RichText text={message.text} /></div>;
}
