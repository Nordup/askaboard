from enum import StrEnum

from pydantic import BaseModel

# Split out from extract.py so that consolidation, retrieval and the tutor's
# own memory tool can name a category without importing the extractor — and
# with it an OpenAI client, an API key, and a module whose only job is to talk
# to a provider. The vocabulary is shared; the thing that produces it is not.


class MemoryCategory(StrEnum):
    """A closed set, deliberately.

    Open-ended extraction produces sludge — "the learner asked a question
    about algebra" is technically a fact and is worth nothing. A fixed
    vocabulary is also what makes the profile renderable in sections and
    what lets retrieval filter before it ranks.

    These six values are the same six in `app.store.models.MEMORY_CATEGORIES`,
    which is what `ck_memory_atoms_category` is built from. They are written out
    here rather than derived from that tuple so the members stay statically
    named — `MemoryCategory.goal` resolves for a reader and a type checker —
    and the cost of that duplication is paid by
    `test_categories_match_the_database_constraint`, because a member that
    exists here and not in the CHECK is not a type error, not an import error,
    and not visible until an INSERT rejects a fact in a background pass.

    A Python StrEnum and not a Postgres ENUM: the column is `String(16)` plus a
    CHECK (see the comment on `MemoryAtom.category` for why), so there is no
    database type for this to mirror and nothing here belongs in a migration.
    """
    preference = "preference"      # how they want to be taught
    goal = "goal"                  # what they are working toward
    context = "context"            # durable facts about their situation
    skill_state = "skill_state"    # what they can and cannot do
    misconception = "misconception"  # a specific wrong belief, named
    episode_ref = "episode_ref"    # "we did X on Tuesday"


class ExtractedAtom(BaseModel):
    """One candidate fact, before anything has decided to keep it.

    Not `MemoryAtom`: this has no id, no learner, no provenance and no
    validity interval, because at this point it has none of those things. The
    write path adds them. Keeping the two apart is what lets extraction be
    re-run and its output thrown away without touching a row.
    """

    text: str
    category: MemoryCategory
    stated: bool


#: The response format handed to the provider verbatim. Every object closed
#: with `additionalProperties: false` and every property listed in `required`,
#: because strict structured output rejects a schema that omits either and has
#: no notion of an optional field. The category enum is generated from
#: `MemoryCategory` rather than typed out again: a value the model may return
#: and the database will reject is an atom silently lost between them.
EXTRACTION_SCHEMA: dict = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "atoms": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "text": {
                        "type": "string",
                        "description": (
                            "The fact, written to stand alone with every pronoun and "
                            "reference resolved. Ten to thirty words."
                        ),
                    },
                    "category": {
                        "type": "string",
                        "enum": [c.value for c in MemoryCategory],
                    },
                    "stated": {
                        "type": "boolean",
                        "description": (
                            "True only if the learner said this themselves; false for "
                            "anything concluded, inferred, or guessed at."
                        ),
                    },
                },
                "required": ["text", "category", "stated"],
            },
        }
    },
    "required": ["atoms"],
}
