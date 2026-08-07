import os

os.environ.setdefault("OPENAI_API_KEY", "sk-test")
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://test:test@localhost/test")
os.environ.setdefault("DEVICE_TOKEN", "test-token")
os.environ.setdefault("BLOB_DIR", "./.test-blobs")
