"""The guards on `fetch_image`.

This is the first thing in the service that opens a connection to an address a
*model* chose, so every test below is a refusal. The one happy path exists to
prove the refusals are not simply refusing everything.
"""

import io
import random
import socket
import struct
import warnings
import zlib

import httpx
import pytest
import respx
from httpx import Response
from PIL import Image

from app.tutor import fetch_image as module
from app.tutor.fetch_image import (
    MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS_TOTAL, MODEL_IMAGE_JPEG_TYPE,
    MODEL_IMAGE_MAX_EDGE, MODEL_IMAGE_MAX_PIXELS, MODEL_IMAGE_PNG_TYPE,
    ImageFetchError, fetch_image, model_copy,
)

#: EXIF's orientation tag. Named rather than written as 274 at the one call
#: site, which is a test asserting a photo comes out upright.
_ORIENTATION_TAG = 274


URL = "https://example.com/cat.png"

#: An address `is_global` accepts. example.com's, as it happens.
PUBLIC = "93.184.216.34"


def _image(fmt: str = "PNG", width: int = 4, height: int = 7) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(buffer, format=fmt)
    return buffer.getvalue()


def _resolving_to(*addresses: str):
    """A stand-in for DNS that answers with exactly these addresses."""
    async def resolve(host: str, port: int) -> list[str]:
        return list(addresses)
    return resolve


@pytest.fixture
def public_dns(monkeypatch):
    """Every hostname resolves to one public address.

    Patched at `_resolve` rather than at `anyio.getaddrinfo` so the tests that
    want the *real* resolver — the loopback ones below — still get it.
    """
    monkeypatch.setattr(module, "_resolve", _resolving_to(PUBLIC))


class _Peer:
    """Enough of an httpx network stream to answer "who did we connect to"."""

    def __init__(self, address: str) -> None:
        self._address = address

    def get_extra_info(self, name: str):
        return (self._address, 443) if name == "server_addr" else None


# --------------------------------------------------------------------------
# The one thing that is supposed to work.
# --------------------------------------------------------------------------


@respx.mock
async def test_a_public_image_comes_back_with_its_bytes_and_its_size(public_dns):
    png = _image(width=4, height=7)
    respx.get(URL).mock(return_value=Response(
        200, headers={"Content-Type": "image/png"}, content=png,
    ))

    fetched = await fetch_image(URL)

    assert fetched.data == png
    assert fetched.content_type == "image/png"
    assert fetched.width == 4
    assert fetched.height == 7


@respx.mock
async def test_the_recorded_type_is_what_the_bytes_are_not_what_the_header_says(
    public_dns,
):
    """The content type is read off the bytes, because that is the one the
    device is later served from `GET /v1/blobs/{key}`. A server that labels a
    JPEG `image/png` is careless rather than hostile, and refusing it would
    cost the learner a picture — but recording its claim would make the blob
    row a lie."""
    jpeg = _image("JPEG", width=8, height=5)
    respx.get(URL).mock(return_value=Response(
        200, headers={"Content-Type": "image/png"}, content=jpeg,
    ))

    fetched = await fetch_image(URL)

    assert fetched.content_type == "image/jpeg"
    assert (fetched.width, fetched.height) == (8, 5)


# --------------------------------------------------------------------------
# Scheme.
# --------------------------------------------------------------------------


@respx.mock
async def test_an_http_url_is_refused_before_anything_is_opened(public_dns):
    route = respx.get("http://example.com/cat.png").mock(
        return_value=Response(200, headers={"Content-Type": "image/png"},
                              content=_image())
    )

    with pytest.raises(ImageFetchError) as caught:
        await fetch_image("http://example.com/cat.png")

    assert "https" in str(caught.value)
    assert not route.called, "a refused scheme must not reach the network"


@pytest.mark.parametrize("url", [
    "file:///etc/passwd",
    "ftp://example.com/cat.png",
    "gopher://example.com:70/x",
    "data:image/png;base64,AAAA",
    "//example.com/cat.png",
    "example.com/cat.png",
])
async def test_no_other_scheme_is_accepted(public_dns, url):
    with pytest.raises(ImageFetchError):
        await fetch_image(url)


