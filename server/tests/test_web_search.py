from __future__ import annotations

import json

import pytest

from app.tutor.web_search import (
    INCLUDE,
    SearchEvidence,
    SearchSource,
    evidence_tool_result,
    extract_sources,
    extract_summary,
    search_web,
)


class _Responses:
    def __init__(self, response: dict):
        self.response = response
        self.payload: dict | None = None

    async def create(self, **payload):
        self.payload = payload
        return self.response


class _Client:
    def __init__(self, response: dict):
        self.responses = _Responses(response)


def test_extracts_valid_deduplicated_hosted_sources_and_grounded_text():
    response = {
        "output": [
            {
                "type": "web_search_call",
                "action": {"sources": [
                    {"title": "Example", "url": "https://example.com/a",
                     "snippet": "Evidence"},
                    {"title": "Duplicate", "url": "https://example.com/a"},
                    {"title": "Unsafe", "url": "file:///etc/passwd"},
                ]},
            },
            {"type": "message", "content": [
                {"type": "output_text", "text": "Grounded answer."}
            ]},
        ]
    }

    sources = extract_sources(response)
    assert [(source.title, source.url) for source in sources] == [
        ("Example", "https://example.com/a")
    ]
    assert sources[0].id.startswith("src-")
    assert extract_summary(response) == "Grounded answer."


def test_url_citations_are_a_source_fallback():
    sources = extract_sources({"output": [{
        "type": "message",
        "content": [{"type": "output_text", "text": "x", "annotations": [{
            "type": "url_citation", "title": "Docs",
            "url": "https://docs.example/test",
        }]}],
    }]})
    assert [(source.title, source.url) for source in sources] == [
        ("Docs", "https://docs.example/test")
    ]


@pytest.mark.asyncio
async def test_search_forces_the_hosted_tool_and_requests_its_sources():
    client = _Client({"output": [{
        "type": "web_search_call",
        "action": {"sources": [{
            "title": "Source", "url": "https://example.com"
        }]},
    }]})

    evidence = await search_web("current theorem news", client=client,
                                model="test-search-model")

    assert evidence.usable
    assert client.responses.payload["tools"] == [{"type": "web_search"}]
    assert client.responses.payload["tool_choice"] == {"type": "web_search"}
    assert client.responses.payload["include"] == INCLUDE
    assert client.responses.payload["model"] == "test-search-model"


def test_tool_result_never_claims_success_without_concrete_sources():
    unusable = json.loads(evidence_tool_result(SearchEvidence(query="q")))
    assert unusable["status"] == "unusable"

    usable = json.loads(evidence_tool_result(SearchEvidence(
        query="q", summary="Verified", sources=(SearchSource(
            id="s1", title="Source", url="https://example.com"
        ),)
    )))
    assert usable == {
        "status": "ok", "query": "q", "summary": "Verified",
        "sources": [{"id": "s1", "title": "Source",
                     "url": "https://example.com", "snippet": None}],
    }
