import asyncio

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


async def test_concurrent_identical_puts_do_not_race(tmp_path):
    """Regression test for race condition on shared tmp filename.

    When multiple concurrent puts write identical bytes, they must not
    race on tmp filename collisions. The old code used path.with_suffix(".tmp"),
    which derived the tmp name only from the content digest, causing all
    concurrent writes of the same data to use the same tmp path. This led
    to FileNotFoundError (43% failure rate in stress testing).

    This test fires several concurrent puts with identical bytes and asserts
    none raise, and the file is written exactly once with correct content.
    """
    store = LocalBlobStore(tmp_path)
    data = b"x" * 2_600_000  # ~2.6MB to approximate real board snapshots

    # Run 10 iterations to catch the race reliably
    for _ in range(10):
        tmp_path_iteration = tmp_path / f"iteration_{_}"
        tmp_path_iteration.mkdir(exist_ok=True)
        store_iteration = LocalBlobStore(tmp_path_iteration)

        # Fire 8 concurrent puts of identical data
        refs = await asyncio.gather(
            *[store_iteration.put(data, "image/png") for _ in range(8)]
        )

        # All should succeed and return the same key
        assert all(ref.key == refs[0].key for ref in refs)
        assert all(ref.bytes == len(data) for ref in refs)

        # Exactly one file should exist
        blob_files = list(tmp_path_iteration.rglob("*.blob"))
        assert len(blob_files) == 1, f"Expected 1 blob file, found {len(blob_files)}"

        # get() should return exact original bytes
        retrieved = await store_iteration.get(refs[0].key)
        assert retrieved == data
