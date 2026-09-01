'use client';

import { FormEvent, useState } from 'react';

type SubmitState = 'idle' | 'submitting' | 'success' | 'error';

export function NewsletterForm() {
  const [state, setState] = useState<SubmitState>('idle');
  const [message, setMessage] = useState('');

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
          kind: 'updates',
          email: data.get('email'),
          website: data.get('website'),
        }),
      });
      const result = await response.json() as { error?: string };

      if (!response.ok) {
        throw new Error(result.error ?? 'We could not save your email. Please try again.');
      }

      form.reset();
      setState('success');
    } catch (error) {
      setState('error');
      setMessage(error instanceof Error ? error.message : 'We could not save your email. Please try again.');
    }
  }

  return (
    <form className="newsletter-form" id="newsletter" onSubmit={submit}>
      <label className="sr-only" htmlFor="newsletter-email">Email address</label>
      {state === 'success' ? (
        <span className="newsletter-success" role="status">Check your inbox to confirm.</span>
      ) : (
        <input id="newsletter-email" name="email" type="email" placeholder="you@example.com" autoComplete="email" maxLength={254} required />
      )}
      <label className="form-honeypot" aria-hidden="true">
        Website
        <input name="website" tabIndex={-1} autoComplete="off" />
      </label>
      <button type="submit" disabled={state === 'submitting' || state === 'success'}>
        {state === 'submitting' ? 'Sending…' : state === 'success' ? 'Sent' : 'Notify me'}
      </button>
      {state === 'error' && <span className="newsletter-feedback" role="alert">{message}</span>}
    </form>
  );
}
