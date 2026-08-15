"""The guards on `fetch_image`.

This is the first thing in the service that opens a connection to an address a
*model* chose, so every test below is a refusal. The one happy path exists to
prove the refusals are not simply refusing everything.
"""

import io
import socket

import httpx
import pytest
import respx
from httpx import Response
from PIL import Image

from app.tutor import fetch_image as module
from app.tutor.fetch_image import MAX_IMAGE_BYTES, ImageFetchError, fetch_image


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
