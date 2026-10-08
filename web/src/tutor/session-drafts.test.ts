import { describe, expect, it } from 'vitest';
import { SessionDrafts } from './session-drafts';

describe('session-bound composer drafts', () => {
  it('keeps uploads isolated and consumes only the text and files accepted by a send', () => {
    const drafts = new SessionDrafts();
    const uploadA = { id: 'upload-a', filename: 'worksheet.pdf' };
    const uploadB = { id: 'upload-b', filename: 'diagram.png' };
    drafts.set('session-a', { text: 'Check this', attachments: [uploadA] });
    drafts.set('session-b', { text: 'Keep my draft', attachments: [uploadB] });

    drafts.set('session-a', { text: 'New draft while the answer streams', attachments: [uploadA, { id: 'upload-a2', filename: 'notes.txt' }] });
    const accepted = drafts.consumeAccepted('session-a', 'Check this', new Set([uploadA.id]));

    expect(accepted).toEqual({ text: 'New draft while the answer streams', attachments: [{ id: 'upload-a2', filename: 'notes.txt' }] });
    expect(drafts.get('session-b')).toEqual({ text: 'Keep my draft', attachments: [uploadB] });
  });

  it('restores a missing session to a fresh draft without reusing another session upload id', () => {
    const drafts = new SessionDrafts();
    drafts.set('session-a', { text: 'A', attachments: [{ id: 'upload-a', filename: 'a.png' }] });
    expect(drafts.get('session-b')).toEqual({ text: '', attachments: [] });
  });

  it('consumes only accepted typed words during an awake voice call', () => {
    const drafts = new SessionDrafts();
    const upload = { id: 'upload-a', filename: 'worksheet.pdf' };
    drafts.set('session-a', { text: 'Ask the tutor', attachments: [upload] });
    expect(drafts.consumeAcceptedText('session-a', 'Ask the tutor')).toEqual({ text: '', attachments: [upload] });
  });
});
