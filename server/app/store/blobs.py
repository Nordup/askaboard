import asyncio
import hashlib
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


@dataclass(frozen=True)
class BlobRef:
    key: str
    sha256: str
    bytes: int


class BlobStore(Protocol):
    async def put(self, data: bytes, content_type: str) -> BlobRef: ...
    async def get(self, key: str) -> bytes: ...


class LocalBlobStore:
    """Content-addressed files on disk. Swapping in S3/R2 means implementing the
    same two methods; nothing above this layer knows where bytes live."""

    def __init__(self, root: Path) -> None:
        self._root = Path(root)

    def _path_for(self, digest: str) -> Path:
        # Fan out on the first two hex chars so one directory never holds
        # every board snapshot ever captured.
        return self._root / digest[:2] / f"{digest}.blob"

    async def put(self, data: bytes, content_type: str) -> BlobRef:
        digest = hashlib.sha256(data).hexdigest()
        path = self._path_for(digest)

        def _write() -> None:
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.exists():
                return
            # Use mkstemp to create a unique tmp file in the same directory,
            # avoiding race conditions when multiple concurrent puts write
            # identical bytes and would otherwise use the same tmp name.
            fd, tmp_path = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
            try:
                with open(fd, "wb") as f:
                    f.write(data)
                Path(tmp_path).replace(path)
            except Exception:
                Path(tmp_path).unlink(missing_ok=True)
                raise

        await asyncio.to_thread(_write)
        return BlobRef(key=f"sha256:{digest}", sha256=digest, bytes=len(data))

    async def get(self, key: str) -> bytes:
        digest = key.removeprefix("sha256:")
        return await asyncio.to_thread(self._path_for(digest).read_bytes)
