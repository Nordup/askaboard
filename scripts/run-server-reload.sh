#!/usr/bin/env bash
# Run the backend with auto-reload while editing server code.
#
# Do not use this launcher while testing a live tutor turn. A reload stops
# accepting the image and board-render requests that an already-streaming turn
# needs, so that turn cannot complete normally.
set -euo pipefail
cd "$(dirname "$0")/../server"
exec uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8080