async def test_a_url_with_no_host_is_refused(public_dns):
    with pytest.raises(ImageFetchError):
        await fetch_image("https:///cat.png")


# --------------------------------------------------------------------------
# Where the name points. The SSRF guard proper.
# --------------------------------------------------------------------------


@pytest.mark.parametrize("address", [
    "127.0.0.1",        # loopback
    "10.0.0.5",         # RFC 1918
    "172.16.4.4",       # RFC 1918
    "192.168.1.1",      # RFC 1918
    "169.254.169.254",  # the cloud metadata service
    "100.64.0.1",       # carrier-grade NAT
    "0.0.0.0",          # this host
    "::1",              # IPv6 loopback
    "fd00::1",          # IPv6 unique local
    "fe80::1",          # IPv6 link local
    "::ffff:127.0.0.1", # IPv4-mapped loopback
    "224.0.0.1",        # multicast, which `is_global` alone lets through
])
@respx.mock
async def test_a_name_pointing_anywhere_but_the_public_internet_is_refused(
    monkeypatch, address,
):
    route = respx.get(URL).mock(return_value=Response(
        200, headers={"Content-Type": "image/png"}, content=_image(),
    ))
    monkeypatch.setattr(module, "_resolve", _resolving_to(address))

    with pytest.raises(ImageFetchError) as caught:
        await fetch_image(URL)

    assert "public" in str(caught.value)
    assert not route.called, f"{address} must not be connected to"


@respx.mock
async def test_one_private_answer_among_public_ones_refuses_the_whole_name(
    monkeypatch,
):
    """A resolver answers with a *set*, and httpx is free to try any of them.

    Checking only the first is the classic hole: an attacker controls their own
    zone and returns one public A record and one that points inside. Every
    address has to pass or none of them is used.
    """
    route = respx.get(URL).mock(return_value=Response(
        200, headers={"Content-Type": "image/png"}, content=_image(),
    ))
    monkeypatch.setattr(module, "_resolve", _resolving_to(PUBLIC, "10.1.2.3"))

    with pytest.raises(ImageFetchError):
        await fetch_image(URL)

    assert not route.called


@respx.mock
async def test_a_name_that_resolves_to_nothing_is_refused(monkeypatch):
    """"Every address is public" is vacuously true of no addresses at all."""
    route = respx.get(URL).mock(return_value=Response(200, content=b""))
    monkeypatch.setattr(module, "_resolve", _resolving_to())

    with pytest.raises(ImageFetchError):
        await fetch_image(URL)

    assert not route.called


@pytest.mark.parametrize("url", [
    "https://127.0.0.1/cat.png",
    "https://[::1]/cat.png",
    "https://[::ffff:127.0.0.1]/cat.png",
    "https://localhost/cat.png",
])
@respx.mock
async def test_the_real_resolver_refuses_the_machine_this_runs_on(url):
    """No monkeypatching: these go through `anyio.getaddrinfo` itself.

    A literal address and `localhost` both resolve without a network, so this
    exercises the production path rather than a stand-in — including the shape
    of what getaddrinfo hands back, which is where an IPv6 answer differs from
    an IPv4 one and where a wrong tuple index would go unnoticed.
    """
    route = respx.get(url).mock(return_value=Response(
        200, headers={"Content-Type": "image/png"}, content=_image(),
    ))

    with pytest.raises(ImageFetchError) as caught:
        await fetch_image(url)

    assert "public" in str(caught.value)
    assert not route.called


@respx.mock
async def test_a_host_that_moves_between_the_check_and_the_connection_is_refused(
    public_dns,
):
    """DNS rebinding: the name passed the pre-flight check and the connection
    still landed somewhere private, because the second lookup — the one httpx
    itself makes — got a different answer.

    The pre-flight check cannot close this on its own; asking the open socket
    where it actually went is what does.
    """
    respx.get(URL).mock(return_value=Response(
        200, headers={"Content-Type": "image/png"}, content=_image(),
        extensions={"network_stream": _Peer("10.0.0.5")},
    ))

    with pytest.raises(ImageFetchError) as caught:
        await fetch_image(URL)

    assert "public" in str(caught.value)


# --------------------------------------------------------------------------
# Redirects.
# --------------------------------------------------------------------------


