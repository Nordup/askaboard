from app.store.blobs import LocalBlobStore


async def test_put_returns_a_content_addressed_ref(tmp_path):
    store = LocalBlobStore(tmp_path)
    ref = await store.put(b"hello", "text/plain")
    assert ref.key.startswith("sha256:")
    assert ref.bytes == 5


async def test_identical_bytes_are_stored_once(tmp_path):
    store = LocalBlobStore(tmp_path)
    first = await store.put(b"same board", "image/png")
    second = await store.put(b"same board", "image/png")
    assert first.key == second.key
    assert len(list(tmp_path.rglob("*.blob"))) == 1


async def test_get_returns_the_original_bytes(tmp_path):
    store = LocalBlobStore(tmp_path)
    ref = await store.put(b"board pixels", "image/png")
    assert await store.get(ref.key) == b"board pixels"
