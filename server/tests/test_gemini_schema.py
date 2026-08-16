"""What survives the trip to a Gemini function declaration.

These are invariant sweeps over the whole produced schema, not spot checks on
its top level. `update_board`'s `elements` is a fourteen-arm union built from
`$defs`, and a malformed arm nested three levels down is a blank band on the
learner's board — a top-level assertion would pass while that was broken.
"""

import pytest

from app.tutor.providers.gemini_schema import (
    GEMINI_SUPPORTED_KEYWORDS, to_gemini_tools,
)
from app.tutor.tools import TOOL_DEFINITIONS


def _walk(node):
    """Every schema node in the tree, the root included.

    A `properties` map's own keys are the tool's argument names — `elements`,
    `kind`, `x` — not schema keywords, so that dict is not itself a node to
    check for unsupported keywords. Each of its values is a schema node in
    its own right, and every one of those is still walked and checked.
    """
    if isinstance(node, dict):
        yield node
        for key, value in node.items():
            if key == "properties" and isinstance(value, dict):
                for prop_schema in value.values():
                    yield from _walk(prop_schema)
            else:
                yield from _walk(value)
    elif isinstance(node, list):
        for item in node:
            yield from _walk(item)


@pytest.fixture(scope="module")
def converted():
    return to_gemini_tools(TOOL_DEFINITIONS)


def _declarations(tools):
    return [tool for tool in tools if tool.get("type") == "function"]


#: How many arms `update_board`'s element union has.
#:
#: Pinned exactly rather than as a floor. `>= 12` was the assertion, and a floor
#: cannot fail: it passed while the count was really fourteen, it would pass if
#: an arm were dropped down to twelve, and it would say nothing at all when a
#: fifteenth is added. The number is a claim two comments make in prose —
#: `gemini_schema._strip` and this module's docstring — so it needs one place
#: that fails when the prose goes stale.
BOARD_ELEMENT_ARMS = 14


def test_no_unsupported_keyword_survives_anywhere(converted):
    for declaration in _declarations(converted):
        for node in _walk(declaration["parameters"]):
            unsupported = set(node) - GEMINI_SUPPORTED_KEYWORDS
            assert not unsupported, f"{declaration['name']}: {sorted(unsupported)}"


def test_no_reference_survives_anywhere(converted):
    """Documented as supported, reported as rejected. Inlined instead."""
    for declaration in _declarations(converted):
        for node in _walk(declaration["parameters"]):
            assert "$ref" not in node
            assert "$defs" not in node


def test_strict_is_gone_from_every_declaration(converted):
    for declaration in _declarations(converted):
        assert "strict" not in declaration


def test_every_board_element_arm_keeps_its_discriminator(converted):
    """Every `kind` survives as a non-empty Gemini enum.

    Single-kind arms arrive from `const`; compact shared arms already use an
    enum for renderer-identical kinds such as rectangle/ellipse. Gemini must
    preserve both shapes without requiring every arm to contain one value.
    """
    board = next(d for d in _declarations(converted) if d["name"] == "update_board")
    arms = board["parameters"]["properties"]["elements"]["items"]["anyOf"]
    source = next(t for t in TOOL_DEFINITIONS if t.get("name") == "update_board")
    source_arms = source["parameters"]["properties"]["elements"]["items"]["anyOf"]
    expected = set()
    for arm in source_arms:
        kind = arm["properties"]["kind"]
        expected.update([kind["const"]] if "const" in kind else kind["enum"])

    assert len(source_arms) == BOARD_ELEMENT_ARMS, (
        "an arm was added or removed in tools.py: update BOARD_ELEMENT_ARMS and "
        "the two comments that state the count in prose"
    )
    assert len(arms) == BOARD_ELEMENT_ARMS, "the conversion dropped an arm"
    actual = set()
    for arm in arms:
        kind = arm["properties"]["kind"]
        assert "const" not in kind
        assert kind["enum"]
        actual.update(kind["enum"])
    assert actual == expected


def test_the_hosted_tools_are_renamed(converted):
    types = {tool["type"] for tool in converted}
    assert "google_search" in types
    assert "code_execution" in types
    assert "web_search" not in types
    assert "code_interpreter" not in types


def test_every_custom_tool_survives_the_trip(converted):
    """A dropped tool is a capability that silently differs between the two
    families, which is the trap the picker is supposed to avoid."""
    before = {t["name"] for t in TOOL_DEFINITIONS if t.get("type") == "function"}
    after = {d["name"] for d in _declarations(converted)}
    assert before == after


def test_nullable_types_become_the_nullable_flag(converted):
    """Gemini has no type-list form. `["string", "null"]` left as a list makes the
    declaration malformed, so the failure would be Gemini losing whole tools while
    the board still worked.

    Four tools carry a type-list field, and they are worth naming because the
    obvious guess is wrong: `search_sessions`, `search_history`, `list_sessions`
    and `record_evidence`. `search_memory` is *not* one of them — an earlier
    version of this docstring said it was — so a reader checking the claim by
    reading `search_memory` would have found nothing and concluded the defect was
    imaginary."""
    for declaration in _declarations(converted):
        for node in _walk(declaration["parameters"]):
            assert not isinstance(node.get("type"), list), declaration["name"]


def test_a_nullable_field_keeps_its_type_and_gains_the_flag():
    converted = to_gemini_tools([{
        "type": "function", "name": "t", "description": "d",
        "parameters": {"type": "object", "properties": {
            "q": {"type": ["string", "null"], "description": "maybe"},
        }},
    }])
    field = converted[0]["parameters"]["properties"]["q"]
    assert field["type"] == "string"
    assert field["nullable"] is True


def test_every_property_name_survives_stripping():
    """`_strip` filters schema *keywords*, not property *names*.

    A field named `elements`, `kind`, or `x` is not itself one of Gemini's
    nine keywords, so a stripper that checks property names against
    `GEMINI_SUPPORTED_KEYWORDS` empties every `properties` map in the tree.
    That is a converter that silently produces argument-less tools — strictly
    worse than the union-parsing failure this module exists to prevent.
    """
    converted = to_gemini_tools(TOOL_DEFINITIONS)
    board = next(d for d in _declarations(converted) if d["name"] == "update_board")
    top_level = set(board["parameters"]["properties"])
    assert top_level == {"mode", "delete_ids", "elements"}

    set_workspace = next(
        d for d in _declarations(converted) if d["name"] == "set_workspace"
    )
    plan_fields = set(
        set_workspace["parameters"]["properties"]["plan"]["properties"]
    )
    assert plan_fields == {"title", "goal", "outcomes", "steps", "currentStep"}
