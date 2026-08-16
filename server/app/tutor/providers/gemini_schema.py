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
    """
    if isinstance(node, list):
        return [_strip(item) for item in node]
    if not isinstance(node, dict):
        return node
    out: dict[str, Any] = {}
    for key, value in node.items():
        if key == "const":
            out["enum"] = [value]
        elif key == "properties" and isinstance(value, dict):
            out["properties"] = {
                name: _strip(schema) for name, schema in value.items()
            }
        elif key in GEMINI_SUPPORTED_KEYWORDS:
            out[key] = _strip(value)
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
