"""Downloading one picture from an address the *model* chose.

Everything else this service connects to is named in its own configuration:
the provider, the database, the blob store. This is the first thing that opens
a socket to a host that arrived in a tool call — which is to say, a host chosen
by a model reading a web page written by somebody else. That makes this module
a server-side request forgery surface first and a downloader second, and it is
written in that order.

The guards, and what each one is for:

* **`https` only.** `http://` is not a weaker version of the same thing; it is
  a different threat, because a plaintext hop can be answered by anyone on the
  path. `file://`, `gopher://` and friends are refused by the same check.
* **Every resolved address must be public.** A name is not an address, and the
  interesting attack is a hostname the attacker controls that resolves inside
  our network — `169.254.169.254` for cloud credentials, `127.0.0.1` for
  whatever else listens on this box. *Every* address, because a resolver
  answers with a set and the client is free to try any member of it.
* **No redirects.** A followed redirect is the same hole with an extra hop:
  the destination is chosen by whoever answered, and by then nothing has
  checked it. The model is told to use the final URL instead.
* **A type allowlist, checked twice.** Once against the header, and once
  against what the bytes turn out to be. `image/svg+xml` is deliberately absent
  — an SVG is a document with scripts and remote references in it, not a
  picture.
* **A byte cap enforced while reading.** `Content-Length` is a claim the
  server makes about itself; a chunked answer makes no claim at all.
* **One deadline over the whole fetch.** httpx's timeouts are per operation, so
  a server that sends one byte at a time resets the read timeout with each of
  them and holds the turn open indefinitely.

The bytes are then handed to Pillow for their dimensions, which doubles as the
proof they are an image at all.

`model_copy` is the one thing here that is not a guard. It is in this module
because it is the same argument, applied to a different cost: the picture the
*model* is shown does not have to be the picture the *device* is given, and
sending the full-resolution original into a model's context is what turned two
of these downloads into a rate-limited turn. See the constants below it.
"""

from __future__ import annotations

import asyncio
import io
import ipaddress
import logging
import socket
from dataclasses import dataclass
from urllib.parse import urlsplit

import anyio
import httpx
from PIL import Image, ImageOps, UnidentifiedImageError

logger = logging.getLogger(__name__)

#: The most this will ever put in memory, or in the blob store, for one picture.
#:
#: A board image is decoded on an iPad and drawn inside a frame a few hundred
#: points across, so ten megabytes is already far past what any of this can use
#: — it is a ceiling on the damage a hostile server can do, not a quality
#: setting. Enforced against bytes actually read, so a lying `Content-Length`
#: and a chunked body are both covered.
MAX_IMAGE_BYTES = 10 * 1024 * 1024

#: How long the whole fetch may take: DNS, connect, TLS, headers, and body.
#:
#: A *total* deadline, not httpx's per-operation timeouts, and the difference is
#: the whole point. A read timeout is reset by every byte that arrives, so a
#: server dripping one byte per second satisfies it forever while holding a
#: turn open — and this wait is inside a tool round, where no provider event
#: passes through and the learner's connection is silent for its whole length.
#: Ten seconds is generous for one image and well inside the fifteen the loop
#: allows this call before it gives up on it.
FETCH_TIMEOUT_SECONDS = 10.0

#: The most pixels a fetched image may declare.
#:
#: A second ceiling because `MAX_IMAGE_BYTES` is not the same bound and does
#: not imply this one. Compressed formats decouple the two: a 10 MB PNG can
#: legally declare 13,000 x 13,000, which is 169 megapixels and roughly 676 MB
#: of RGBA once something decodes it. The *guard* path never decodes —
#: `Image.open` reads the header and stops — so past this ceiling the whole
#: cost would land on the iPad, at the moment the model places the picture,
#: which is the worst place for it.
#:
#: `model_copy` below does decode, which is why it carries a ceiling of its own
#: rather than borrowing this one. This number is what a *device* can afford to
#: draw; that one is what this process can afford to hold.
#:
#: Pillow's own bomb check does not cover this range. It *warns* above
#: `Image.MAX_IMAGE_PIXELS` (~89 Mpx) and only raises above twice that, so a
#: file between those two passes `Image.open` silently and would be recorded
#: and placed. That gap is what this closes.
#:
#: 32 megapixels is far past anything a board can use — a picture is drawn
#: inside a frame a few hundred points across — so this is a ceiling on the
#: damage, not a quality setting.
MAX_IMAGE_PIXELS_TOTAL = 32_000_000

