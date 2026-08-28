# Landing page — wireframe & build plan

> **Historical design artifact.** This records an earlier landing-page design
> and its exact visual requirements. Its audience, pricing, and product claims
> are not current direction. Use [`docs/product-vision.md`](../docs/product-vision.md)
> for positioning and [`landing-page/app/page.tsx`](../landing-page/app/page.tsx)
> for the current page structure and copy. Preserve this file only as a record
> of the earlier Paper boards.

**Delivered as Paper boards** in "AI Whiteboard Tutor — Design System, Components & Page",
page **"Website — A+C Hybrid"**, strictly on the Website Tokens board
(Surface `#FFFFFF` · Ink `#000000` · Rule `#EAEAEA` · Primary `#1557FF` · Selection `#55E12C`
· Tutor `#7B5CFF`; Inter 56/64 · 34/40 · 20/28 · 15/20; radius 12/20/9999; 1px `#EAEAEA`
rules; `0 18px 42px rgba(0,0,0,.14)` device shadow; 220ms ease-out):

| Board | Contents |
| --- | --- |
| `Landing — Full page` | The whole page as one continuous 1440-wide artboard: marketing nav → Hero (screenshot 1, 1:1 — headline with green `Select.` pill, CTAs, peeking character, iPad stage with the full app recreation) → Tutor-Workspace band + Workspace (screenshot 2, 1:1 — Write/Select/Ask/Understand rail, dot-grid board with vector figure + selection + voice-state strip, tutor panel) → Features → For students / For educators → Pricing (Pro highlighted) → FAQ → cobalt CTA → Footer |

App recreations inside device frames keep the untouched app tokens (violet `#6051DC`,
Source Sans 3, app shadows/radii); all website chrome uses the `--web-*` tokens.
Board ink is set in Caveat.

---

## Page structure

```
NAV (fixed, 56px, white)  ── two states, crossfaded by scroll:
  A) marketing  : Product · How it works · For students · For educators · Pricing · Resources ⌄
                  right: Log in · [Try the tutor]            (screenshot 1, verbatim)
  B) workspace  : Tutor Workspace · Product · Examples · Pricing · Download
                  right: Log in · [Get started free]         (screenshot 2, verbatim)

1 · HERO  (screenshot 1, reproduced 1:1)
    H1  "Learn on the same page." / "Write. [Select.] Ask."   ← green rounded highlight
    sub "Your tutor sees the exact step and teaches right on your board."
    [Try the tutor]  [Watch a lesson]
    hand-drawn character peeking over the iPad's top-left edge
    iPad (black bezel) → app recreation at the design's real geometry:
      tool rail 72 · board 863 · tutor panel 337 (the app's exact lanes, scaled)
      board: handwritten d/dx x² derivation, dashed violet selection around
             x²+2xh+h²−x², curved arrow → "Selection attached ×" pill
      panel: orb + halo · "Hi! I'm your AI Tutor" · the x²-cancellation exchange
             (student bubble 9:41 AM, tutor reply, handwritten "x² cancels out"
             with struck-through terms)

2 · HOW IT WORKS  (screenshot 2, reproduced 1:1, scroll-driven)
    400vh section, sticky 100vh stage:
    ┌────────────┬──────────────────────────────┬─────────────┐
    │ steps rail │ board (dot grid, rail on top)│ tutor panel │
    │ "Your      │  Vector v⃗ in 2D figure       │ orb, greet, │
    │  context   │  dashed selection + pill     │ 4 chips,    │
    │  stays on  │  status bar: Listening |     │ composer    │
    │  the board"│  Thinking | Drawing          │             │
    │ 1 WRITE    │                              │             │
    │ 2 SELECT ←────── curved arrow to rail     │             │
    │ 3 ASK      │                              │             │
    │ 4 UNDERSTAND│                             │             │
    └────────────┴──────────────────────────────┴─────────────┘
    Scroll progress maps to 4 steps:
      0 WRITE      ink draws itself (title, underline, axes, vector, labels);
                   status: Listening · panel shows greeting
      1 SELECT     dashed selection + corner dots snap around v⃗ = [x y],
                   solid "Selection attached" pill pops, composer's marquee
                   icon turns violet (selection live)
      2 ASK        greeting swaps to thread; student bubble "Why does the
                   arrow start at 0?"; thinking dots; status: Thinking
      3 UNDERSTAND tutor reply streams in (design-doc copy: "It doesn't have
                   to. Starting at the origin is just standard position…"),
                   tutor draws the ghost vector + note on the board;
                   status: Drawing

3 · FEATURES      3 cards — reads your actual ink / teaches on the board /
                  context that stays (icons from the real icon set)
4 · AUDIENCES     For students · For educators (two panels)
5 · PRICING       Free · Pro · Classroom
6 · FAQ           5 <details> rows
7 · CTA           violet panel, "Learn on the same page." + buttons
8 · FOOTER        brand + link columns
```

## Fidelity rules

- App mock uses the design's real values: screen `#F8F8F8`, board `#FAFAFA`,
  panel `#FCFCFC`, brand `#6051DC`, tint `#E6E3F9`, soft `#F1F0FB`, bubble `#F2F2F6`,
  ink `#0C0E17`, icon `#55565A`; shadows 01/02/03 exactly as in `01-foundations.md §5`;
  rail stack (54pt slots, 27px swatches at 54 pitch, divider 46×1.5), chips 301×62 r14,
  composer 301×50 capsule, orb with oklab-style halo, panel controls, real icon paths
  from `design/icons.json`.
- Marketing chrome (nav, hero, sections) matches the screenshots' Notion-like style:
  Inter, near-black `#111`, blue CTA `#2E6BE6`, green highlight `#3ED23B`.
- Both screenshots' headers are reproduced verbatim; the nav crossfades between them
  so each screenshot's header appears in its own context.

## Implementation notes

- `index.html` / `styles.css` / `script.js`, vanilla.
- Fixed-design stages (hero iPad 1416×1072, workspace 1404×812) scaled with
  `transform: scale()` from JS so the mock is pixel-exact at any viewport.
- Scroll: section progress → `data-step` + cumulative `at1/at2/at3` classes;
  SVG draw-in via `pathLength`/dashoffset; reduced-motion honored.
- Nav swap + reveal animations via IntersectionObserver.
