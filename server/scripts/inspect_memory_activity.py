"""One-off inspection: what did memory do in the latest sessions?

Read-only. Prints, per recent session: the turns, which memory tools fired
(with arguments and a trimmed result), and for the most recent turn what the
assembled prompt actually contained (portrait, digests, learner state).
"""

import asyncio
import json

from sqlalchemy import desc, select

from app.config import get_settings
from app.store.db import dispose_engine, init_engine, session_factory
from app.store.models import (
    Episode,
    LearnerProfile,
    LLMCall,
    MemoryAtom,
    Message,
    Session,
    ToolCall,
    Turn,
)


def trim(s: str, n: int = 160) -> str:
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[: n - 1] + "…"


async def main() -> None:
    get_settings()
    init_engine()
    factory = session_factory()
    async with factory() as db:
        sessions = (
            (await db.execute(select(Session).order_by(desc(Session.started_at)).limit(3)))
            .scalars()
            .all()
        )
        for sess in sessions:
            print("=" * 100)
            print(
                f"SESSION {sess.id}  started={sess.started_at}  "
                f"model={sess.model} effort={sess.reasoning_effort}"
            )
            msgs = (
                (
                    await db.execute(
                        select(Message).where(Message.session_id == sess.id).order_by(Message.seq)
                    )
                )
                .scalars()
                .all()
            )
            print(f"  messages={len(msgs)}")
            for m in msgs[-8:]:
                print(f"    [{m.seq}] {m.role}: {trim(m.text, 140)}")

            turns = (
                (
                    await db.execute(
                        select(Turn).where(Turn.session_id == sess.id).order_by(Turn.started_at)
                    )
                )
                .scalars()
                .all()
            )
            for t in turns[-4:]:
                print(
                    f"  TURN {str(t.id)[:8]} status={t.status} started={t.started_at} "
                    f"in={t.input_tokens} out={t.output_tokens} cached={t.cached_tokens}"
                )
                tcs = (
                    (
                        await db.execute(
                            select(ToolCall).where(ToolCall.turn_id == t.id).order_by(ToolCall.started_at)
                        )
                    )
                    .scalars()
                    .all()
                )
                for tc in tcs:
                    args = trim(json.dumps(tc.arguments or {}), 220)
                    res = trim(json.dumps(tc.result or {}), 400)
                    print(f"    TOOL {tc.name}  args={args}")
                    print(f"         result={res}")
                calls = (
                    (
                        await db.execute(
                            select(LLMCall).where(LLMCall.turn_id == t.id).order_by(LLMCall.seq)
                        )
                    )
                    .scalars()
                    .all()
                )
                for c in calls[-1:]:
                    req = c.request or {}
                    inp = req.get("input") or []
                    instr = req.get("instructions") or ""
                    print(
                        f"    LLM call seq={c.seq} model={c.model} input_items={len(inp)} "
                        f"instructions_chars={len(instr)}"
                    )
                    for marker in (
                        "portrait",
                        "Recent sessions",
                        "recent sessions",
                        "digests",
                        "learner model",
                        "Learner model",
                    ):
                        if marker in instr:
                            i = instr.find(marker)
                            print(f"      INSTR '{marker}' @{i}: {trim(instr[i:i + 400], 380)}")
                    for item in inp[:8]:
                        if not isinstance(item, dict):
                            continue
                        content = item.get("content")
                        texts = []
                        if isinstance(content, str):
                            texts = [content]
                        elif isinstance(content, list):
                            texts = [
                                p["text"]
                                for p in content
                                if isinstance(p, dict) and isinstance(p.get("text"), str)
                            ]
                        for text in texts:
                            if any(
                                k in text
                                for k in ("portrait", "Recent sessions", "digests", "learner model")
                            ):
                                print(f"      INPUT role={item.get('role')}: {trim(text, 500)}")
        print("=" * 100)
        atoms = (
            (await db.execute(select(MemoryAtom).order_by(desc(MemoryAtom.ingested_at)).limit(15)))
            .scalars()
            .all()
        )
        print(f"RECENT ATOMS ({len(atoms)} shown):")
        for a in atoms:
            state = "superseded" if getattr(a, "superseded_by", None) else "live"
            print(f"  [{a.category}] {state} stated={getattr(a, 'stated', '?')} {trim(a.text, 130)}")
        prof = (await db.execute(select(LearnerProfile))).scalars().first()
        if prof:
            print("CURRENT PORTRAIT:")
            print(trim(prof.body, 1200))
        eps = (
            (await db.execute(select(Episode).order_by(desc(Episode.closed_at)).limit(5)))
            .scalars()
            .all()
        )
        print(f"EPISODES: {len(eps)} recent")
        for e in eps:
            print(
                f"  session={e.session_id} extracted_at={e.extracted_at} "
                f"digest={trim(getattr(e, 'digest', '') or '', 140)}"
            )


asyncio.run(main())
