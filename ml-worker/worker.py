from __future__ import annotations

import json
import logging
import os
import socket
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import redis

from adapter import parse_backend_request
from embeddings import encode


logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("ml-worker")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
REQUESTS = os.getenv("ML_REQUEST_STREAM", "planner:ml:requests")
RESULTS = os.getenv("ML_RESULT_STREAM", "planner:ml:results")
GROUP = os.getenv("ML_REQUEST_GROUP", "planner-ml")
CONSUMER = os.getenv("ML_CONSUMER", socket.gethostname())


class EmbeddingHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        self._json(200 if self.path == "/healthz" else 404, {"ok": self.path == "/healthz"})

    def do_POST(self) -> None:
        try:
            if self.path != "/v1/embeddings":
                return self._json(404, {"error": "not_found"})
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 1_000_000:
                return self._json(400, {"error": "invalid_size"})
            body = json.loads(self.rfile.read(length))
            texts = body.get("texts")
            if not isinstance(texts, list) or not texts or len(texts) > 100 or any(not isinstance(text, str) or not text.strip() for text in texts):
                return self._json(400, {"error": "invalid_texts"})
            self._json(200, {"model": os.getenv("GIGACHAT_EMBEDDING_MODEL", "Embeddings-2"), "vectors": encode(texts)})
        except Exception:
            log.exception("embedding request failed")
            self._json(503, {"error": "embeddings_unavailable"})

    def log_message(self, *_: object) -> None:
        return

    def _json(self, status: int, value: dict) -> None:
        raw = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def serve_embeddings() -> None:
    address = os.getenv("EMBEDDINGS_ADDR", "0.0.0.0:8090")
    host, port = address.rsplit(":", 1)
    ThreadingHTTPServer((host, int(port)), EmbeddingHandler).serve_forever()


def expired(job: dict) -> bool:
    deadline = datetime.fromisoformat(job["deadline_at"].replace("Z", "+00:00"))
    return deadline < datetime.now(timezone.utc)


def envelope(job: dict) -> dict | None:
    if expired(job):
        return None
    base = {"version": 1, "message_id": job["message_id"], "attempt_id": job["attempt_id"]}
    try:
        return {**base, "result": parse_backend_request(job["request"])}
    except Exception:
        log.exception("model request failed", extra={"message_id": job.get("message_id")})
        return {**base, "result": None, "error": "llm_unavailable"}


def handle(client: redis.Redis, entry_id: str, fields: dict) -> None:
    try:
        job = json.loads(fields["payload"])
    except Exception:
        log.warning("dropping malformed job %s", entry_id)
        client.pipeline().xack(REQUESTS, GROUP, entry_id).xdel(REQUESTS, entry_id).execute()
        return
    cache_key = f"planner:ml:result:{job.get('attempt_id', '')}"
    cached = client.get(cache_key)
    answer = json.loads(cached) if cached else envelope(job)
    pipe = client.pipeline(transaction=True)
    if answer is not None:
        payload = json.dumps(answer, ensure_ascii=False)
        pipe.xadd(RESULTS, {"payload": payload})
        pipe.set(cache_key, payload, ex=3600, nx=True)
    pipe.xack(REQUESTS, GROUP, entry_id).xdel(REQUESTS, entry_id).execute()


def reclaim(client: redis.Redis) -> None:
    cursor = "0-0"
    while True:
        # Longer than MESSAGE_TIMEOUT: do not steal a job from a healthy worker
        # while it is waiting for the external model.
        claimed = client.xautoclaim(REQUESTS, GROUP, CONSUMER, min_idle_time=120_000, start_id=cursor, count=10)
        cursor, entries = claimed[0], claimed[1]
        for entry_id, fields in entries:
            handle(client, entry_id, fields)
        if cursor == "0-0" or not entries:
            return


def main() -> None:
    if os.getenv("PLANNER_PROVIDER", "gigachat") != "gigachat":
        raise RuntimeError("ml-worker currently requires PLANNER_PROVIDER=gigachat")
    threading.Thread(target=serve_embeddings, name="embeddings-http", daemon=True).start()
    client = redis.Redis.from_url(REDIS_URL, decode_responses=True)
    try:
        client.xgroup_create(REQUESTS, GROUP, id="0", mkstream=True)
    except redis.ResponseError as exc:
        if "BUSYGROUP" not in str(exc):
            raise
    reclaim(client)
    log.info("worker started; requests=%s results=%s group=%s", REQUESTS, RESULTS, GROUP)
    while True:
        response = client.xreadgroup(GROUP, CONSUMER, {REQUESTS: ">"}, count=10, block=2000)
        if not response:
            reclaim(client)
        for _, entries in response:
            for entry_id, fields in entries:
                try:
                    handle(client, entry_id, fields)
                except Exception:
                    log.exception("job failed and remains pending: %s", entry_id)


if __name__ == "__main__":
    main()