@pytest.mark.parametrize("status_code", [301, 302, 303, 307, 308])
@respx.mock
async def test_a_redirect_is_an_error_rather_than_a_second_request(
    public_dns, status_code,
):
    """A followed redirect is the same SSRF hole with an extra hop: the
    location is chosen by whoever answered, and nothing checked it."""
    respx.get(URL).mock(return_value=Response(
        status_code, headers={"Location": "http://169.254.169.254/latest/meta-data/"},
    ))

    with pytest.raises(ImageFetchError) as caught:
        await fetch_image(URL)

    assert "redirect" in str(caught.value)


@respx.mock
async def test_a_failing_status_is_refused(public_dns):
    respx.get(URL).mock(return_value=Response(
        404, headers={"Content-Type": "text/html"}, content=b"<html>no</html>",
    ))

    with pytest.raises(ImageFetchError) as caught:
        await fetch_image(URL)

    assert "404" in str(caught.value)


# --------------------------------------------------------------------------
# What came back.
# --------------------------------------------------------------------------


@pytest.mark.parametrize("content_type", [
    "text/html", "text/html; charset=utf-8", "application/json",
    "image/svg+xml", "application/octet-stream", "",
])
@respx.mock
async def test_a_type_outside_the_allowlist_is_refused(public_dns, content_type):
    """`image/svg+xml` is in this list on purpose. SVG is a document with
    scripts and remote references in it, not a picture, and it is the one
    image/* type that must never reach the device this way."""
    respx.get(URL).mock(return_value=Response(
        200, headers={"Content-Type": content_type}, content=_image(),
    ))

    with pytest.raises(ImageFetchError) as caught:
        await fetch_image(URL)

    assert "image" in str(caught.value)


@respx.mock
async def test_a_declared_length_over_the_cap_is_refused(public_dns):
    respx.get(URL).mock(return_value=Response(
        200, headers={"Content-Type": "image/png"},
        content=b"\0" * (MAX_IMAGE_BYTES + 1),
    ))

    with pytest.raises(ImageFetchError) as caught:
        await fetch_image(URL)

    assert "large" in str(caught.value)


@respx.mock
async def test_a_body_that_outgrows_the_cap_mid_stream_is_refused(public_dns):
    """The header is the server's claim about itself, so it cannot be the only
    check: a chunked answer declares no length at all, and a declared one can
    simply be false. The count that matters is of bytes actually read.

    The declared length here is a lie — 100 bytes, comfortably under the cap,
    in front of twelve megabytes — so the up-front check passes and only the
    running count can refuse this.
    """
    async def body():
        for _ in range(12):
            yield b"\0" * (1024 * 1024)

    respx.get(URL).mock(return_value=Response(
        200,
        headers={"Content-Type": "image/png", "Content-Length": "100"},
        content=body(),
    ))

    with pytest.raises(ImageFetchError) as caught:
        await fetch_image(URL)

    assert "large" in str(caught.value)


@respx.mock
async def test_bytes_that_are_not_an_image_are_refused_whatever_the_header_said(
    public_dns,
):
    respx.get(URL).mock(return_value=Response(
        200, headers={"Content-Type": "image/png"},
        content=b"<html><body>not a picture</body></html>",
    ))

    with pytest.raises(ImageFetchError) as caught:
        await fetch_image(URL)

    assert "image" in str(caught.value)


@respx.mock
async def test_an_empty_body_is_refused(public_dns):
    respx.get(URL).mock(return_value=Response(
        200, headers={"Content-Type": "image/png"}, content=b"",
    ))

    with pytest.raises(ImageFetchError):
        await fetch_image(URL)


# --------------------------------------------------------------------------
# The wait, and the client.
# --------------------------------------------------------------------------


@respx.mock
async def test_a_transport_failure_is_reported_rather_than_raised(public_dns):
    respx.get(URL).mock(side_effect=httpx.ConnectError("refused"))

    with pytest.raises(ImageFetchError):
        await fetch_image(URL)


