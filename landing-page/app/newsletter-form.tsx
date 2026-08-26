'use client';

import { FormEvent, useState } from 'react';

export function NewsletterForm() {
  const [submitted, setSubmitted] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
  }

  return (
    <form className="newsletter-form" id="newsletter" onSubmit={submit}>
      <label className="sr-only" htmlFor="newsletter-email">Email address</label>
      {submitted ? <span className="newsletter-success" role="status">You’re on the list.</span> : <input id="newsletter-email" name="email" type="email" placeholder="you@example.com" autoComplete="email" required />}
      <button type="submit">{submitted ? 'Done' : 'Subscribe'}</button>
    </form>
  );
}