#: What the server may say it is sending. Nothing else is downloaded.
#:
#: `image/svg+xml` is missing on purpose and must stay missing: SVG is markup
#: with scripts, external references and entities in it, and the device renders
#: what it is given. The four here are raster formats that decode to pixels.
ALLOWED_CONTENT_TYPES = frozenset({
    "image/png", "image/jpeg", "image/webp", "image/gif",
})

#: The same allowlist, keyed by what Pillow says the bytes actually are.
#:
#: This is the second half of the type check, and the half that cannot be lied
#: to. It also decides the content type that is recorded against the blob,
#: because that is what `GET /v1/blobs/{key}` later serves to the device: a
#: server that labels a JPEG `image/png` is careless rather than hostile, and
#: refusing it would cost the learner a picture — but writing its claim into
#: the attachment row would make the row untrue.
_CONTENT_TYPE_OF_FORMAT = {
    "PNG": "image/png",
    "JPEG": "image/jpeg",
    "WEBP": "image/webp",
    "GIF": "image/gif",
}


#: The longest side, in pixels, of the copy the model is shown.
#:
#: Not a quality setting and not the same number as the blob's. The device gets
#: the original — it draws the picture in a frame on a board, and a learner can
#: zoom it — while the model gets this, because what a model does with an image
#: is look at it once and describe it.
#:
#: **The mechanism, stated honestly.** At `detail: "high"` the provider tiles the
#: image it is *delivered* and charges per tile, so the pixels sent are the
#: pixels billed. A 1600-px source is tiled from 1600 px; capping the long side
#: at 768 leaves roughly a quarter of the area and cuts the image's token cost
#: by that order — halved or better against anything a search result hands back.
#: Bytes are the second, smaller saving, and they are real whatever the tiling
#: does: they pay for wire time on every round and for nothing else.
#:
#: The cost this exists to stop is not the one round it is sent on. A turn is
#: up to `MAX_TOOL_ROUNDS` rounds against the same accumulating conversation, so
#: every picture in it is re-billed as input on every later round — two fetched
#: images plus board renders, eight times over, is the shape that walked a
#: session into its account's tokens-per-minute ceiling and lost the reply.
#:
#: The measure of whether this works is `turns.input_tokens` on a turn that
#: fetched a picture, read before and after. Nothing here should be believed
#: from the constant alone.
MODEL_IMAGE_MAX_EDGE = 768

#: The most pixels this module will *decode*, as opposed to measure.
#:
#: Its own number rather than `MAX_IMAGE_PIXELS_TOTAL`, because the two bound
#: different machines. That one asks what an iPad can draw and answers 32 Mpx;
#: this asks what this process can hold while a dozen turns stream, and 32 Mpx
#: of RGBA is about 220 MB in one allocation — inside an event loop that has no
#: other thread to spare.
#:
#: Eight megapixels is far more than the output can use: a 768-px long side is
#: at most about 0.6 Mpx, so anything past this is detail thrown away in the
#: same breath it was decoded. Past the ceiling there is no copy at all and the
#: model is shown no picture — which matters most for a file a hosted script
#: wrote, the one path into here with no pixel guard in front of it.
MODEL_IMAGE_MAX_PIXELS = 8_000_000

#: JPEG quality for that copy. Low enough to matter, high enough that a label
#: on a diagram is still readable — which is the whole reason the picture is
#: shown at all, and why `_image_part` keeps `detail: "high"` beside it.
MODEL_IMAGE_QUALITY = 70

#: The two formats the copy may be written in — both encoded, and the smaller
#: kept.
#:
#: Not "JPEG always". At the same pixel dimensions the provider's documented
#: vision formats cost the same tokens, so format decides bytes alone — and
#: which one wins depends entirely on the picture. A photograph is far smaller
#: as JPEG. A clipart fish, a chart a script drew, a screenshot of an equation
#: — flat colour and hard edges, which is most of what this tutor fetches — is
#: routinely smaller as PNG *and* lossless, so paying for a JPEG's ringing
#: around the text in a diagram would buy nothing.
#:
#: Encoding twice costs a few milliseconds on an image already reduced to at
#: most 768 px, and it happens off the event loop.
MODEL_IMAGE_JPEG_TYPE = "image/jpeg"
MODEL_IMAGE_PNG_TYPE = "image/png"

