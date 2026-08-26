# Learn AI landing page

This folder is an independent web application inside the Math Tutor repository. It shares the product documentation and exported design assets, but has its own dependencies, component system, build, and deployment boundary. It can be moved to a standalone repository later without restructuring the app.

## Local development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

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

- Replace the TestFlight anchors with the final invite URL.
- Connect the newsletter form to the selected mailing provider.
- Choose the production name and domain, set `NEXT_PUBLIC_SITE_URL` in Vercel, and update the product metadata.
