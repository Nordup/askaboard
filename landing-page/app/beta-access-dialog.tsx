'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';

type SubmitState = 'idle' | 'submitting' | 'success' | 'error';

export function BetaAccessDialog() {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [state, setState] = useState<SubmitState>('idle');
  const [message, setMessage] = useState('');

  useEffect(() => {
    function syncDialogWithHash() {
      setIsOpen(window.location.hash === '#beta-access');
    }

    function openFromLink(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest('a[href="#beta-access"]')) return;

      event.preventDefault();
      if (window.location.hash !== '#beta-access') {
        window.history.pushState(null, '', '#beta-access');
      }
      setIsOpen(true);
    }

    syncDialogWithHash();
    window.addEventListener('hashchange', syncDialogWithHash);
    document.addEventListener('click', openFromLink);
    return () => {
      window.removeEventListener('hashchange', syncDialogWithHash);
      document.removeEventListener('click', openFromLink);
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.querySelector<HTMLElement>('button, input, textarea')?.focus();

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') close();
    }

    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen]);

  function close() {
    setIsOpen(false);
    setState('idle');
    setMessage('');
    if (window.location.hash === '#beta-access') {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState('submitting');
    setMessage('');

    const form = event.currentTarget;
    const data = new FormData(form);

    try {
      const response = await fetch('/api/interest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'beta',
          email: data.get('email'),
          name: data.get('name'),
          ipadSetup: data.get('ipadSetup'),
          reason: data.get('reason'),
          website: data.get('website'),
        }),
      });
      const result = await response.json() as { error?: string };

      if (!response.ok) {
        throw new Error(result.error ?? 'We could not save that request. Please try again.');
      }

      form.reset();
      setState('success');
    } catch (error) {
      setState('error');
      setMessage(error instanceof Error ? error.message : 'We could not save that request. Please try again.');
    }
  }

  return (
    <div
      className={`beta-dialog-layer ${isOpen ? 'is-open' : ''}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="beta-dialog" id="beta-access" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="beta-dialog-title">
        <button className="dialog-close" type="button" onClick={close} aria-label="Close beta access form">×</button>
        {state === 'success' ? (
          <div className="dialog-success" role="status">
            <span aria-hidden="true">✓</span>
            <h2 id="beta-dialog-title">Request received</h2>
            <p>We&apos;ll review your request personally and get in touch if the beta is a good fit.</p>
            <button className="button button-primary" type="button" onClick={close}>Done</button>
          </div>
        ) : (
          <>
            <p className="dialog-eyebrow">IPAD BETA</p>
            <h2 id="beta-dialog-title">Request beta access</h2>
            <p className="dialog-intro">Tell us a little about how you would use Whiteboard AI. We&apos;ll review requests personally.</p>
            <form className="beta-request-form" onSubmit={submit}>
            <div className="beta-form-row">
              <label>
                <span>Name</span>
                <input name="name" autoComplete="name" maxLength={100} required />
              </label>
              <label>
                <span>Email</span>
                <input name="email" type="email" autoComplete="email" maxLength={254} required />
              </label>
            </div>
            <label>
              <span>Your iPad setup</span>
              <input name="ipadSetup" placeholder="For example: iPad Air with Apple Pencil" maxLength={120} required />
            </label>
            <label>
              <span>What would you like to use it for?</span>
              <textarea name="reason" rows={4} maxLength={700} required />
            </label>
            <label className="form-honeypot" aria-hidden="true">
              Website
              <input name="website" tabIndex={-1} autoComplete="off" />
            </label>
            {state === 'error' && <p className="form-error" role="alert">{message}</p>}
            <button className="button button-primary beta-submit" type="submit" disabled={state === 'submitting'}>
              {state === 'submitting' ? 'Sending…' : 'Send request'}
            </button>
            <small>This request does not subscribe you to product updates.</small>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