#: What transparency is flattened onto, and it is chosen to tell the truth
#: rather than to look good. The board's ground is white, so a white outline on
#: a transparent background is invisible *there* — and a model shown that
#: picture on any other ground would describe a fish the learner cannot see.
#: The three pictures fetched in the incident this was written for were exactly
#: this case twice over: one white-on-transparent, one an alpha silhouette the
#: model read as "completely black".
MODEL_IMAGE_BACKGROUND = (255, 255, 255)


def _encoded(image: Image.Image, image_format: str, **options) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format=image_format, **options)
    return buffer.getvalue()


def _smallest(image: Image.Image) -> tuple[bytes, str]:
    """The picture in whichever of the two formats came out smaller.

    Ties go to PNG, which is the lossless one: at equal bytes there is no
    argument for the copy that threw information away.
    """
    jpeg = _encoded(image, "JPEG", quality=MODEL_IMAGE_QUALITY, optimize=True)
    png = _encoded(image, "PNG", optimize=True)
    if len(png) <= len(jpeg):
        return png, MODEL_IMAGE_PNG_TYPE
    return jpeg, MODEL_IMAGE_JPEG_TYPE


def model_copy(data: bytes, content_type: str) -> tuple[bytes, str] | None:
    """A small copy of one picture, for the model's context only.

    Returns `(bytes, content_type)`, or `None` when there should be no picture
    at all. The caller keeps the original either way: the blob store holds full
    resolution because the device fetches from it, and only what goes into the
    conversation is reduced.

    **Blocking, and meant to be called off the event loop.** It decodes,
    resamples and encodes — tens to hundreds of milliseconds — and both callers
    are `async def` inside a turn that is streaming SSE to an iPad *and* sharing
    a process with every other learner's turn. `app.api.turn` runs it through
    `asyncio.to_thread`, which is not optional politeness: called inline it
    stops every stream in the process for its whole length.

    **Never raises.** Every failure — an image Pillow cannot decode, a format
    its plugins mishandle, an encoder that runs out of something — comes back as
    the original bytes unchanged, so the worst case is the behaviour that
    existed before this function did. These are bytes a stranger chose, fed to a
    large parser; the cost of guessing the exception list wrong is a learner's
    turn.

    `None` is the one deliberate refusal, and it is the pixel ceiling. This is
    the only place in the module that decodes rather than measures, so it is the
    only place that pays for pixels; past `MODEL_IMAGE_MAX_PIXELS` nothing is
    decoded and the model is simply not shown the picture. A fetched image can
    never reach that — `_measured` refuses far below it — but a file a hosted
    script wrote arrives here through no pixel guard at all, and a refusal there
    lands on a path that already exists: `relay_item` lists the file with its
    blob id and no picture beside it.
    """
    try:
        with Image.open(io.BytesIO(data)) as image:
            width, height = image.size
            if width <= 0 or height <= 0:
                return data, content_type
            if width * height > MODEL_IMAGE_MAX_PIXELS:
                logger.warning(
                    "refusing to decode a %dx%d image for the model | type=%s",
                    width, height, content_type,
                )
                return None
            # A no-op for every format except JPEG, where it decodes straight to
            # roughly the size wanted instead of decoding in full and throwing
            # most of it away.
            image.draft("RGB", (MODEL_IMAGE_MAX_EDGE, MODEL_IMAGE_MAX_EDGE))
            # A phone stores a portrait photo as sensor-native landscape pixels
            # plus an orientation tag, and neither encoding below carries EXIF —
            # so without this a picture of a worksheet reaches the model on its
            # side, and it describes what it sees. First, because every
            # measurement after it assumes the pixels are upright. The same
            # hazard, and the same one-line answer, as `convert._convert_image`.
            upright = ImageOps.exif_transpose(image)
            transparent = upright.convert("RGBA")
            flattened = Image.new("RGB", transparent.size, MODEL_IMAGE_BACKGROUND)
            flattened.paste(transparent, mask=transparent.split()[-1])
            # `thumbnail` rather than `resize`: it keeps the aspect ratio and it
            # never enlarges, so a picture already smaller than the cap is left
            # at its own size instead of being blown up into blur.
            flattened.thumbnail(
                (MODEL_IMAGE_MAX_EDGE, MODEL_IMAGE_MAX_EDGE),
                Image.Resampling.LANCZOS,
            )
            return _smallest(flattened)
    except Exception as error:
        logger.warning(
            "could not shrink an image for the model | type=%s error=%r",
            content_type, error,
        )
        return data, content_type


