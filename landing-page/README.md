# Learn AI landing page

This folder is an independent web application inside the Math Tutor repository. It shares the product documentation and exported design assets, but has its own dependencies, component system, build, and deployment boundary. It can be moved to a standalone repository later without restructuring the app.

Product language follows [`docs/product-vision.md`](../docs/product-vision.md).
The older [`landing/WIREFRAME.md`](../landing/WIREFRAME.md) is a preserved Paper
design artifact, not the source of truth for current positioning or copy.

## Local development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Beta requests and product updates

Both landing-page forms use Buttondown through the server-only
`app/api/interest` route. Copy `.env.example` to `.env.local` and set:

```bash
BUTTONDOWN_API_KEY=your-private-api-key
BETA_NOTIFICATION_EMAIL=you@example.com
```

Set the same variable in the production deployment environment. Never prefix
the API key with `NEXT_PUBLIC_`. Product-update signups use Buttondown's double
opt-in flow. Beta applications are saved in subscriber notes for personal
review but do not subscribe the applicant to product email. A new applicant is
stored as unsubscribed; when an existing update subscriber applies, only their
notes are updated and their subscription status is preserved. Each beta
application also sends a private draft notification to
`BETA_NOTIFICATION_EMAIL`; the temporary draft is deleted after delivery.
The Buttondown publication and author are both named **Whiteboard AI**, using
the `whiteboardai` sender slug. Regular newsletters use Buttondown's
left-aligned Classic template; private beta alerts override it with a standalone
dark-mode-aware HTML layout so they contain no newsletter subscription chrome.

## Validation

```bash
npm run lint
npm run build
```

The default build is standard Next.js and is ready for Vercel’s automatic framework detection. The alternate `npm run build:sites` build preserves the workspace’s Sites-compatible Cloudflare output.

## Design source

The implementation follows the Paper page **Learn AI — Product Landing** at 1440px. Desktop section heights total exactly 4754px, including the 64px navigation and 280px footer. Responsive breakpoints preserve the hierarchy and switch to a single-column, full-width mobile composition.

The reusable tokens and component styles live in `app/globals.css`; structural components are in `app/components.tsx`.

## Before launch

- Add `BUTTONDOWN_API_KEY` to the production environment, then smoke-test both
  forms on the deployed site.
- Create a new social-preview image from the current product story before
  enabling large-image social metadata. The old preview was removed because it
  advertised the superseded adaptive-plan positioning.
- Choose the production name and domain, set `NEXT_PUBLIC_SITE_URL` in Vercel, and update the product metadata.
