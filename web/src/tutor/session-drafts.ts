import type { Attachment } from '../types';

export interface SessionDraft { text: string; attachments: Attachment[]; }

/** Transient desktop drafts are isolated by workspace session id. */
export class SessionDrafts {
  private readonly drafts = new Map<string, SessionDraft>();

  get(sessionId: string): SessionDraft {
    return this.drafts.get(sessionId) ?? { text: '', attachments: [] };
  }

  set(sessionId: string, draft: SessionDraft): void {
    this.drafts.set(sessionId, { text: draft.text, attachments: [...draft.attachments] });
  }

  appendAttachments(sessionId: string, attachments: Attachment[], limit: number): SessionDraft {
    const draft = this.get(sessionId);
    const next = { ...draft, attachments: [...draft.attachments, ...attachments].slice(0, limit) };
    this.set(sessionId, next);
    return next;
  }

  consumeAccepted(sessionId: string, submittedText: string, attachmentIds: Set<string>): SessionDraft {
    const draft = this.get(sessionId);
    const next = {
      text: draft.text === submittedText ? '' : draft.text,
      attachments: draft.attachments.filter(item => !attachmentIds.has(item.id)),
    };
    this.set(sessionId, next);
    return next;
  }

  /** An awake voice call consumes typed words only; unsent files remain on the draft. */
  consumeAcceptedText(sessionId: string, submittedText: string): SessionDraft {
    const draft = this.get(sessionId);
    const next = { ...draft, text: draft.text === submittedText ? '' : draft.text };
    this.set(sessionId, next);
    return next;
  }
}