class ImageFetchError(Exception):
    """A fetch that was refused or failed, with the reason in the model's words.

    `reason` is read by the model, not by a human: it goes back as the tool's
    output so the next round can do something better than try the same URL
    again. It says what was wrong and, where there is one, what to do instead.
    """

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class FetchedBytes:
    """One picture that passed every guard."""

    data: bytes
    #: What the bytes are, not what the server claimed. See
    #: `_CONTENT_TYPE_OF_FORMAT`.
    content_type: str
    width: int
    height: int


async def _resolve(host: str, port: int) -> list[str]:
    """Every address a hostname points at, as strings.

    Its own function for two reasons. It is the seam the tests replace to put a
    private address behind a public-looking name — which is the attack — and it
    flattens getaddrinfo's five-tuples down to the one field that matters, so
    the check below cannot be reading the wrong index of a structure whose
    shape differs between IPv4 and IPv6.

    `SOCK_STREAM` because a duplicate entry per socket type is the same address
    checked twice, and the connection this precedes is TCP.
    """
    infos = await anyio.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [str(info[4][0]) for info in infos]


def _require_public(host: str, addresses: list[str]) -> None:
    """Refuse a name unless every address it points at is on the open internet.

    `is_global` carries the whole table — loopback, RFC 1918, link-local (and
    with it the cloud metadata service at 169.254.169.254), carrier-grade NAT,
    the IPv6 equivalents, and IPv4-mapped IPv6 — which is exactly why the check
    is written against it rather than against a hand-kept list of prefixes that
    would be wrong the first time a range was reassigned.

    Multicast is refused separately because `is_global` allows it: 224.0.0.0/4
    is not private, so `224.0.0.1` — "every host on this subnet" — passes. A
    TCP connection to a multicast address is not meaningful and will not
    complete, so this is closing a door that has nothing behind it; it is here
    because the next reader should not have to work that out.

    An empty list is refused rather than accepted. "Every address is public" is
    vacuously true of no addresses at all, and that is not the answer to give.
    """
    if not addresses:
        raise ImageFetchError(
            "That address could not be looked up. Check the URL, or use a "
            "different image."
        )
    for address in addresses:
        try:
            parsed = ipaddress.ip_address(address)
        except ValueError:
            # Nothing should reach here — getaddrinfo returns numeric addresses
            # — so an unparseable one means an assumption above is wrong, and
            # the safe reading of that is to refuse.
            raise ImageFetchError(
                "That address could not be checked, so it was not fetched."
            ) from None
        if not parsed.is_global or parsed.is_multicast:
            logger.warning(
                "refusing a non-public fetch target | host=%s address=%s",
                host, address,
            )
            raise ImageFetchError(
                "That host is not a public internet address, so it was not "
                "fetched. Only images on the public web can be loaded."
            )


def _require_public_peer(response: httpx.Response) -> None:
    """Ask the open socket where it actually went.

    `_require_public` resolves the name and then hands the *name* to httpx,
    which resolves it again — so between the two lookups an attacker who
    controls the zone can change the answer, and the connection lands somewhere
    the check already approved a different address for. That is DNS rebinding,
    and no amount of care in the pre-flight check closes it, because the
    pre-flight check is not what chooses the address.

    This is what closes it: the peer address of the connection that actually
    opened. The request has been sent by the time this runs, which is not
    nothing — but no answer from a private host reaches the model or the
    learner, which is the part that matters.

    Silent when the transport does not expose a peer, which is the case under a
    mocked transport and for any future transport that keeps its socket to
    itself. That makes this a second line rather than the only one; the
    pre-flight check stands on its own.
    """
    stream = response.extensions.get("network_stream")
    if stream is None:
        return
    try:
        peer = stream.get_extra_info("server_addr")
    except (AttributeError, TypeError):  # pragma: no cover - transport-specific
        return
    if not peer:
        return
    _require_public("(connected peer)", [str(peer[0])])


