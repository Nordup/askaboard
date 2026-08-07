#!/usr/bin/env bash
# Run the backend service locally with auto-reload.
#
# Binds 0.0.0.0, not 127.0.0.1, on purpose: the Simulator can reach
# 127.0.0.1, but a physical iPad on the same Wi-Fi network cannot — it needs
# the Mac's LAN address, which only resolves if the server is listening on
# every interface. Do not "fix" this to 127.0.0.1; that would silently
# break the physical-device path documented in server/README.md.
set -euo pipefail
cd "$(dirname "$0")/../server"
exec uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8080
