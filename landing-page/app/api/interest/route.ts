import { NextResponse } from 'next/server';

type InterestKind = 'beta' | 'updates';

type InterestRequest = {
  kind?: InterestKind;
  email?: string;
  name?: string;
  ipadSetup?: string;
  reason?: string;
  website?: string;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  })[character] ?? character);
}

async function sendBetaNotification(
  apiKey: string,
  recipient: string,
  application: { email: string; name: string; ipadSetup: string; reason: string },
) {
  const name = escapeHtml(application.name);
  const email = escapeHtml(application.email);
  const ipadSetup = escapeHtml(application.ipadSetup);
  const reason = escapeHtml(application.reason).replace(/\n/g, '<br>');

  const createResponse = await fetch('https://api.buttondown.com/v1/emails', {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      subject: 'New Whiteboard AI beta request',
      body: `<!doctype html>
<html>
<head>
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <style>
    :root { color-scheme: light dark; supported-color-schemes: light dark; }
    body, .email-shell { background: #f4f6fb !important; color: #101828 !important; }
    .request-card { background: #ffffff !important; border-color: #dfe3eb !important; }
    .request-label, .email-muted { color: #667085 !important; }
    .request-value { color: #101828 !important; }
    @media (prefers-color-scheme: dark) {
      body, .email-shell { background: #0f1115 !important; color: #f5f7fb !important; }
      .request-card { background: #171a21 !important; border-color: #2b313d !important; }
      .request-label, .email-muted { color: #98a2b3 !important; }
      .request-value { color: #f5f7fb !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f4f6fb;color:#101828;">
  <table class="email-shell" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:#f4f6fb;">
    <tr>
      <td style="padding:32px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;margin:0 auto;">
          <tr>
            <td style="padding:0 0 20px;text-align:left;">
              <div style="display:inline-block;padding:7px 10px;border-radius:8px;background:#1557ff;color:#ffffff;font:700 12px/1.2 Arial,sans-serif;letter-spacing:.08em;">WHITEBOARD AI</div>
              <h1 style="margin:18px 0 6px;font:700 28px/1.2 Arial,sans-serif;color:inherit;text-align:left;">New beta access request</h1>
              <p class="email-muted" style="margin:0;color:#667085;font:400 15px/1.5 Arial,sans-serif;text-align:left;">A learner has asked to join the iPad beta.</p>
            </td>
          </tr>
          <tr>
            <td class="request-card" style="padding:24px;background:#ffffff;border:1px solid #dfe3eb;border-radius:14px;text-align:left;">
              <p class="request-label" style="margin:0 0 5px;color:#667085;font:700 12px/1.4 Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase;">Applicant</p>
              <p class="request-value" style="margin:0 0 22px;color:#101828;font:600 17px/1.5 Arial,sans-serif;">${name}<br><a href="mailto:${email}" style="color:#1557ff;text-decoration:underline;">${email}</a></p>
              <p class="request-label" style="margin:0 0 5px;color:#667085;font:700 12px/1.4 Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase;">iPad setup</p>
              <p class="request-value" style="margin:0 0 22px;color:#101828;font:400 16px/1.55 Arial,sans-serif;">${ipadSetup}</p>
              <p class="request-label" style="margin:0 0 5px;color:#667085;font:700 12px/1.4 Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase;">What they want to use it for</p>
              <p class="request-value" style="margin:0;color:#101828;font:400 16px/1.55 Arial,sans-serif;">${reason}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 0 0;text-align:left;">
              <a href="https://buttondown.com/subscribers" style="display:inline-block;padding:12px 18px;border-radius:9px;background:#1557ff;color:#ffffff;font:700 14px/1.2 Arial,sans-serif;text-decoration:none;">Review in Buttondown</a>
              <p class="email-muted" style="margin:16px 0 0;color:#667085;font:400 12px/1.5 Arial,sans-serif;text-align:left;">Private admin notification from whiteboardai.nordup.dev</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
      template: 'naked',
      status: 'draft',
      archival_mode: 'disabled',
      commenting_mode: 'disabled',
    }),
  });

  if (!createResponse.ok) {
    throw new Error(`Buttondown notification draft failed (${createResponse.status}): ${await createResponse.text()}`);
  }

  const draft = await createResponse.json() as { id: string };

  try {
    const sendResponse = await fetch(`https://api.buttondown.com/v1/emails/${draft.id}/send-draft`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ recipients: [recipient] }),
    });

    if (!sendResponse.ok) {
      throw new Error(`Buttondown notification send failed (${sendResponse.status}): ${await sendResponse.text()}`);
    }
  } finally {
    const deleteResponse = await fetch(`https://api.buttondown.com/v1/emails/${draft.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Token ${apiKey}` },
    });

    if (!deleteResponse.ok && deleteResponse.status !== 404) {
      console.error(`Buttondown notification cleanup failed (${deleteResponse.status}): ${await deleteResponse.text()}`);
    }
  }
}