def _measured(data: bytes) -> FetchedBytes:
    """The picture's format and size — and, in getting them, proof it is one.

    `Image.open` reads the header and stops, so nothing here decodes a pixel:
    the width and height come out of the file's own metadata. That is what
    makes it safe to run on bytes a stranger sent — and it is also why the
    pixel ceiling below is this module's job rather than Pillow's. Not
    decoding means not paying, so nothing here would ever notice a picture that
    only the *device* cannot afford.

    The format is then checked against the allowlist a second time. The header
    said one thing; this is what the bytes say, and it is the answer recorded
    against the blob.
    """
    try:
        with Image.open(io.BytesIO(data)) as image:
            image_format = image.format
            width, height = image.size
    except Exception:
        # Deliberately every exception, not the four or five Pillow is
        # documented to raise here (`UnidentifiedImageError`,
        # `DecompressionBombError`, `OSError`, `ValueError`, `SyntaxError`).
        # These are bytes a stranger chose, fed to a large parser with plugins
        # in it, and the cost of guessing that list wrong is a turn that dies
        # rather than a picture that is refused.
        raise ImageFetchError(
            "That URL did not return an image. Use the address of the picture "
            "itself — a .png, .jpg, .webp or .gif — not of the page it is on."
        ) from None

    content_type = _CONTENT_TYPE_OF_FORMAT.get(image_format or "")
    if content_type is None or width <= 0 or height <= 0:
        raise ImageFetchError(
            "That image is in a format that cannot be used. Look for a PNG, "
            "JPEG, WebP or GIF instead."
        )
    # Checked against the *declared* size, which is the number that matters:
    # the header is what the device's decoder will believe and allocate for,
    # and this file is never decoded here. See `MAX_IMAGE_PIXELS_TOTAL` for why
    # a byte cap does not already cover this.
    if width * height > MAX_IMAGE_PIXELS_TOTAL:
        raise ImageFetchError(
            f"That image is {width}x{height}, which is too many pixels to put "
            "on the board — it would take hundreds of megabytes to draw. Look "
            "for a smaller version of it."
        )
    return FetchedBytes(
        data=data, content_type=content_type, width=width, height=height,
    )


async def _download(client: httpx.AsyncClient, url: str) -> bytes:
    """The request itself, with every check that has to happen before the body.

    `follow_redirects=False` is passed here rather than left to the client, so
    an injected client built with redirects on cannot turn the guard off from
    the outside.

    Raising inside the `async with` closes the response and drops the
    connection, which is what stops a refused download from being read anyway.
    """
    async with client.stream(
        "GET", url,
        follow_redirects=False,
        timeout=httpx.Timeout(FETCH_TIMEOUT_SECONDS),
        headers={"Accept": ", ".join(sorted(ALLOWED_CONTENT_TYPES))},
    ) as response:
        # First, before anything about the answer is looked at: the question
        # this asks is not "what did they send" but "who is they".
        _require_public_peer(response)

        if response.is_redirect:
            raise ImageFetchError(
                "That URL redirects somewhere else, which is not followed. "
                "Use the address the image is actually served from."
            )
        if response.status_code != 200:
            raise ImageFetchError(
                f"That URL answered {response.status_code}, so there is no "
                "image to use. Try a different one."
            )

        # Parameters split off — `image/png; charset=binary` is a real header —
        # and the whole thing lowercased, because header values are not
        # case-sensitive and `IMAGE/PNG` is not an attack, just a server.
        declared = (response.headers.get("content-type") or "")
        declared = declared.split(";", 1)[0].strip().lower()
        if declared not in ALLOWED_CONTENT_TYPES:
            raise ImageFetchError(
                f"That URL serves {declared or 'no stated type'}, not an "
                "image this board can show. Use a PNG, JPEG, WebP or GIF."
            )

        # The declared length first, so an oversized file is refused before a
        # byte of it is read. It is not trusted — the count below is what
        # actually enforces the cap — but when it is honest it saves the
        # download, and when it is not it costs nothing.
        declared_length = response.headers.get("content-length")
        if declared_length is not None and declared_length.strip().isdigit():
            if int(declared_length) > MAX_IMAGE_BYTES:
                raise ImageFetchError(_TOO_LARGE)

        # Counted on the decoded stream, which is the one that matters: httpx
        # has already undone any `Content-Encoding`, so a small compressed body
        # that expands into gigabytes is caught here rather than in memory.
        chunks: list[bytes] = []
        total = 0
        async for chunk in response.aiter_bytes():
            total += len(chunk)
            if total > MAX_IMAGE_BYTES:
                raise ImageFetchError(_TOO_LARGE)
            chunks.append(chunk)
    return b"".join(chunks)


