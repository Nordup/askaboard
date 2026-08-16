"""`TOOL_DEFINITIONS` as Gemini function declarations.

One converter rather than a second hand-written schema. The tools are the
tutor's whole board vocabulary; two copies of them would drift, and the drift
would show up as a board that behaves differently depending on which model the
learner picked.

**What is dropped is not what is unchecked.** `strict`, `additionalProperties`
and every numeric and length bound come off here, because Gemini's declaration
schema has nowhere to put them. `parse_board_update` and `lint_svg` still
re-validate every element after the call returns, so the check moves from the
request to the response. It does not disappear. What that costs is the failure
mode: a bound the model breaks is now a rejected element rather than an
argument it was never offered.

Two forms are rewritten rather than dropped, because dropping them changes what
the tool means: `const` becomes a one-value `enum`, and a nullable field's
`["string", "null"]` becomes `type: "string"` with `nullable: true`.
"""

from __future__ import annotations

import copy
from typing import Any

#: Exactly what a Gemini function declaration's schema may contain.
#: Everything else is dropped by the provider, so dropping it here is what
#: makes the request predictable rather than silently trimmed upstream.
GEMINI_SUPPORTED_KEYWORDS: frozenset[str] = frozenset({
    "type", "nullable", "required", "format", "description",
    "properties", "items", "enum", "anyOf",
})

#: What each OpenAI hosted tool is called on the other side.
_HOSTED_TOOLS: dict[str, dict] = {
    "web_search": {"type": "google_search"},
    "code_interpreter": {"type": "code_execution"},
}


def _resolve(node: Any, defs: dict[str, Any]) -> Any:
    """Inline every `$ref`, depth-first.

    `$defs` and `$ref` are documented as supported and reported as rejected, so
    this trades schema size for certainty. `_board_element` builds the arms
    programmatically, so what is inlined is one shared point and one shared
    style block per arm — larger on the wire, identical in meaning.

    A reference to a name that is not in `$defs` raises. A silently unresolved
    reference would reach the provider as an empty object, which accepts
    anything, which is how a typo becomes a tool that takes any arguments at
    all.
    """
    if isinstance(node, list):
        return [_resolve(item, defs) for item in node]
    if not isinstance(node, dict):
        return node
    if "$ref" in node:
        name = node["$ref"].removeprefix("#/$defs/")
        if name not in defs:
            raise KeyError(f"unresolvable $ref {node['$ref']!r}")
        return _resolve(defs[name], defs)
    return {key: _resolve(value, defs) for key, value in node.items()}


def _nullable_type(types: list[Any]) -> tuple[Any, bool]:
    """`["string", "null"]` as Gemini writes it: one type plus a `nullable` flag.

    A Gemini declaration gives `type` a single value and carries nullability in
    a separate boolean, so JSON Schema's type-list form has to be split. Only
    the two-entry `[<type>, "null"]` shape can be split. A list of two real
    types (`["string", "number"]`) has no Gemini expression at all, and a
    longer list has none either.

    Those cases raise, the same way `_resolve` raises on an unresolvable
    `$ref`. The alternatives are both worse. Keeping the list makes the
    declaration malformed, and the six fields that carry this form all sit on
    memory tools, so a Gemini turn would lose `search_history` and its siblings
    while the board still worked — the learner sees a tutor that forgot, not an
    error. Quietly keeping the first entry is worse still: it offers the model
    an argument the tutor does not accept, and the failure lands one round later
    inside the tool call.

    The input is `TOOL_DEFINITIONS`, a module constant, so the raise does not
    depend on what the learner asked: it fires on the first conversion and it
    fires every time. Convert once at startup, and a tool nobody can express
    stops the server in front of whoever edited `tools.py`, rather than a turn
    the learner already sent.
    """
    named = [name for name in types if name != "null"]
    if len(types) != 2 or "null" not in types or len(named) != 1:
        raise ValueError(
            f"no Gemini equivalent for type list {types!r}; only the two-entry "
            '[<type>, "null"] form converts to a nullable declaration'
        )
    return named[0], True


def _strip(node: Any) -> Any:
    """Drop unsupported keywords, and turn `const` into a one-value `enum`.

    `const` is rewritten rather than dropped because it is the `kind`
    discriminator on all twelve arms of `update_board`'s element union. Dropped,
    the arms become indistinguishable and the union stops parsing.

    `properties` gets special handling for a reason that is easy to miss: its
    keys are not schema keywords, they are the tool's own argument names —
    `elements`, `kind`, `x`, `latex`. Checking a property name against
    `GEMINI_SUPPORTED_KEYWORDS` the same way a keyword is checked would treat
    `"elements"` as an unrecognised keyword and drop it, which empties every
    `properties` map in the tree. That is not a smaller schema; it is a tool
    with no arguments at all, silently, which is worse than the union that
    fails to parse.

    A list-valued `type` is split by `_nullable_type` rather than passed
    through. The flag it produces is written after the loop, so it wins over an
    explicit `nullable` on the same node: a node that says both
    `["string", "null"]` and `nullable: false` contradicts itself, and the type
    list is the half that names the type.
    """
    if isinstance(node, list):
        return [_strip(item) for item in node]
    if not isinstance(node, dict):
        return node
    out: dict[str, Any] = {}
    nullable: bool | None = None
    for key, value in node.items():
        if key == "const":
            out["enum"] = [value]
        elif key == "type" and isinstance(value, list):
            out["type"], nullable = _nullable_type(value)
        elif key == "properties" and isinstance(value, dict):
            out["properties"] = {
                name: _strip(schema) for name, schema in value.items()
            }
        elif key in GEMINI_SUPPORTED_KEYWORDS:
            out[key] = _strip(value)
    if nullable is not None:
        out["nullable"] = nullable
    return out


def to_gemini_tools(tools: list[dict]) -> list[dict]:
    """Every tool in `tools`, as the Interactions API takes them."""
    converted: list[dict] = []
    for tool in tools:
        kind = tool.get("type")
        if kind in _HOSTED_TOOLS:
            converted.append(dict(_HOSTED_TOOLS[kind]))
            continue
        if kind != "function":
            raise ValueError(f"no Gemini equivalent for tool type {kind!r}")
        parameters = copy.deepcopy(tool.get("parameters") or {})
        defs = parameters.pop("$defs", {})
        converted.append({
            "type": "function",
            "name": tool["name"],
            "description": tool["description"],
            "parameters": _strip(_resolve(parameters, defs)),
        })
    return converted
