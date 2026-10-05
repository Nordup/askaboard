#!/usr/bin/env python3
"""Run the web product against a persistent, isolated local database."""
import argparse
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "server"
PYTHON = SERVER / ".venv/bin/python"
CONTAINER = "math-tutor-web-db"
DB_URL = "postgresql+asyncpg://mathtutor:math-tutor-local@127.0.0.1:55432/mathtutor_web"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--qa", action="store_true", help="Use a dummy provider key; no paid API calls.")
    args = parser.parse_args()
    if not PYTHON.exists():
        sys.exit("Install server dependencies first: cd server && uv sync")
    # Re-enter with the project's interpreter so dotenv is available.
    if Path(sys.executable).resolve() != PYTHON.resolve():
        os.execv(str(PYTHON), [str(PYTHON), __file__, *sys.argv[1:]])
    from dotenv import dotenv_values

    config = ROOT / ".env.web"
    if not config.exists():
        config.write_text(f"WEB_BOOTSTRAP_CODE={secrets.token_urlsafe(18)}\nWEB_SESSION_SECRET={secrets.token_urlsafe(48)}\n")
        config.chmod(0o600)
    env = {**os.environ, **{k: v for k, v in dotenv_values(SERVER / ".env").items() if v is not None},
           **{k: v for k, v in dotenv_values(config).items() if v is not None}}
    env.update(DATABASE_URL=DB_URL, WEB_SESSION_SECURE="false", LANGSMITH_TRACING="false",
               BLOB_DIR=str(SERVER / "blobs-web"), LOG_DIR=str(SERVER / "logs-web"), WEB_DIST_DIR="")
    if args.qa:
        env.update(OPENAI_API_KEY="sk-web-qa-no-provider", GEMINI_API_KEY="")
    if not env.get("OPENAI_API_KEY") or not env.get("DEVICE_TOKEN"):
        sys.exit("Configure OPENAI_API_KEY and DEVICE_TOKEN in server/.env first.")
    try:
        subprocess.run(["docker", "info"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (FileNotFoundError, subprocess.CalledProcessError):
        sys.exit("Start Docker Desktop or run colima start, then retry.")
    existing = subprocess.run(["docker", "container", "inspect", CONTAINER], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if existing.returncode:
        subprocess.run(["docker", "run", "--name", CONTAINER, "--label", "math-tutor.scope=web-development",
                        "-e", "POSTGRES_USER=mathtutor", "-e", "POSTGRES_PASSWORD=math-tutor-local",
                        "-e", "POSTGRES_DB=mathtutor_web", "-p", "127.0.0.1:55432:5432",
                        "-v", "math-tutor-web-data:/var/lib/postgresql/data", "-d", "pgvector/pgvector:pg17"], check=True)
    else:
        subprocess.run(["docker", "start", CONTAINER], check=True, stdout=subprocess.DEVNULL)
    for _ in range(60):
        ready = subprocess.run(["docker", "exec", CONTAINER, "pg_isready", "-U", "mathtutor"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if ready.returncode == 0:
            break
        time.sleep(.5)
    else:
        sys.exit("Local database did not become ready.")
    subprocess.run(["docker", "exec", CONTAINER, "psql", "-U", "mathtutor", "-d", "mathtutor_web", "-c",
                    "CREATE EXTENSION IF NOT EXISTS vector;"], check=True, stdout=subprocess.DEVNULL)
    subprocess.run([str(PYTHON), "-m", "alembic", "upgrade", "head"], cwd=SERVER, env=env, check=True)
    if not (ROOT / "web/node_modules").exists():
        subprocess.run(["npm", "ci"], cwd=ROOT / "web", check=True)
    print("Math Tutor: http://127.0.0.1:5173", flush=True)
    print(f"Local access code: {env['WEB_BOOTSTRAP_CODE']}", flush=True)
    print("Uses the isolated math-tutor-web-data volume. Ctrl-C stops both servers.", flush=True)
    children = []
    try:
        children.append(subprocess.Popen([str(PYTHON), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8080"], cwd=SERVER, env=env))
        children.append(subprocess.Popen(["npm", "run", "dev"], cwd=ROOT / "web", env=env))
        while all(child.poll() is None for child in children):
            time.sleep(.5)
    except KeyboardInterrupt:
        pass
    finally:
        for child in children:
            if child.poll() is None:
                child.terminate()
        for child in children:
            try:
                child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                child.kill()


if __name__ == "__main__":
    main()