@respx.mock
async def test_a_slow_server_gives_up_inside_the_fetcher(public_dns, monkeypatch):
    """Bounded by a deadline over the whole fetch, not by httpx's per-operation
    timeouts: a server that sends one byte at a time resets the read timeout
    with every one of them and would otherwise hold the turn open for as long
    as it liked."""
    monkeypatch.setattr(module, "FETCH_TIMEOUT_SECONDS", 0.05)

    async def slow(request):
        import anyio
        await anyio.sleep(5)
        return Response(200, headers={"Content-Type": "image/png"}, content=_image())

    respx.get(URL).mock(side_effect=slow)

    with pytest.raises(ImageFetchError) as caught:
        await fetch_image(URL)

    assert "too long" in str(caught.value)


@respx.mock
async def test_an_injected_client_still_never_follows_a_redirect(public_dns):
    """The caller's client is used as given except for this: `follow_redirects`
    is passed per request, so a client built with it on cannot turn the guard
    off from the outside."""
    respx.get(URL).mock(return_value=Response(
        302, headers={"Location": "https://example.net/other.png"},
    ))

    async with httpx.AsyncClient(follow_redirects=True) as client:
        with pytest.raises(ImageFetchError) as caught:
            await fetch_image(URL, client=client)

    assert "redirect" in str(caught.value)


@pytest.mark.parametrize("failure", [
    socket.gaierror(socket.EAI_NONAME, "nodename nor servname provided"),
    UnicodeError("label too long"),
    OSError("resolver unavailable"),
])
async def test_a_name_that_will_not_resolve_refuses_rather_than_raises(
    monkeypatch, failure,
):
    """The one that would have hurt. A model copying a URL off a web page
    produces dead domains routinely, and `getaddrinfo` answers those with
    `socket.gaierror` — which is not an `ImageFetchError`, so uncaught it does
    not refuse a picture, it reaches the turn handler's generic `except` and is
    recorded as a failed turn."""
    async def broken(host: str, port: int) -> list[str]:
        raise failure

    monkeypatch.setattr(module, "_resolve", broken)

    with pytest.raises(ImageFetchError):
        await fetch_image(URL)


@pytest.mark.parametrize("failure", [
    httpx.ConnectTimeout("slow"),
    httpx.ReadTimeout("slow"),
    httpx.InvalidURL("bad"),
    httpx.StreamError("broken"),
    RuntimeError("something nobody predicted"),
])
@respx.mock
async def test_no_transport_failure_escapes_as_anything_but_a_refusal(
    public_dns, failure,
):
    """`httpx.InvalidURL` and `httpx.StreamError` are outside `httpx.HTTPError`
    entirely, so catching that tree alone leaves them to end the turn. The last
    case is the point of the catch-all: whatever it turns out to be, a picture
    is refused rather than a turn lost."""
    respx.get(URL).mock(side_effect=failure)

    with pytest.raises(ImageFetchError):
        await fetch_image(URL)


@pytest.mark.parametrize("url", [
    "https://[::1",             # unclosed IPv6 literal: `urlsplit` itself raises
    "https://[not-an-address]/",
    "https://example.com:99999/cat.png",
    "https://example.com:port/cat.png",
    "",
])
async def test_a_url_that_will_not_even_parse_is_refused_not_raised(public_dns, url):
    """`urlsplit` is not total, and neither is `.port`. Both raise `ValueError`
    on input a model assembling a URL from a web page produces routinely — and
    both do it before any guard below them has run."""
    with pytest.raises(ImageFetchError):
        await fetch_image(url)


def _png_declaring(width: int, height: int) -> bytes:
    """A valid PNG header claiming a size no file this small could hold.

    Only IHDR and IEND, which is all `Image.open` reads: it takes `.size`
    straight out of the header and stops, so a 70-byte file can announce 169
    megapixels. That asymmetry is the whole point — the server never decodes
    this, the iPad does.
    """
    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data)) + kind + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IEND", b"")


def test_the_crafted_header_really_does_declare_what_it_claims():
    """Guards the guard: if `Image.open` refused this file outright, the two
    tests below would pass for the wrong reason — on "not an image" rather
    than on the pixel ceiling."""
    with Image.open(io.BytesIO(_png_declaring(8000, 8000))) as image:
        assert image.size == (8000, 8000)
        assert image.format == "PNG"
    assert len(_png_declaring(8000, 8000)) < 100, "a tiny file, a vast picture"


