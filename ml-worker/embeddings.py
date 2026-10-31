from __future__ import annotations

import json
import math
import os
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from planner_model.parser import _gigachat_access_token, _gigachat_ssl_context


class EmbeddingError(RuntimeError):
    pass


def encode(texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    request = Request(
        os.getenv("GIGACHAT_EMBEDDINGS_URL", "https://api.giga.chat/v1/embeddings"),
        data=json.dumps({"model": os.getenv("GIGACHAT_EMBEDDING_MODEL", "Embeddings-2"), "input": texts}, ensure_ascii=False).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {_gigachat_access_token(60)}"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=60, context=_gigachat_ssl_context()) as response:
            body = json.load(response)
        rows = sorted(body["data"], key=lambda row: row["index"])
        if [row["index"] for row in rows] != list(range(len(texts))):
            raise EmbeddingError("incomplete embeddings response")
        result = []
        for row in rows:
            vector = [float(value) for value in row["embedding"]]
            norm = math.sqrt(sum(value * value for value in vector))
            if not norm:
                raise EmbeddingError("zero embedding")
            result.append([value / norm for value in vector])
        return result
    except HTTPError as exc:
        raise EmbeddingError(f"embeddings HTTP {exc.code}") from exc
    except URLError as exc:
        raise EmbeddingError(f"embeddings unavailable: {exc.reason}") from exc
    except (KeyError, TypeError, ValueError) as exc:
        raise EmbeddingError("invalid embeddings response") from exc
