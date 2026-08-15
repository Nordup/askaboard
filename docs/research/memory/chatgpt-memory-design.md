# Memory research: how ChatGPT recalls "last time", and what we should build

Research artifact, 2026-08-15, web-research agent. Sources inline.

## 1. ChatGPT memory, as shipped

Two user-visible systems, several hidden blocks:

**Saved Memories (explicit facts).** Written through the `bio` tool. Injected in a block named **Model Set Context**, timestamped lines `[YYYY-MM-DD]. Memory content.` User-visible and deletable. Wins on conflict. (Embrace The Red / Johann Rehberger, May 2025: embracethered.com/blog/posts/2025/chatgpt-how-does-chat-history-memory-preferences-work/)

**Reference Chat History** (April 2025 rollout). Reverse-engineered injected blocks:
- **Recent Conversation Content** — ~the 40 most recent conversations: timestamp, short title, **only the user's messages** joined with `||||`. Assistant responses excluded. Top 5 get to-the-second timestamps. (Embrace The Red; Shlok Khemani: shloked.com/writing/chatgpt-memory-bitter-lesson)
- **User Knowledge Memories** — dense AI-generated summaries of the whole history, exactly 10 numbered paragraphs, regenerated periodically offline (batch jumps observed). Not user-editable.
- **Assistant Response Preferences** (~15 entries, confidence tags), **Notable Past Conversation Topic Highlights** (~8), **Helpful User Insights** (~14), **User Interaction Metadata** (~17). (Embrace The Red; Simon Willison May 2025: simonwillison.net/2025/May/21/chatgpt-new-memory/)

**The key mechanism: there is no retrieval.** "No extraction of individual memories. No vector databases. No knowledge graphs. No RAG. OpenAI just includes everything with every message" (Khemani). Willison: "a system prompt hack" — a dossier injected at the start of every chat, updated in the background. ChatGPT cannot search its full raw history.

**2026 update ("Dreaming V3", June 2026).** Background process rewrites memory continuously, updates facts over time, exposes an editable memory summary page. Reported evals: factual recall 67.9%→82.8%, accuracy-over-time 52.2%→75.1% (secondary sources — androidauthority.com, techtimes.com — treat numbers with care). Direction: more background synthesis, still injection-first.

## 2. Why "what did we do last time" feels accurate

1. **The recent past is always in context** — no retrieval step, so no retrieval miss. Deterministic.
2. **Summaries exist before the question arrives** — generated asynchronously shortly after activity.
3. **Explicit memories are injected wholesale** — never similarity-gated → always honored.
4. **User messages only** — small block; old model errors don't pollute new chats.
5. **Relevance filtering happens at read time, by the model** — the "bitter lesson" of memory.

**Naive RAG failure modes for recency questions** (embed chunks, cosine on last user message):
- "What did we do last time" has no topical content → embedding matches nothing specific → temporally wrong chunks.
- Cosine similarity is time-blind (temporal-RAG studies: arxiv.org/html/2509.19376, arxiv.org/pdf/2602.11322).
- Chunks cut across session boundaries → top-k mixes days into one confident wrong narrative.
- Old + new versions of a fact both match → stale facts beside fresh ones.
- Retrieval nondeterministic across phrasings → intermittent failure destroys trust.

**LongMemEval (ICLR 2025, arxiv.org/abs/2410.10813)**: assistants drop 30–60% on long-term memory tasks. Fixes: round-level granularity beats whole-session and fact-level; fact-augmented index keys +4% recall; **time-aware indexing + query expansion +7–11% on temporal questions**; structured reading formats +10 points.

## 3. Field convergence 2025–2026

Two-layer consensus: **continuously updated profile injected everywhere + on-demand retrieval over raw past chats.**

- **Claude consumer**: started tools-only (`conversation_search`, `recent_chats` over raw history, no summaries — Khemani, Willison), then added the auto-generated user-editable memory summary (Sept–Oct 2025). Converged onto profile + search.
- **Anthropic API memory tool (Oct 2025)**: file-based `/memories` dir the model edits (6 ops), client-side storage, no embeddings.
- **Gemini**: one `user_context` document — typed outline of short bullets, **every entry carries a timestamp + rationale quoting the source conversation and date** (shloked.com/writing/gemini-memory). Worth copying.
- **Letta/MemGPT**: core memory blocks pinned in prompt, recall memory searchable, archival vector store; **sleep-time compute** moves maintenance to idle time (letta.com/blog/sleep-time-compute/).
- **mem0**: extract candidates → LLM update step resolving each against the store (add/update/invalidate/skip) (arxiv 2504.19413).
- **Hot/cold pattern** (Hermes; manthanguptaa.in/posts/memory_is_a_mistake/): small frozen prompt memory + SQLite session_search; "keep the prompt stable for caching, push everything else to tools"; "storage is easy, retrieval policy is hard."

**The rule:** inject what every turn needs and what must never fail (profile, explicit facts, the recent past — bounded, cache-friendly). Put the unbounded archive behind tools. Summaries answer "what happened"; raw transcripts answer "what exactly was said"; keep both reachable.

## 4. Recommended architecture for the tutoring app

### A. At session end: episodic record

Trigger on session end or inactivity timeout; idempotent, versioned job writes one row per session:

```
session_summaries(
  session_id PK, version, created_at,
  title text,                 -- short, specific ("Fractions: adding unlike denominators")
  narrative text,             -- 150–300 tokens, from the FULL transcript, with exact details
  topics text[], skills jsonb,
  problems jsonb,             -- [{statement, outcome: solved|struggled|skipped, note}]
  misconceptions jsonb, wins jsonb,
  next_steps jsonb,           -- open loops ("promised to review X next time")
  embedding vector            -- of the narrative; used ONLY by the search tool
)
```

The narrative must contain exact details (problem statements, numbers, mistakes). Give the summarizer the transcript + current profile. **Backstop:** if the latest session has no summary row at prompt-build time, inject the raw tail of its transcript instead — zero retrieval risk even when the worker fails.

### B. Every turn: one deterministic injected block (~2.5–3.5k tokens)

1. **Learner profile** (~300–500 tokens), Gemini-style typed sections, each entry dated with a source note; background job rewrites after each session with mem0-style resolution (supersede, not append); nightly sleep-time pass retires stale items, rewrites tenses.
2. **Saved notes, wholesale** — every explicit note, timestamped, never similarity-gated. Cap ~50 notes / ~1k tokens.
3. **Recent sessions digest** — last 5–10 session summaries, newest first, date + title + outcomes + next_steps; the most recent session gets its full narrative. "What did we do last session" answers from context, deterministic.
4. **Full current transcript**, always.

Compose once at session start, byte-stable during the session (prompt caching).

### C. Behind tools: the archive

- `search_sessions(query, topics?, date_from?, date_to?, limit=5)` — hybrid pgvector + full-text, **time as first-class filter/boost**. Returns session cards: id, ISO date AND relative label ("3 weeks ago"), title, narrative, outcomes. Deterministic ordering; include total match count.
- `get_session(session_id, part: summary|transcript, offset?, limit?)` — raw transcript drill-down for exact wording.
- `list_sessions(n, before?, after?)` — pure recency browse.
- `save_note(text)` / `update_note(id, text)` / `delete_note(id)` — the explicit layer; confirm writes to the learner.

### Verification

LongMemEval-style regression set: recency questions, detail questions, update questions. Run on every change. Log which memory source fed each answer.

**Core insight:** ChatGPT's recall feels reliable because the recent past is precomputed and always present, not retrieved. Retrieval is only for the old past — and even there, search summaries first, transcripts second.