@respx.mock
async def test_an_image_declaring_more_pixels_than_the_board_can_draw_is_refused(
    public_dns,
):
    """64 megapixels in a 70-byte file, and **Pillow does not object**: its
    own bomb check does not even warn until ~89 Mpx and does not raise until
    twice that. Nothing upstream catches this — the byte cap sees a tiny file
    — so without this ceiling the blob is recorded, the model places it, and
    the iPad allocates about 256 MB to draw it."""
    respx.get(URL).mock(return_value=Response(
        200, headers={"Content-Type": "image/png"},
        content=_png_declaring(8000, 8000),
    ))

    with pytest.raises(ImageFetchError) as caught:
        await fetch_image(URL)

    assert "8000x8000" in str(caught.value)
    assert "pixels" in str(caught.value)


@respx.mock
async def test_the_gap_above_pillows_warning_and_below_its_error_is_closed(
    public_dns,
):
    """13,000 x 13,000 is 169 Mpx: past `Image.MAX_IMAGE_PIXELS` (~89 Mpx), so
    Pillow warns, and under twice it, so Pillow does **not** raise. A warning
    stops nothing — it is recorded and the file sails on. This is the exact
    band the ceiling exists for, so the warning is asserted rather than
    silenced: it is the proof that nothing else was going to refuse this.
    """
    respx.get(URL).mock(return_value=Response(
        200, headers={"Content-Type": "image/png"},
        content=_png_declaring(13_000, 13_000),
    ))

    with warnings.catch_warnings(record=True) as raised:
        warnings.simplefilter("always")
        with pytest.raises(ImageFetchError) as caught:
            await fetch_image(URL)

    assert "13000x13000" in str(caught.value)
    assert any(
        issubclass(w.category, Image.DecompressionBombWarning) for w in raised
    ), "Pillow only warns in this band — that is why the ceiling is needed"


@respx.mock
async def test_an_image_just_inside_the_pixel_ceiling_is_still_fetched(public_dns):
    """The ceiling refuses what the board cannot draw, not what it can."""
    width, height = 5_000, 6_000
    assert width * height < MAX_IMAGE_PIXELS_TOTAL
    respx.get(URL).mock(return_value=Response(
        200, headers={"Content-Type": "image/png"},
        content=_png_declaring(width, height),
    ))

    fetched = await fetch_image(URL)

    assert (fetched.width, fetched.height) == (width, height)


# --- the copy the model is shown ---------------------------------------------
# Not a guard. It is the same argument about what a picture costs, applied to
# the one place `MAX_IMAGE_PIXELS_TOTAL` says nothing about: the model's own
# context, where a fetched image is re-billed as input on every later round of
# the turn. Two 1080x1080 PNGs across four rounds is what walked a session into
# its account's tokens-per-minute ceiling.


def _transparent(mode: str, width: int, height: int) -> bytes:
    buffer = io.BytesIO()
    Image.new(mode, (width, height), 0).save(buffer, format="PNG")
    return buffer.getvalue()


def _opened(data: bytes) -> Image.Image:
    return Image.open(io.BytesIO(data))


def test_the_model_copy_is_capped_on_its_long_side():
    data, content_type = model_copy(_image("PNG", 1080, 1080), "image/png")

    assert _opened(data).size == (MODEL_IMAGE_MAX_EDGE, MODEL_IMAGE_MAX_EDGE)
    assert content_type in {MODEL_IMAGE_JPEG_TYPE, MODEL_IMAGE_PNG_TYPE}


