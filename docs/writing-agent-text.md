# Askaboard — how to write the text agents read

> **For:** any agent (or person) who improves what external agents read when
> they work in Askaboard: the brief, the server instructions, the tool
> descriptions, the plugin skill and the `AGENTS.md`
> template. Written 2026-10-24, at the end of the session that produced the
> first real brief; updated 2026-10-25 (brief v3, decision T11) and 2026-10-26 (brief v18 and the agent texts in Anthropic's style, I18–I22) and 2026-10-27 (how to change a text without losing its intent or voice; the T16 lessons, I25). The founder's own words from that session are in
> [the appendix](#appendix--the-founders-words); read them, they matter more
> than the summary.

## Why this file exists

The agent's behaviour on the board comes mostly from what it reads. The
baseline of 2026-10-24 (private notes: `baseline.md`) showed agents that
built a new text card for every answer. They did so because the old guide
told them to: its workflow began with "Make room: create_frame", and its only
example was a text card. The model followed the text. So improving the text
is the main lever on the experience, and the founder cares about every word.

The founder rejected the first draft of the new text. It was short, it gave
instructions without reasons, and it had one example that would narrow the
agent's imagination. The second draft, written after the founder explained
what was wrong, was what they "really wanted". This file records the
difference, so the next writer starts from the second draft's approach.

## Where each text lives

| Text | File | Who reads it, when | Limit |
| --- | --- | --- | --- |
| **The brief** (the space and your part; what the person wants; their work; explaining by drawing; what can go on the board; talking; checking facts; the learning folder) | `apps/desktop/resources/brief.md` (the one source) | Agents in a learning folder: always, through the managed block in `AGENTS.md`. Other agents: `get_brief` (no parameters). | Codex loads `AGENTS.md` up to 32 KiB (`project_doc_max_bytes = 32768`, Codex CLI 0.149), and the folder part shares that space. |
| The folder's own conventions | `AGENTS.md` outside the managed block (template: `apps/desktop/resources/learning-folder/AGENTS.md`) | Agents in the folder | Same file as above |
| Server instructions (short orientation) | `apps/desktop/resources/instructions.md` | Every agent at connect | Claude Code cuts at 4,096 characters (2.1.296+; 2,048 before). Codex asks that the first 512 characters stand alone. |
| **The board reference** (decision T11): the board model, the HTML subset and styles, math, SVG, images, colour tokens, placement, ink, the view | `apps/desktop/resources/guide.md`; each `## ` section is a topic (`<!-- topic: … -->`) with a one-line `<!-- summary: … -->` that `get_guide`'s description lists | Every agent: `get_guide` with one topic, when a write needs it; without a topic, all of it (about 42,000 characters) | Topics from about 400 characters to about 15,000 (`scene`) |
| Tool and parameter descriptions | `apps/desktop/src/main/mcp.ts` | Every agent, on every request | 4,096 characters per tool description in Claude Code when loaded up front (16,384 when deferred). Parameter descriptions are not cut. Our Codex plugin gets these and the server instructions whole. Codex cuts them at 1,000 bytes only for an Agent Plugin, so the plugin must stay a Codex plugin, with no `plugin.json` at the plugin root (I30). |
| Plugin skill | [`learning-space-plugins/plugins/askaboard/skills/askaboard/SKILL.md`](../../learning-space-plugins/plugins/askaboard/skills/askaboard/SKILL.md) | Agents with the plugin, when it applies | Under 500 lines recommended |
| Tool names in other places | The same names appear in `apps/desktop/README.md` (tool table), `architecture.md` (MCP server), the plugin skill and README, and the lab's old-call mappers (`apps/desktop/scripts/perf/replay.mjs`, `apps/desktop/scripts/trace-report.mjs`, which keep old names on purpose). A rename changes all of them in one commit. | People and agents who read the docs | — |
| Per-folder overrides | `.askaboard/guide.md` (`get_guide` topic `folder`, or the whole reference with `mode: replace`), `.askaboard/instructions.md` (added to the server instructions) | As above, appended or replacing | — |

The managed block: `<!-- askaboard brief: start … sha=… -->` …
`<!-- askaboard brief: end -->`. The app rewrites the block when a
folder opens and the brief is newer, unless the learner edited the block
(hash mismatch). So a change to `brief.md` reaches every set-up folder on
its next open. Sources for the limits: the Claude Code MCP docs
(code.claude.com/docs/en/mcp), the Codex MCP docs
(learn.chatgpt.com/docs/extend/mcp), the local Codex binary; checked
2026-10-24. Check them again before you depend on them.

## The principles

These come from the founder (appendix) and from what worked. Decisions I1,
I2 and P7 in [`decisions.md`](decisions.md) record them.

1. **Write to an intelligent agent, as to a capable person.** It has intent,
   it reasons about words, and it understands nuance. Models get more capable
   every few months, so wording matters more over time, not less. Do not
   treat the model as something to control.
2. **Give context and reasoning, not conclusions.** A conclusion you reached
   after hours of discussion means nothing to an agent that did not hear the
   discussion. Say why: why the space exists, why the board holds drawings
   and the conversation holds words, why waiting hurts, why an explanation
   grows on one board. With the reason, the agent can handle cases you did
   not foresee.
3. **Be rich and wide.** The brief can be long, like a chapter of a book. It
   should look at each thing from several angles, describe situations, and
   offer ways to think. One idea from the founder is richer than a page of
   rules. Every paragraph needs an intent, though: no filler.
4. **No limits, no policing.** No word budgets, no "allowed / not allowed",
   no warnings in tool results that judge style. They make the space rigid,
   and they treat the cause wrongly: bad output came from a badly explained
   space.
5. **No example tool calls in the brief.** A single concrete example (a half
   sphere drawn with the old `draw_ink` tool) becomes the template the agent copies, and
   it limits imagination. Situations described in prose are fine when they
   show a way of thinking ("when someone draws two circles and asks 'is this
   how fusion works?'…").
6. **The role follows the person's intent.** Askaboard is a space to
   learn with a smart model. A tutor who holds back answers is one role; an
   explainer, a source of material, a sparring partner, a judge of a
   drawing are others. The brief teaches the agent to read which one is
   wanted, not to be one of them always.
7. **Tool descriptions are the opposite of the brief: precise facts.** What
   the tool does, when it fits and when it does not, what each parameter
   means, what comes back, the caveats. Usually 3–4 sentences or more. No
   behaviour ("be sparing", "the learner does the thinking"); behaviour
   belongs in the brief. This follows Anthropic's guidance (below). The
   details of each write (the HTML subset, styles, ink, placement) are in the
   board reference, `get_guide`, by topic (decision T11); a description names
   the topic. MCP has no `input_examples` field: put a
   short example value inside the description where the format is not
   obvious (as in write_scene's `code` parameter).
8. **One story everywhere (I2).** The brief, the instructions,
   the descriptions, the skill and the template must not contradict each
   other. Keep the brief in one file and point to it; do not copy it.

### Anthropic's guidance on tool descriptions (summary)

Full local copies (git-ignored, on this Mac): `reference/anthropic/`. Its
`README.md` lists the guidance pages (writing tools, defining tools, the
connector review rules, building agents, context engineering, prompting
best practices) and the examples (the claude.ai system prompts, the
anthropics/skills repo, Claude Code's own tool descriptions). Notes on tool
design (naming, one tool with actions or several, results, errors) are in
the private notes: `../askaboard-notes/history/anthropic-tool-guidance.md`.

From "Writing effective tools for agents" (anthropic.com/engineering/
writing-tools-for-agents, 2025-09-11), "Introducing advanced tool use"
(anthropic.com/engineering/advanced-tool-use, 2025-11-24), the Claude docs
"Define tools" (platform.claude.com/docs/en/agents-and-tools/tool-use/
define-tools) and the connector review checklist
(claude.com/docs/connectors/building/review-criteria):

- Detailed descriptions are the most important factor in tool performance;
  at least 3–4 sentences, more for complex tools.
- Say what the tool does, when to use it and when not, what each parameter
  means, what it returns, and its caveats. Describe it as you would to a new
  team member.
- Unambiguous parameter names; a description per parameter, with an example
  value where it helps.
- Each tool has one clear purpose; avoid near-identical tools.
- Return high-signal information only; use filters, ranges and sensible
  defaults to keep results small.
- Errors say what went wrong and how to fix it.
- Input examples only where the schema does not make use obvious.
- "Describe what the tool does, and don't tell Claude how to behave"
  (checklist). Response style belongs in the system prompt.
- Small changes to descriptions can change results a lot: measure.

## Change an agent text without losing its intent or its voice

Use this procedure for every change to the brief, the server instructions, a
tool description, the guide, the plugin skill or the folder template. It is
also for small changes, such as a renamed tool. The scene tool rename of
2026-10-26 (T16) was a small change in facts. It became a rewrite in a new
voice, and the founder brought the old text back (I25).

### 1. Find the intent and the approved text

- **Read the decisions that touch the text.** These are the I-decisions in
  [`decisions.md`](decisions.md), and T16, T17 and I25 for the scene tools.
  Each one says what the text must do and why.
- **Find the approved version.** Run `git log --oneline -- apps/desktop/resources/brief.md apps/desktop/src/main/mcp.ts`.
  The commit messages name the decision and say "approved". Compare the live
  text with the text at that commit.
- **Find where each intent lives.** One intent often lives in more than one
  text. Change one of them and read the others:

| Intent | Where it lives |
| --- | --- |
| Every medium is an equal choice (I31, replaces I20) | The brief, "What you can put on the board" and the calibration list; the guide, the summary and first lines of topics `scene-world` and `html`. Not in a tool description. |
| The picture carries the meaning (I31) | The brief, "Let the picture do the explaining" and the calibration list. |
| A model can be any shape, and it moves (I33) | The brief, "Worlds made with code"; the guide, topic `scene-world`, "Build any model". |
| Check a scene before the person sees it (I22, I25) | The brief, "Take the time it needs, and check your work"; the write_scene pointer to preview_scene; the preview_scene opening. |
| Explain fully, then check (I21) | The brief only. |
| Draw step by step, in front of the person | The brief ("Explain by drawing, one step at a time"); the instructions ("in front of the learner"); write_scene's opening. |
| What a tool does, returns and its errors | The tool description in `mcp.ts`. The details of a write are in the guide topic that it names. |

### 2. Write the change

- **Start from the approved text.** Change only the words that the new fact
  needs. A new or renamed tool is a reason to change a name or a sentence. It
  is not a reason to rewrite the paragraph.
- **Keep the form of each kind of text:**
  - A tool description opens with one sentence on what the tool does. Then
    comes "Use it for …" or "Use it to …", with a pointer to the better tool
    where one fits. Then the facts as a list, then "Returns", then "Errors"
    (I19).
  - The brief puts the behaviour first, then the reason, in plain sentences
    (v18). It holds intent, not tool mechanics. "Write it as a draft, and
    look at it with preview_scene: at the end, at the moments…" reads like a
    method. It was taken out again (I25).
- **Make the joins read as one text.** After an edit, read each changed
  paragraph from start to end. The founder's words on the first I25 draft:
  "it looks like the text was cut and placed between the text". Rewrite the
  sentences around the new words until they read naturally.
- **Describe only what exists.** "Nothing checks the layout" and "no warning
  reports them" spoke to an agent that knew the old warnings. A new agent does
  not need them.
- **Leave out how the app works.** If the agent would not do anything
  differently after it reads a sentence, the sentence does not go in. Most such
  sentences answer a question that we had while we built a feature. Keep the
  fact, and drop the mechanism (founder, 2026-10-31).
- **Keep each fact in one place.** The guide holds the details, and a
  description names the guide topic.
- **Write the draft in `../askaboard-notes/history/drafts/<name>-<date>/`** (private notes). Do not edit the live files
  first.

### 3. Check the draft before you show it

- **Length.** A tool description loaded up front is cut at 4,096 characters
  in Claude Code. Measure the description with the lab switches on and off.
  play_scene is at about 3,930 characters, so it has very little room.
- **Lab switches.** Text about worlds goes in `codeItems(…)`, and text
  about HTML in `htmlMaterial(…)` (`apps/desktop/src/main/lab-switch.ts`). In the
  markdown files, the markers are `<!-- code-items -->` and `<!-- html -->`.
  Read the text in each mode.
- **Contradictions.** Read the whole brief, the instructions, the three tool
  descriptions, the guide topic and the skill. Look for a sentence that a
  literal reader can take the other way (I18). Search for old tool names.
- **Facts.** Every result field, action and error text must match the code
  in `mcp.ts`. An example of a fact error: "a draft that only you can see"
  (write_scene returns no picture).

### 4. Show the founder

- **Show the text first, without your analysis.** Give the old, current and
  draft text side by side. Highlight only the changed words.
  - Use `git diff --word-diff=porcelain '--word-diff-regex=[^[:space:]]+'`
    for the markdown files.
  - For a tool description, first get the plain text from `mcp.ts` with the
    lab switch functions replaced (`codeItems = s => s`). Then diff those
    texts.
  - The I25 review used an HTML page with grey lines for unchanged text and
    red and green words: `../askaboard-notes/history/drafts/scene-tools-from-old-2026-10-27/compare.html`.
- Do not guess why the founder dislikes a text. Ask, or wait for their notes.

### 5. Build and verify

- The build goes to an implementer with the draft files as the exact
  source. The acceptance checks:
  - `npm run build` passes.
  - A script compares the live description strings with the draft, with the
    switches on and off.
  - The dev app's `tools/list` and `get_guide` return the draft text.
- Record the decision in `decisions.md` in the same commit.

### 6. Measure

- One run per model is enough unless the founder asks for more (2026-10-27).
  Use the big models: Claude `opus` and Codex `gpt-6.1-sol`, both at effort
  medium.
- Commands (from `apps/desktop/`):
  `node scripts/perf/run.mjs --client claude --model opus --effort medium --task <task> --label <change>`
  and the same with `--client codex --model gpt-6.1-sol`. Compare with
  `node scripts/perf/report.mjs --task <task> --runs`.
- **Tasks:**
  - `orbit`: small.
  - `em-wave`: pulls toward a 3D world.
  - `stddev` (council, `scripts/lab/council.mjs`): pulls toward formulas and text.
- **What to read in each run folder** (`apps/desktop/.lab/perf/runs/…`):
  - `calls.json`: the call order, the get_guide topics, and the errors.
  - The code of each write_scene call: `world(` or `html(`, or ink and shapes only.
  - A preview before each play.
  - The share of repeated characters.
  - `reply.md`, and the images in `trace/`.
- Time is noisy at n = 1. Read behaviour, not seconds.

### Diagnose a behaviour problem

1. **Look at what the agent read and did.** This means the run folder above,
   or the founder's traces in `~/.askaboard/traces/` (`node apps/desktop/scripts/trace-report.mjs`).
2. **Find the text that the agent read at the moment of the choice.** The
   model follows the text. In I20, both models chose a 3D program item from
   the get_guide topic list, which described program() by its power alone.
3. **Find out whether the text changed.** Run
   `git log -p -S "<phrase>" -- apps/desktop/resources apps/desktop/src/main/mcp.ts`, and
   compare with the approved commit.
4. **Check what the client loads.** Codex reads the brief from `AGENTS.md`
   only in a learning folder; elsewhere it must call `get_brief`. Without the
   brief, the tool descriptions and the guide are all it has.
5. **Fix the text that explains the space.** Do not add a warning or a rule
   (principle 4). Then measure again.

### Where to look for how to write well

- **This file:** the principles, the lessons below and the founder's words in the appendix.
- **`../askaboard-notes/history/anthropic-tool-guidance.md` (private notes):** notes on tool design, by topic.
- **`reference/anthropic/` (local only; the index is its `README.md`).** The most useful parts:
  - `guidance/define-tools.md`: detailed descriptions; when to use the tool and when not; the good and poor `get_stock_price` example.
  - `guidance/writing-tools-for-agents.md`: "describe your tool to a new hire".
  - `guidance/connector-review-criteria.md`: "Describe what the tool does, and don't tell Claude how to behave".
  - `examples/claude-code-tool-descriptions.md`: Claude Code's own tools. Each has one opening sentence, a "Usage" list and pointers to the better tool.
  - `guidance/prompting-best-practices.md` and `examples/anthropics-skills/skills/skill-creator/SKILL.md`: explain the reason instead of MUST; ask for what to do, not what to avoid.
- **The approved drafts, as models of the voice** (private notes, in `../askaboard-notes/history/drafts/`):
  - `tools-v2-draft.md` (I19)
  - `purposes-draft.md` (I20)
  - `explain-fully-draft.md` (I21)
  - `preview-draft.md` (I22)
  - `scene-tools-from-old-2026-10-27/` (I25)
  - `brief-v18.md`

## How the 2026-10-24 brief was written

Follow the same steps to improve it.

1. **Read the founder's ideas, in their words.** In this order:
   `idea.md`, `tutor-vision.md` and `live-drawing-idea.md` (private notes,
   `../askaboard-notes/history/`),
   `docs/product-vision.md` (in git history),
   `docs/learn-ai-the-idea.md` (the origin, in git history), and the
   old tutor prompt in `server/app/tutor/prompt.py` (in git history) (`SYSTEM_PROMPT`, written
   by the founder in the first person: intent, kinds of objectives, the
   board). Also this file's appendix.
2. **Read what the agent reads now:** `apps/desktop/resources/brief.md`,
   `instructions.md`, the tool descriptions in `mcp.ts`, the
   skill, the `AGENTS.md` template.
3. **Look at real behaviour:** `baseline.md` (private notes) and later bench
   runs; the founder's own traces in `~/.askaboard/traces/` (read with
   `node apps/desktop/scripts/trace-report.mjs`); research sections 9–13 in
   `research.md` (private notes, `../askaboard-notes/history/`).
4. **Check current facts with Haiku agents:** Anthropic's tool guidance (it
   may have a newer version), and the size limits above.
5. **Write the draft in `../askaboard-notes/history/drafts/`** (see its README) and show it to the
   founder before anything ships. Do not edit the live files first.
6. **After approval, build it** (an Opus agent; the plumbing already exists:
   edit `brief.md` and the other files).
7. **Measure:** run the bench twice
   (`node apps/desktop/scripts/bench/run.mjs --scenarios S1,S2,S3,S4 --model opus`,
   see `baseline.md` in the private notes), compare with the earlier runs, and let
   the founder try a real session by voice. Record the results in
   the private `baseline.md`.

## What went wrong in the brief v3 drafts (2026-10-25, do not repeat)

- **Too specific becomes rigid.** A section that walked through one drawing
  step by step ("first the half sphere, then the disc…") and said how small
  each step should be read like a method. The founder: it "might start only
  using one by one changes even when I don't want to … it's too specific and
  detailed and that's why it becomes rigid, compared to other sections."
  Give the agent the forces at play and the choices (a drawing made live
  and a finished figure are both sometimes right), not the one right way.
- **A summary of a subagent's draft is not a rewrite.** When the founder
  asks for text in the brief's own voice, write it fresh from the brief's
  style, not by rephrasing another draft.
- **Do not turn normal conversation into failures.** Remarks like "too much
  information" in a good session are the person steering; they are not
  material for a section of corrections.

## What went wrong in draft v1 (do not repeat)

- **The server instructions carried the story,** in about 300 words of
  orders: "draw the idea and say the explanation", "new material is for a new
  idea". The founder: "it's only exact instructions on what to do, but it
  doesn't explain in any way the reasoning behind it."
- **Media as a list:** "Ink: for drawing an idea … SVG: exact geometry …".
  The founder: a human tutor has years of context about how to teach; the
  model has only what you give it, so a plain list is not enough.
- **One worked example** with tool calls. The founder: "the example itself is
  the biggest thing that limits the agent's imagination and creativity."
- **Earlier still: word limits and style reports** (at most about 25 words a
  visual, warnings in write results). Rejected (decision I1).
- **The emphasis on MCP server instructions.** They are cut at 4,096
  characters in Claude Code. `AGENTS.md`, always in context, is the place
  for the long text.

## What we learned rewriting the brief (2026-10-25, v9 to v18)

The founder chose brief v18 (decision I18). It follows the style of text
that Anthropic writes for its own models: the claude.ai system prompt and the
`frontend-design` skill in github.com/anthropics/skills. Lessons:

- **A conflict makes a literal model pick one side at random.** The old
  board section said both "often the drawing needs none" and "a formula …
  belongs on the board". GPT read the second as permission, and it put
  titles and formulas everywhere. Before a change ships, read the whole brief
  for sentences that a literal reader could take the other way.
- **Change only what was asked, in the voice of the whole text.** A section
  rewritten alone, without reading the sections around it, came out in a
  different voice, repeated the section before, and was rejected (v12–v15).
- **Behaviour first, then the reason, in plain sentences** (v18). Use
  headings that say what to do ("Explain by drawing, one step at a time"),
  and no capital MUST or NEVER.
- **A calibration list works better than a rule.** v18 names the defaults
  that agent drawings drift toward: a title and labels on everything, the
  whole figure at once, shapes that appear complete, formulas under the
  picture, text that retells the drawing, a new picture for every answer. It
  says they are "defaults rather than choices", so the person can still ask
  for one. The pattern comes from `frontend-design`.
- **Vary the examples.** The sphere appeared five times, and it is also a
  lab task. Keep one example per idea, from different subjects.
- **Facts belong in the tools.** How scenes queue and pause, and where the
  references are, belong in the tool descriptions and the guide. The brief
  holds intent.
- **The opening line sets the stance.** v18 opens with "The person came to
  understand something, not to receive a finished answer". With it, Claude
  draws the setup and asks the person to go on, instead of explaining the
  whole idea. The founder liked this; if it ever feels too withholding, that
  line is the place to look.
- **The tools on offer shape the drawing more than the brief does.** While
  `program()` was offered, both models built the EM wave as a 3D code item,
  whatever the brief said (I14). Hand drawing came back when code items were
  switched off (lab switch `--no-code`), and then, with code items on, once
  the brief and the guide said what each kind is for (I20): "a
  three-dimensional subject alone is not a reason for one". I31 replaced that
  steer on 2026-10-31, so this pull toward code can come back. Watch for it.
- **Measure with tasks that pull toward the defaults.** The EM wave and the
  seasons are pictures by nature, so most briefs look alike there.
  `stddev` ("I can compute it but I don't get it") pulls toward formulas and
  text, and it separated the briefs better. Test a draft before it replaces
  the live brief: `node apps/desktop/scripts/lab/council.mjs --client claude --model
  opus --task stddev --brief-only --brief <draft>` (add `--no-code
  --no-html` to hide those kinds). The bench (`scripts/bench/run.mjs`) has
  no brief option and measures only the live brief.

## What went wrong in the scene tool rewrite (T16, 2026-10-26, do not repeat)

- **The new tools got new texts, written from scratch.** The facts were
  right, but the voice and the order changed. The founder did not like the
  result, and I25 brought back the I19/I22 text with only the changes the
  tools needed.
- **Tool mechanics moved into the brief.** These were the tool names in a
  sequence ("write_scene, then play_scene") and a list of moments to check.
- **Three sentences described a feature that was gone** (the layout warnings).
- **A wrong fact went in:** "a draft that only you can see".
- **A proposed fix added new steering text where none had been** (an
  ink-first paragraph in write_scene). The founder rejected it. The steering
  already lived in the brief and the guide (I20), and it had not changed.

## Appendix — the founder's words

Verbatim, as transcribed from speech (2026-10-24). Read them in full.

### On limits and intent (after the word limits were proposed)

> Yeah, I think, I don't know about like having limits on the words and stuff, because I don't want it to be unflexible, you know, but just we need to prompt the agent to not use, like, it should understand like the media and the purpose of a canvas, you know. As for now, I think the prompt says that you need to draw like those cards, and of course it would like put a lot of text on it, and but that is not to say that the LLM like has tendency to do that, like if we don't limit it somehow, but it's just to say that we haven't explained it correctly, I think, to the model. And I don't think we need to treat it as a model, as something like limited and something that we need to control, or like, you know, we should we should take it as a person we're talking to, like as something, agentic, you know. Something that understands and has intent. And that way, the words do we say, the words do we convey, how we present them and how do we make sure it understands exactly what we want, is important. And all the prompting, all the tools, descriptions, all should take that into account and tools and stuff, they shouldn't like treat model as some tool that like splits text, but it should understand that model has some internal dimensions where it could reason about words, and it's intelligent and it's agentic and it behaves like a kind of like a person, and it could understand the intent and the words, how we present them matter. As if it was a person, you know. So yeah, that's my thoughts on like, do we need to like have a reports or something, just because it's unflexible media and I don't know might work like with a smaller models where they're not very intelligent, but I think what I'm using is far more intelligent than just something unreasonable. And in the future, even in a few months, the models are gonna get far more intelligent and far more human-like. And they would have intent and they would understand the small meanings in the words, you know, and then they would understand more and more and how we write those prompts is gonna matter even more in the future. Right. So and about the cards also, like yeah, like just it's not about like allowed or not allowed. It's more about understanding the intent. What is the reason? What you are here to do, like as a tutor or it's not also about the tutoring. I make it a little bit limited it's just a shared canvas. It was an intelligent system that could that you could explain something like talk to and like argue about something and like on the board you could like you know it's like that is to say that we shouldn't always say that like your like a teacher or something, it could be flexible, but you should understand that there are different roles what a person could want, like one model is like a tutor that doesn't give away answers but the other model the other model is something that explains and like gives more information to learn materials or something that just reasons and have fun to like draw or like judge someone's drawing or like I don't know like it could be different things but yeah it all to say that the prompt matters and what we want to convey matters also but I guess currently what I'm trying to do is to make a space where I can learn with a model, with a smart model that could do things on the board and could understand what I want like it could explain things to me, it could draw something to me, to explain it better, like it could make animations or maybe in the future I mean it could explain like draw diagram of the earth and stuff like it could like present things that I couldn't it would be easier to see rather than like listen for 10 hours, you know. That kind of space. And we need to create that space by letting know the agent what we're doing and what this about.

### On the media (when choosing ink, SVG or a mix)

> Yeah, I think currently it should be a mix it should be able and it should know like when to use SVG and when to use ink. But like I think hopefully we find some solution where every media could be combined. Like I don't know really like the ink and SVG could be one tool maybe in the future, so agent has that flexibility of creating anything with ink or like I don't know, yeah, like some drawing engine or like what we have in the drawing apps, like that kind of flexibility of media, you know. But currently, I guess we could try with a mixed and make sure that like the agent understands when to use which and like how to create a good explanation with those tools. Like, and achieve something we want, right? We want from a tutor. Let's try that. I don't currently see an easy fix to how to combine this. So I guess we're gonna go with a mix and make sure that it works somehow. Is that the only decision I need to take?

### On draft v1 (the main critique)

> 'The single example' Yeah, I think the example itself is the biggest thing that limits the agent's imagination and creativity, and maybe we just should remove it if that's possible.
> 'Your own learning folder' I want it updated
> 'Voice mode' it's ok, leave it as is I have read what you've written in the drafts, but I have a lot of opinions and a lot of things to say about this. First of all, I've read the server instructions and stuff, and I think it's too short. Like, if you compare it to Claude's instructions, I think they're enormous and they explain things a lot. And what you've written, I don't agree with how it's written. You say, like, this is the pitfall that you always come down. I don't know how to say, but like, this is the wrong way to do that, to write instructions and stuff. And I'm gonna explain why. It's like, it's only, you've written like exact instructions on what to do, and but it doesn't explain in any way like the reasoning behind it. And I, like I said, like the wording matters, and when you like explain things, only the results and the conclusions and the instructions that you come up with after like reasoning all that and talking with me like for half an hour, for a few hours, that's the wrong way. And because that's because the agent doesn't understand the context, it doesn't understand the reasoning, it doesn't understand the intent. You only give it the instruction. This is like the plain text, do this. This is so wrong, like in many levels. And like I said, instruction could be like a book. It could be like so long, it could explain things so much deeper, and you could choose words to explain and like to come up with the different angles to different things. Like I've already explained, like even one prompt that I said to you, like is much, much longer than the one prompt you said to the tutor model as an instruction. So like even like one idea that I've given to you is much richer with context than what you're trying to write to that, to the learner model as an instruction. So it could like, it It must have that variation and it must have that reasoning behind, not like your doubts or like your thoughts, all that shit, but just the richness of context that you can provide for it and the variety and wideness of possibilities and the space of wording, like it could be so much wider. You could provide so much more context of how what I said, like before that, right? And like, I don't know, like, I'm saying all of those things, but probably you won't understand because you don't have the full context yourself to write that. And I encourage you to read all of my texts that I've written before, like all the prompts that I've said and all the ideas, all the problems, and like all of it should be in the context of a tutor model. Of an instruction for a model, you know, and like for example, when I said that you can use ink, you can use this, you can use this, right? You just wrote the instruction, you can use this, right? That's plain, that's simple, and like if it was like, I don't know, if it was a human that had like a teaching a tutor experience would understand and he has like a whole lot of context about how to teach people, what to like, how to say things, but the model when you're giving instruction doesn't have that. And you need to provide those things and like I said, like you can use ink to do this or to do this or not only about the ink, like but how to behave and how to judge when the user is thinking this way, when to like when to explain this way, or I'm out of examples because I've already said them above, like in all the documents that I've had, like you'd need to provide with all of those things. And so like agents understand, you know, it has all the context to hopefully you understand. And for the tool descriptions, I think this should be the opposite. It shouldn't be very rich in context. It should be like this is what you can do with this tool, and that's exactly what you can do with this tool. And the agent should like judge you, itself with the instruction provided, you know. A tool description should be like you can find Claude Code articles about tool descriptions, how to write them well, I think that would be the best thing you can do right now. Yeah, there's article from Anthropic about tool use and how to write descriptions, which is very, very good, so you can use that article and apply those principles. For tool usage, but for instructions it should be very broad. You can split up a text and text of instructions, and not like bullshit and not like nothing adding anything, but explaining different various aspects, you know. I've hopefully you understand, and hopefully you can read my previous prompts and other ideas and you can come up with some structured instruction that has all that context. But each paragraph has an intent, you know, and it has maybe examples, maybe various situations, like examples explained, but how to explain that. It should give a tutor a way to think, not instruction to do, you know. It should have a way to think about what this is, what this space, how to use this app, how to communicate with a user. You know, it should be a direction or maybe multiple directions or maybe you could it should be a wide variety of things.

### On where the text lives

> Oh, I'm sorry. I meant that not like MCP server instructions, I guess I was wrong, but agent markdown file, I guess, mostly because that's what gets loaded into the model's context, I think that should be the emphasis of this. But you should like understand where to put each, so I guess for this project, we have the full control of all of both sides, like MCP server, whatever, and the also agent MD file, which each agent gets load everything. So it could be like very large. So I guess I was wrong. Like, yeah, like find out where everything fits. I'm not quite sure myself.

> Yeah, as we control both of these things, like decide where everything fits and like how that would impact our development in the future, people might change markdown file or where does the information sit from for MCP server or whatever, how does it all work out?

### On draft v2, and this file

> I actually really like the new brief. For the agents, and I think that's what I really wanted, so yeah, let's implement this and build everything. With how we planned. And can you also like I think this might be helpful save the prompts above that I've said how to get to this result, because like I'm gonna close this session and next time I wanna improve the brief, improve the prompts and all that stuff. This session is gonna be gone. So I want you to create also a new document for how to write prompts and save my exact words yeah, I think we have multiple prompts that I gave you to how to exactly write this, and you also have a context about the app, I want a file where a second agent sometime after that I could point into and it would do the same way as you did now, read all the ideas and all that stuff and find out the Anthropic tools guidance and all that stuff. Can you also do that? Let's start building this and fix and test how this improves. Our baseline measurements,

### On how to work on fixes (earlier the same day)

> Actually, before we start, any of the fixes, besides the baseline, I want to chat with you how we're going to implement them, because I think oftentimes what you propose as a fix is as implementation, it's not usually the best way to implement it. So I'm going to I want to understand exactly how it's going to implement it and I think I intuitively know what's the best way let's talk more about the implementation.