export async function POST(request: Request) {
  let input: InterestRequest;

  try {
    input = await request.json() as InterestRequest;
  } catch {
    return NextResponse.json({ error: 'Please check the form and try again.' }, { status: 400 });
  }

  // A filled hidden field is almost certainly an automated submission. Return
  // the same success shape so the endpoint does not teach bots how to bypass it.
  if (clean(input.website, 200)) {
    return NextResponse.json({ ok: true }, { status: 202 });
  }

  const kind = input.kind;
  const email = clean(input.email, 254).toLowerCase();
  const name = clean(input.name, 100);
  const ipadSetup = clean(input.ipadSetup, 120);
  const reason = clean(input.reason, 700);

  if ((kind !== 'beta' && kind !== 'updates') || !EMAIL_PATTERN.test(email)) {
    return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });
  }

  if (kind === 'beta' && (!name || !ipadSetup || !reason)) {
    return NextResponse.json({ error: 'Complete each field before sending your request.' }, { status: 400 });
  }

  const apiKey = process.env.BUTTONDOWN_API_KEY;
  const notificationEmail = process.env.BETA_NOTIFICATION_EMAIL;

  if (!apiKey) {
    console.error(`Buttondown is not configured for ${kind} submissions.`);
    return NextResponse.json(
      { error: 'Signups are temporarily unavailable. Please try again later.' },
      { status: 503 },
    );
  }

  const notes = kind === 'beta'
    ? [`Beta access request`, `Name: ${name}`, `iPad setup: ${ipadSetup}`, `Why: ${reason}`].join('\n')
    : 'Requested occasional Whiteboard AI progress updates from the landing page.';

  const authorization = { Authorization: `Token ${apiKey}` };

  try {
    if (kind === 'beta') {
      const subscriberUrl = `https://api.buttondown.com/v1/subscribers/${encodeURIComponent(email)}`;
      const existingResponse = await fetch(subscriberUrl, { headers: authorization });

      if (existingResponse.ok) {
        const existing = await existingResponse.json() as { notes?: string };
        const combinedNotes = [clean(existing.notes, 5000), notes].filter(Boolean).join('\n\n---\n\n');
        const updateResponse = await fetch(subscriberUrl, {
          method: 'PATCH',
          headers: { ...authorization, 'Content-Type': 'application/json' },
          body: JSON.stringify({ notes: combinedNotes }),
        });

        if (!updateResponse.ok) {
          const providerMessage = await updateResponse.text();
          console.error(`Buttondown beta request update failed (${updateResponse.status}): ${providerMessage}`);
          return NextResponse.json(
            { error: 'We could not save that request. Please try again.' },
            { status: 502 },
          );
        }

        if (notificationEmail) {
          try {
            await sendBetaNotification(apiKey, notificationEmail, { email, name, ipadSetup, reason });
          } catch (error) {
            console.error('Beta request was saved, but its admin notification failed:', error);
          }
        } else {
          console.error('Beta request was saved, but BETA_NOTIFICATION_EMAIL is not configured.');
        }

        return NextResponse.json({ ok: true }, { status: 202 });
      }

      if (existingResponse.status !== 404) {
        const providerMessage = await existingResponse.text();
        console.error(`Buttondown beta request lookup failed (${existingResponse.status}): ${providerMessage}`);
        return NextResponse.json(
          { error: 'We could not save that request. Please try again.' },
          { status: 502 },
        );
      }

      // Free Buttondown accounts cannot create tags. Store a new beta applicant
      // as unsubscribed so the application remains reviewable in Buttondown
      // without enrolling them in product email. Existing subscribers are
      // handled above, where only their notes are updated.
      const createResponse = await fetch('https://api.buttondown.com/v1/subscribers', {
        method: 'POST',
        headers: { ...authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email_address: email, notes, type: 'unsubscribed' }),
      });

      if (!createResponse.ok) {
        const providerMessage = await createResponse.text();
        console.error(`Buttondown beta request creation failed (${createResponse.status}): ${providerMessage}`);
        return NextResponse.json(
          { error: 'We could not save that request. Please try again.' },
          { status: 502 },
        );
      }

      if (notificationEmail) {
        try {
          await sendBetaNotification(apiKey, notificationEmail, { email, name, ipadSetup, reason });
        } catch (error) {
          console.error('Beta request was saved, but its admin notification failed:', error);
        }
      } else {
        console.error('Beta request was saved, but BETA_NOTIFICATION_EMAIL is not configured.');
      }

      return NextResponse.json({ ok: true }, { status: 202 });
    }

    const response = await fetch('https://api.buttondown.com/v1/subscribers', {
      method: 'POST',
      headers: {
        ...authorization,
        'Content-Type': 'application/json',
        // Merge this request into an existing record if the address already
        // exists. Keeping the subscriber unactivated requires confirmation
        // again after a prior unsubscribe instead of silently restoring email.
        'X-Buttondown-Collision-Behavior': 'add',
      },
      body: JSON.stringify({
        email_address: email,
        notes,
        type: 'unactivated',
      }),
    });

    if (!response.ok) {
      const providerMessage = await response.text();
      console.error(`Buttondown ${kind} signup failed (${response.status}): ${providerMessage}`);
      return NextResponse.json(
        { error: 'We could not save that request. Please try again.' },
        { status: 502 },
      );
    }
  } catch (error) {
    console.error(`Buttondown ${kind} signup failed:`, error);
    return NextResponse.json(
      { error: 'We could not save that request. Please try again.' },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true }, { status: 202 });
}
