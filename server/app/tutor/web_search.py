"""The app-owned `web_search` function tool.

`web_search` used to be a hosted tool: the tutor provider owned it, Gemini
renamed it to `google_search`, and the learner's turn depended on whichever
provider happened to be serving that turn. This module makes the tool ours
instead. Whatever family is answering the tutor, the search itself is a single
focused Responses API subrequest on the existing OpenAI key, with the
provider-hosted `type: "web_search"` tool enabled and the sources asked for
explicitly via `include`.

The tool result is deliberately structured evidence rather than prose. The loop
that calls this module emits an SSE `search_sources` event and answers the
model with the same records, so the device can show sources while the tutor
keeps working. A search with zero concrete `http`/`https` URLs is an explicit
failure: the learner gets no invisible fact-finding, and the model is told to
try again or say it could not verify anything.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from dataclasses import dataclass
from functools import lru_cache
from typing import Any
from urllib.parse import urlsplit

from openai import APIError, AsyncOpenAI

from app.config import get_settings

logger = logging.getLogger(__name__)

#: How long the whole focused search subrequest may take.
#
#: This is awaited inside a tool round where no provider events pass through,
#: so the SSE heartbeat cannot cover it. The existing fetch and memory waits
#: bound the same way; twenty seconds is long enough for a hosted search to
#: produce sources while staying far below the client's idle timeout.
WEB_SEARCH_TIMEOUT_SECONDS = 20.0

#: How many distinct usable sources one search may return.
MAX_RESULTS = 4

#: Every event path we need the proof from. The Responses API reports hosted
#: search results as `web_search_call.action.sources`; asking for the full
#: action keeps that structured list on the response instead of only returning
#: the text the model writes.
INCLUDE = ["web_search_call.action.sources"]


@dataclass(frozen=True)
class SearchSource:
    """One concrete source, in the shape the device and model both consume."""

    id: str
    title: str
    url: str
    snippet: str | None = None


@dataclass(frozen=True)
class SearchEvidence:
    """What one `web_search` call found.

    `sources` empty means the call is unusable; `error` says why when the
    provider refused or timed out. The loop is responsible for turning that
    into an explicit tool-result failure.
    """

    query: str
    summary: str | None = None
    sources: tuple[SearchSource, ...] = ()
    error: str | None = None

    @property
    def usable(self) -> bool:
        return bool(self.sources)


@lru_cache
def _client() -> AsyncOpenAI:
    """The one search client, cached like the turn's own OpenAI client.

    Same key, same `max_retries=0` convention: the SDK's transport retry cannot
    tell a billing 429 from a burst limit, and this service's retry policy is
    deliberately kept out of a subrequest that is only worth one bounded try.
    """
    return AsyncOpenAI(api_key=get_settings().openai_api_key, max_retries=0)


def _as_dict(response: Any) -> Any:
    """One SDK response as plain JSON-like data, or the dict already in hand."""
    if isinstance(response, dict):
        return response
    dump = getattr(response, "model_dump", None)
    if callable(dump):
        return dump(mode="json", exclude_none=True)
    return response


def _records_in_output(payload: Any) -> list[dict]:
    if isinstance(payload, dict):
        output = payload.get("output")
        if isinstance(output, list):
            return [item for item in output if isinstance(item, dict)]
        return []
    output = getattr(payload, "output", None)
    if not isinstance(output, list):
        return []
    return [item for item in output if isinstance(item, dict)]


def _url_citation_sources(payload: Any) -> list[dict]:
    """Annotation fallback: `url_citation` entries hanging off any message."""
    found: list[dict] = []
    for item in _records_in_output(payload):
        if item.get("type") != "message":
            continue
        for part in item.get("content") or []:
            if not isinstance(part, dict):
                continue
            for annotation in part.get("annotations") or []:
                if not isinstance(annotation, dict):
                    continue
                if annotation.get("type") != "url_citation":
                    continue
                found.append({
                    "title": annotation.get("title"),
                    "url": annotation.get("url"),
                    "snippet": annotation.get("snippet"),
                })
    return found


def _normalise(raw: dict) -> SearchSource | None:
    url = raw.get("url")
    if not isinstance(url, str):
        return None
    url = url.strip()
    if len(url) > 4096:
        return None
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return None

    title = raw.get("title") if isinstance(raw.get("title"), str) else parts.netloc
    title = (title.strip() or parts.netloc)[:300]
    snippet = (
        raw.get("snippet")
        or raw.get("summary")
        or raw.get("text")
    )
    if not isinstance(snippet, str):
        snippet = None
    else:
        snippet = snippet.strip()[:500] or None

    source_id = raw.get("id")
    if not isinstance(source_id, str) or not source_id.strip():
        digest = hashlib.sha256(url.encode()).hexdigest()[:16]
        source_id = f"src-{digest}"
    return SearchSource(
        id=source_id.strip()[:128],
        title=title,
        url=url,
        snippet=snippet,
    )


def extract_sources(response: Any) -> list[SearchSource]:
    """Concrete, validated, deduplicated sources from a search response.

    Prefers `web_search_call.action.sources` and falls back to
    `url_citation` annotations. Anything that is not a real `http(s)` URL is
    dropped, and exact duplicate URLs are returned once. The number of results
    is capped by `MAX_RESULTS`.
    """
    payload = _as_dict(response)
    raw_sources: list[dict] = []
    for item in _records_in_output(payload):
        if item.get("type") != "web_search_call":
            continue
        action = item.get("action")
        if not isinstance(action, dict):
            continue
        sources = action.get("sources")
        if isinstance(sources, list):
            raw_sources = [
                source for source in sources if isinstance(source, dict)
            ]
            break
    if not raw_sources:
        raw_sources = _url_citation_sources(payload)

    seen: set[str] = set()
    out: list[SearchSource] = []
    for raw in raw_sources:
        source = _normalise(raw)
        if source is None or source.url in seen:
            continue
        seen.add(source.url)
        out.append(source)
        if len(out) >= MAX_RESULTS:
            break
    return out


def extract_summary(response: Any) -> str | None:
    """The grounded prose produced alongside the hosted search, if any."""
    payload = _as_dict(response)
    if isinstance(payload, dict):
        output_text = payload.get("output_text")
        if isinstance(output_text, str) and output_text.strip():
            return output_text.strip()[:4000]
    parts: list[str] = []
    for item in _records_in_output(payload):
        if item.get("type") != "message":
            continue
        for part in item.get("content") or []:
            if not isinstance(part, dict) or part.get("type") != "output_text":
                continue
            text = part.get("text")
            if isinstance(text, str) and text.strip():
                parts.append(text.strip())
    summary = "\n".join(parts).strip()
    return summary[:4000] or None


async def search_web(
    query: str,
    *,
    model: str | None = None,
    include: list[str] | None = None,
    client: AsyncOpenAI | None = None,
    timeout: float = WEB_SEARCH_TIMEOUT_SECONDS,
) -> SearchEvidence:
    """One focused OpenAI Responses subrequest, reduced to source evidence.

    A malformed query, a provider refusal, or a timeout is an unusable result,
    not a raise: a failed search must not end a learner's whole turn. Zero
    sources is equally unusable and is carried that way in `SearchEvidence`.
    """
    if not isinstance(query, str) or not query.strip():
        return SearchEvidence(query=query if isinstance(query, str) else "",
                              error="web_search requires a non-empty query")
    query = query.strip()
    payload = {
        "model": model or get_settings().web_search_model,
        "input": [
            {
                "role": "user",
                "content": [{
                    "type": "input_text",
                    "text": "Search the web for this and return concrete "
                            "sources with URLs: " + query,
                }],
            }
        ],
        "tools": [{"type": "web_search"}],
        "tool_choice": {"type": "web_search"},
        "include": include if include is not None else list(INCLUDE),
        "store": False,
        "stream": False,
    }
    try:
        response = await asyncio.wait_for(
            (client or _client()).responses.create(**payload),
            timeout=timeout,
        )
    except TimeoutError:
        logger.warning("web search timed out after %.0fs", timeout)
        return SearchEvidence(query=query, error="web search timed out")
    except APIError as error:
        logger.warning("web search subrequest failed | %s", error)
        return SearchEvidence(query=query, error="web search call failed")
    except Exception as error:  # broad on purpose: one bad search is not a turn
        logger.warning("web search subrequest raised | %s", error)
        return SearchEvidence(query=query, error="web search call failed")

    sources = tuple(extract_sources(response))
    if not sources:
        logger.warning("web search returned no concrete http(s) sources | query=%s",
                       query)
    return SearchEvidence(
        query=query, summary=extract_summary(response), sources=sources
    )


def evidence_tool_result(evidence: SearchEvidence) -> str:
    """The JSON string the loop answers a `web_search` function call with.

    Kept deterministic and compact enough for the model to read: stable ids,
    titles, URLs and an optional snippet, with an explicit `unusable` status
    when there is no concrete source.
    """
    if not evidence.usable:
        return json.dumps({
            "status": "unusable",
            "error": evidence.error or "no concrete http(s) sources found",
        }, ensure_ascii=False)
    return json.dumps({
        "status": "ok",
        "query": evidence.query,
        "summary": evidence.summary,
        "sources": [
            {
                "id": source.id,
                "title": source.title,
                "url": source.url,
                "snippet": source.snippet,
            }
            for source in evidence.sources
        ],
    }, ensure_ascii=False)