_TOO_LARGE = (
    "That image is too large to use — the limit is 10 MB. Look for a smaller "
    "version of it."
)

_TOOK_TOO_LONG = (
    "That download took too long and was given up on. Try a different image."
)


async def fetch_image(
    url: str, *, client: httpx.AsyncClient | None = None
) -> FetchedBytes:
    """Download one image, or say why it was refused.

    Raises `ImageFetchError` for everything: a refused scheme, a private
    address, a redirect, a wrong type, an oversized body, a timeout, and any
    transport failure. The caller turns that into `{"error": reason}` and hands
    it to the model, which is free to try a different URL — so a refusal is an
    ordinary outcome here, not an exception in the "something is broken" sense.

    `client` exists so a caller with a pool can lend it. The guards do not
    depend on how it was built: `follow_redirects` and the timeout are passed
    per request.
    """
    try:
        parsed = urlsplit(url)
        scheme, host = parsed.scheme, parsed.hostname
        # `.port` parses lazily, so it is read here rather than where it is
        # used: it raises on a non-numeric port and on one out of range.
        port = parsed.port or 443
    except ValueError:
        # `urlsplit` is not total. `https://[::1` — an unclosed IPv6 literal —
        # raises `ValueError` *out of the parse itself*, before any guard below
        # has run, and a model assembling a URL from something it read produces
        # exactly that. Uncaught it is not a refused picture, it is a lost turn.
        raise ImageFetchError(
            "That URL could not be read. Check it, or use a different image."
        ) from None

    if scheme != "https":
        raise ImageFetchError(
            "Only https URLs can be fetched. Find an https link to the same "
            "image."
        )
    if not host:
        raise ImageFetchError("That URL has no host in it, so it was not fetched.")

    try:
        # The deadline covers the lookup as well as the transfer: a resolver
        # that never answers is the same silence to the learner as a server
        # that never answers.
        async with asyncio.timeout(FETCH_TIMEOUT_SECONDS):
            _require_public(host, await _resolve(host, port))
            if client is not None:
                data = await _download(client, url)
            else:
                async with httpx.AsyncClient(follow_redirects=False) as owned:
                    data = await _download(owned, url)
    except TimeoutError:
        # Only ever this block's own deadline: `asyncio.timeout` re-raises an
        # outer cancellation as `CancelledError`, so a turn-level timeout
        # around this is not misreported as a slow server.
        raise ImageFetchError(_TOOK_TOO_LONG) from None
    except httpx.TimeoutException as error:
        # httpx's own per-operation deadline, which can land first on a connect
        # that hangs. The same thing happened, so the model is told the same
        # thing.
        raise ImageFetchError(_TOOK_TOO_LONG) from error
    except ImageFetchError:
        # Our own refusals, already phrased for the model. Re-raised explicitly
        # so the catch-all below cannot flatten "that host is not public" into
        # "could not be downloaded".
        raise
    except Exception as error:
        # **Every** remaining failure, not the httpx exception tree.
        #
        # A hostname that does not resolve raises `socket.gaierror`; a bad
        # internationalised name raises `UnicodeError`; `httpx.InvalidURL` and
        # `httpx.StreamError` are outside `httpx.HTTPError` entirely. None of
        # those is exotic — a model copying a URL off a web page will produce
        # all of them — and each one, uncaught, does not refuse a picture, it
        # ends the learner's turn: `app.api.turn` catches `ImageFetchError` and
        # nothing else, so anything that gets past here reaches the handler's
        # generic `except Exception` and is recorded as a failed turn.
        #
        # So the class of bug is closed rather than the instances of it, and
        # the log line is what keeps a real defect visible.
        logger.warning("image fetch failed | host=%s error=%r", host, error)
        raise ImageFetchError(
            "That image could not be downloaded. Check the URL, or try a "
            "different image."
        ) from error

    return _measured(data)
