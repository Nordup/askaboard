# Documentation map

Use this map to decide which documents carry current authority. A file being
newer, longer, or more detailed does not automatically make it a product
positioning source.

## Current sources

- [`learning-space/README.md`](learning-space/README.md) — **the main
  product** (since 2026-10-24, on `main`): a desktop canvas with no AI
  inside, which any agent uses over MCP. Start there: status, reading order
  and glossary.
- [`product-vision.md`](product-vision.md) — product language and learning
  principles, written for the paused built-in tutor. Its shared-board idea
  continues in Learning Space, but some of it is replaced there (for
  example "the learner does the thinking" as a fixed rule; see decision P7
  in `learning-space/decisions.md`).
- [`TODO.md`](TODO.md) — known debt of the paused tutor stack.

## Paused stack (reference)

- [`../README.md`](../README.md) — the iPad client (paused): setup,
  architecture, capabilities, limitations.
- [`../server/README.md`](../server/README.md) — the tutor backend (paused).

## Exact design records

[`design-system/`](design-system/) transcribes shipped Paper boards and their
visual contracts. These files may contain interface examples or wording from
the time a board was created. Treat their geometry and component behavior as
design evidence, not their sample copy as current positioning. Change the
source design and implementation before updating an exact transcription.

## Dated engineering records

[`superpowers/specs/`](superpowers/specs/),
[`superpowers/plans/`](superpowers/plans/),
[`superpowers/research/`](superpowers/research/), and [`research/`](research/)
record technical decisions, implementation work, and research at particular
points in the project. Preserve them for provenance and for the reasoning behind
the code. Their dates and status lines define their context; they do not
supersede `product-vision.md` as product direction.

Model names, provider choices, and planned intermediary capabilities belong in
these technical records when relevant. They should not be promoted into the
product vision merely because they appear in a spec.

## Superseded origins

- [`learn-ai-the-idea.md`](learn-ai-the-idea.md) preserves the original
  course-and-planning-centered concept.
- [`conversation.md`](conversation.md) preserves the research conversation that
  evaluated that original concept.
- [`../landing/WIREFRAME.md`](../landing/WIREFRAME.md) preserves an earlier
  Paper landing-page design and its product assumptions.

These files are historical sources. Do not use their “learning engine,” course
generator, audience, pricing, or roadmap language as current product guidance.
