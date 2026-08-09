"""Coherence Map -> app/learner/seed/ccss_kcs.json. Run once.

    uv run python scripts/build_kc_seed.py

The output is checked in deliberately: a build that reaches out to
tools.achievethecore.org is a build that breaks when they reorganise.

What the source actually looks like (verified 2026-08-09), because it is not
what you would guess from the rendered map:

    window.cc = {
      "standards": {"355": {"id": "355", "ccmathcluster_id": "33",
                            "ordinal": "2", "desc": "<p>Recognize and ...</p>"}},
      "clusters":  {"33": {"id": "33", "ccmathdomain_id": "33", "ordinal": "A"}},
      "domains":   {"33": {"id": "33", "grade": "7", "ordinal": "RP"}},
      "edges":     [{"from": "352", "to": "355"}],
      "nd_edges":  [{"from": "23", "to": "24"}, {"from": "24", "to": "23"}]
    }

Three consequences drive everything below:

`standards`/`clusters`/`domains` are objects keyed by internal row id, not
arrays, and no row carries its Common Core code. `7.RP.A.2` has to be
assembled by walking standard -> cluster -> domain and joining grade, domain
ordinal, cluster ordinal and standard ordinal. The internal ids are the
publisher's primary keys and would be a private vocabulary no model
recognises; the assembled code is the whole point of using this source.

`edges` is directed from prerequisite to dependent — `{"from": "352" (7.RP.A.1),
"to": "355" (7.RP.A.2)}` — so `from` becomes `prereq` and `to` becomes `kc`.

`nd_edges` stores each undirected pair twice, once per direction (283 rows,
141 reciprocated pairs plus one that the publisher only recorded one way).
They are emitted once each, code-ordered, so the file holds 142 facts rather
than 283 half-facts; anything reading them must match on either column.
"""
import html
import json
import pathlib
import re
import urllib.request

SOURCE = "https://tools.achievethecore.org/coherence-map/data.js"
OUT = pathlib.Path(__file__).parent.parent / "app/learner/seed/ccss_kcs.json"
# The host 403s urllib's default `Python-urllib/3.x` agent while serving the
# same URL happily to anything that looks like a browser. Sending one is the
# difference between this script running and not; it is a public static asset
# either way.
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}

_TAG = re.compile(r"<[^>]+>")
_SUP = re.compile(r"<sup>(.*?)</sup>", re.DOTALL | re.IGNORECASE)
_SPACE = re.compile(r"\s+")
_SPACE_BEFORE_PUNCTUATION = re.compile(r"\s+([,.;:!?)])")


def _superscript(match: re.Match) -> str:
    """`<sup>` carries two unrelated things, and one of them is arithmetic.

    61 of the 480 descriptions superscript an exponent, so flattening the tag
    to a space turns `3^2 × 3^-5 = 3^-3` into `3 2 × 3 -5 = 3 -3`: not merely
    uglier, false. These descriptions exist so an annotator can reason about
    the standard, and false arithmetic in one is worse than none.

    The other use is a footnote whose whole sentence is superscripted to hang
    it off a marker in the text above — always asterisk-led, never an
    exponent — so those keep their text and lose the caret.

    Exponents longer than a character are parenthesised: `5^1/3` reads as
    `(5^1)/3`, which is a different number from the cube root of 5.
    """
    body = _SPACE.sub(" ", _TAG.sub(" ", match.group(1))).strip()
    # Entities are decoded only to judge the body; the caller unescapes the
    # whole string once, and unescaping twice would decode any `&amp;lt;` that
    # is meant to survive as text.
    plain = html.unescape(body).strip()
    if not plain:
        return " "
    if plain.startswith("*"):
        return f" {body} "
    return f"^{body}" if len(plain) == 1 else f"^({body})"


def _plain(markup: str) -> str:
    """The `desc` fields are HTML fragments — paragraphs, links, entities.

    Tags become a space rather than nothing: several descriptions wrap a
    phrase in an anchor mid-sentence, and deleting the tags outright would
    weld the words on either side of it together.

    Unescaping happens after the tags are gone, never before: the maths uses
    `&lt;` and `&gt;` for its comparisons, and decoding those first would hand
    the tag stripper live angle brackets to eat.
    """
    text = html.unescape(_TAG.sub(" ", _SUP.sub(_superscript, markup or "")))
    text = _SPACE.sub(" ", text).strip()
    return _SPACE_BEFORE_PUNCTUATION.sub(r"\1", text)


def _title(description: str) -> str:
    """First sentence, capped at 120 characters.

    Enough to identify a standard in a prompt or a log line; the full text
    stays in `description` for anything that needs to reason about it.
    """
    head = description.split(". ")[0].strip()
    if len(head) > 120:
        head = head[:119].rsplit(" ", 1)[0] + "…"
    return head


def _require(data: dict, key: str) -> object:
    """Fail with the current key names rather than a bare KeyError.

    This source has been reorganised before. When it happens again, the next
    person needs to see what the file now offers, not which name we guessed.
    """
    if key not in data:
        raise KeyError(
            f"{SOURCE} has no {key!r}. Top-level keys are now: {sorted(data)}"
        )
    return data[key]


def main() -> None:
    request = urllib.request.Request(SOURCE, headers=HEADERS)
    raw = urllib.request.urlopen(request, timeout=60).read().decode("utf-8")
    start = raw.index("{")
    end = raw.rindex("}") + 1
    data = json.loads(raw[start:end])

    standards = _require(data, "standards")
    clusters = _require(data, "clusters")
    domains = _require(data, "domains")

    def code_for(standard: dict) -> str:
        cluster = clusters[standard["ccmathcluster_id"]]
        domain = domains[cluster["ccmathdomain_id"]]
        grade = domain["grade"]
        # High school standards are not graded, and their official codes run
        # the domain straight onto the HS prefix — HSA-APR.A.1, not HS.A-APR.A.1
        # — because the domain ordinal already carries its own subject letter.
        head = domain["ordinal"]
        head = f"HS{head}" if grade == "HS" else f"{grade}.{head}"
        return f"{head}.{cluster['ordinal']}.{standard['ordinal']}"

    code_by_row_id = {row_id: code_for(row) for row_id, row in standards.items()}
    kcs = []
    for row_id, row in standards.items():
        cluster = clusters[row["ccmathcluster_id"]]
        description = _plain(row["desc"])
        kcs.append({
            "code": code_by_row_id[row_id],
            "title": _title(description),
            "description": description,
            "grade": domains[cluster["ccmathdomain_id"]]["grade"],
        })
    kcs.sort(key=lambda entry: entry["code"])

    def resolve(edge: dict) -> tuple[str, str] | None:
        prereq = code_by_row_id.get(edge["from"])
        kc = code_by_row_id.get(edge["to"])
        return None if prereq is None or kc is None or prereq == kc else (prereq, kc)

    prerequisites = sorted({
        pair for pair in map(resolve, _require(data, "edges")) if pair is not None
    })
    related = sorted({
        tuple(sorted(pair))
        for pair in map(resolve, _require(data, "nd_edges"))
        if pair is not None
    })
    edges = (
        [{"prereq": p, "kc": k, "kind": "prerequisite"} for p, k in prerequisites]
        + [{"prereq": p, "kc": k, "kind": "related"} for p, k in related]
    )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"kcs": kcs, "edges": edges}, indent=1) + "\n")
    print(
        f"{len(kcs)} standards, {len(prerequisites)} prerequisite edges, "
        f"{len(related)} related pairs -> {OUT}"
    )


if __name__ == "__main__":
    main()