def test_the_model_copy_keeps_the_shape_of_a_wide_picture():
    """`thumbnail`, not `resize`: a diagram squashed into a square is a diagram
    the model reads wrong."""
    data, _ = model_copy(_image("PNG", 2000, 500), "image/png")

    assert _opened(data).size == (MODEL_IMAGE_MAX_EDGE, MODEL_IMAGE_MAX_EDGE // 4)


def test_a_picture_already_small_enough_is_never_enlarged():
    data, _ = model_copy(_image("PNG", 200, 120), "image/png")

    assert _opened(data).size == (200, 120)


def test_flat_artwork_is_kept_as_a_lossless_png():
    """Both encodings are written and the smaller kept. Flat colour and hard
    edges — clipart, a chart a script drew, a screenshot of an equation, which
    is most of what this tutor fetches — is routinely smaller as PNG *and*
    lossless, so a JPEG's ringing around the text would buy nothing."""
    data, content_type = model_copy(_image("PNG", 1080, 1080), "image/png")

    assert content_type == MODEL_IMAGE_PNG_TYPE
    assert _opened(data).format == "PNG"


def test_a_photograph_is_kept_as_a_jpeg():
    """The other half of the same rule, and the reason it is a comparison
    rather than a preference."""
    noise = Image.new("RGB", (900, 900))
    pixels = noise.load()
    random.seed(11)
    for y in range(900):
        for x in range(900):
            pixels[x, y] = (
                random.randrange(256), random.randrange(256), random.randrange(256),
            )
    buffer = io.BytesIO()
    noise.save(buffer, format="PNG")

    data, content_type = model_copy(buffer.getvalue(), "image/png")

    assert content_type == MODEL_IMAGE_JPEG_TYPE
    assert len(data) < len(buffer.getvalue())


def test_transparency_is_flattened_onto_the_boards_own_white():
    """Chosen to tell the truth rather than to look good. The board's ground is
    white, so this is what the learner will see — and two of the three pictures
    the incident fetched were exactly this case: a white outline on
    transparency, and an alpha silhouette the model read as "completely
    black"."""
    data, _ = model_copy(_transparent("LA", 772, 596), "image/png")

    assert _opened(data).convert("RGB").getpixel((3, 3)) == (255, 255, 255)


def test_a_sideways_photo_is_turned_upright_before_it_is_shown():
    """A phone stores a portrait photo as sensor-native landscape pixels plus an
    orientation tag, and neither encoding this writes carries EXIF — so without
    `exif_transpose` a picture of a worksheet reaches the model on its side and
    it describes what it sees. The same hazard `convert._convert_image` answers
    the same way."""
    landscape = Image.new("RGB", (900, 600), "white")
    exif = landscape.getexif()
    exif[_ORIENTATION_TAG] = 6  # rotate 90° clockwise to display
    buffer = io.BytesIO()
    landscape.save(buffer, format="JPEG", exif=exif)

    data, _ = model_copy(buffer.getvalue(), "image/jpeg")

    width, height = _opened(data).size
    assert height > width, "the tag said portrait, so the pixels must be portrait"


def test_a_picture_that_cannot_be_read_comes_back_exactly_as_it_arrived():
    """Never raises and never refuses a turn: the worst case is the behaviour
    that existed before this function did."""
    assert model_copy(b"not an image at all", "image/png") == (
        b"not an image at all", "image/png",
    )


def test_a_picture_past_the_decode_ceiling_is_refused_rather_than_decoded():
    """This is the only place in the module that decodes rather than measures,
    so it is the only place that pays for pixels — 32 Mpx of RGBA is about
    220 MB in one allocation, inside an event loop serving every other learner's
    turn. Past the ceiling there is no copy and the model is shown no picture. A
    fetched image can never reach it; a file a hosted script wrote arrives
    through no pixel guard at all."""
    huge = _png_declaring(4_000, 3_000)
    assert 4_000 * 3_000 > MODEL_IMAGE_MAX_PIXELS

    assert model_copy(huge, "image/png") is None


def test_the_decode_ceiling_is_well_under_what_a_device_may_be_given():
    """Two ceilings because they bound two machines. `MAX_IMAGE_PIXELS_TOTAL`
    asks what an iPad can draw; `MODEL_IMAGE_MAX_PIXELS` asks what this process
    can hold. Named here so the gap is read rather than inherited."""
    assert MODEL_IMAGE_MAX_PIXELS == 8_000_000
    assert MODEL_IMAGE_MAX_PIXELS < MAX_IMAGE_PIXELS_TOTAL
    # And far past what the output can use: a 768-px long side is at most about
    # 0.6 Mpx, so everything above is detail decoded and thrown away.
    assert MODEL_IMAGE_MAX_EDGE ** 2 < MODEL_IMAGE_MAX_PIXELS
