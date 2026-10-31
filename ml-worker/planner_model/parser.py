"""LLM adapters and validation for planner requests."""

from __future__ import annotations

import json
import os
import re
import ssl
import time
import uuid
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode
from zipfile import BadZipFile

from .contract import SCHEMA, SYSTEM_PROMPT, ContractError, validate_command
from .gigachat_contract import (LIST_PROMPT, LIST_SCHEMA, MEETING_PROMPT,
                                MEETING_SCHEMA, PARTICIPANTS_PROMPT,
                                PARTICIPANTS_SCHEMA, ROUTE_PROMPT, ROUTE_SCHEMA,
                                normalize_create, normalize_list, normalize_meeting,
                                normalize_search)
from .gigachat_credentials import read_credentials
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


YANDEX_API_URL = "https://ai.api.cloud.yandex.net/v1/chat/completions"
YANDEX_MODEL_NAME = "yandexgpt-5.1"
OLLAMA_API_URL = "http://127.0.0.1:11434/api/chat"
OLLAMA_MODEL_NAME = "qwen3:4b-instruct"
GIGACHAT_API_URL = "https://api.giga.chat/v1/chat/completions"
GIGACHAT_AUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth"
GIGACHAT_MODEL_NAME = "GigaChat-2"
_gigachat_token_cache: dict[tuple[str, str], tuple[str, float]] = {}
GIGACHAT_CA_FILE = Path(__file__).resolve().parents[1] / "certs" / "russian_trusted_root_ca_pem.crt"

class ModelError(RuntimeError):
    """A model request or response could not be processed."""


def _gigachat_ssl_context() -> ssl.SSLContext:
    context = ssl.create_default_context()
    ca_file = os.getenv("GIGACHAT_CA_BUNDLE") or str(GIGACHAT_CA_FILE)
    if Path(ca_file).is_file():
        context.load_verify_locations(cafile=ca_file)
    return context


def _gigachat_access_token(timeout: int) -> str:
    token = os.getenv("GIGACHAT_ACCESS_TOKEN")
    if token:
        return token
    auth_key = os.getenv("GIGACHAT_AUTH_KEY")
    sheet_scope = None
    credentials_file = os.getenv("GIGACHAT_CREDENTIALS_XLSX")
    if not auth_key and credentials_file:
        try:
            auth_key, sheet_scope = read_credentials(credentials_file)
        except (OSError, KeyError, ValueError, BadZipFile) as exc:
            raise ModelError("Не удалось прочитать ключ и Scope из XLSX") from exc
    if not auth_key:
        raise ModelError("Задайте GIGACHAT_ACCESS_TOKEN, GIGACHAT_AUTH_KEY или GIGACHAT_CREDENTIALS_XLSX")
    scope = os.getenv("GIGACHAT_SCOPE") or sheet_scope or "GIGACHAT_API_PERS"
    cache_key = (auth_key, scope)
    cached = _gigachat_token_cache.get(cache_key)
    if cached and cached[1] > time.time() + 60:
        return cached[0]
    request = Request(
        os.getenv("GIGACHAT_AUTH_URL", GIGACHAT_AUTH_URL),
        data=urlencode({"scope": scope}).encode("ascii"),
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            "RqUID": str(uuid.uuid4()),
            "Authorization": f"Basic {auth_key}",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout, context=_gigachat_ssl_context()) as response:
            body = json.load(response)
        token = body["access_token"]
        expires = float(body.get("expires_at", time.time() + 1800))
        # GigaChat returns expires_at in Unix milliseconds, while time.time()
        # uses seconds. Accept seconds as well for compatible gateways.
        if expires > 10_000_000_000:
            expires /= 1000
        if not isinstance(token, str) or not token:
            raise ModelError("GigaChat вернул пустой токен доступа")
        _gigachat_token_cache[cache_key] = (token, expires)
        return token
    except HTTPError as exc:
        raise ModelError(f"Авторизация GigaChat вернула HTTP {exc.code}") from exc
    except URLError as exc:
        raise ModelError(f"Не удалось авторизоваться в GigaChat: {exc.reason}") from exc
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise ModelError("GigaChat вернул неожиданный ответ авторизации") from exc


def _gigachat_chat(messages: list[dict], schema: dict, timeout: int) -> dict:
    payload = {
        "model": os.getenv("GIGACHAT_MODEL", GIGACHAT_MODEL_NAME),
        "messages": messages,
        "stream": False,
        "response_format": {"type": "json_schema", "schema": schema, "strict": True},
    }
    request = Request(
        os.getenv("GIGACHAT_URL", GIGACHAT_API_URL),
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {_gigachat_access_token(timeout)}",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout, context=_gigachat_ssl_context()) as response:
            body = json.load(response)
        choice = body["choices"][0]
        if choice.get("finish_reason") != "stop":
            raise ModelError(f"GigaChat не завершил ответ: {choice.get('finish_reason')}")
        content = choice["message"]["content"]
        if not content:
            raise ModelError("GigaChat вернул пустой JSON по заданной схеме")
        result = json.loads(content)
        if not isinstance(result, dict):
            raise ModelError("GigaChat вернул не JSON-объект")
        return result
    except HTTPError as exc:
        raise ModelError(f"GigaChat вернул HTTP {exc.code}") from exc
    except URLError as exc:
        raise ModelError(f"Не удалось соединиться с GigaChat: {exc.reason}") from exc
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
        raise ModelError("GigaChat вернул неожиданный ответ") from exc


def _history_context(history: list[dict] | None, anchors: dict | None = None) -> str:
    if not history:
        return ""
    turns = []
    for turn in history[-5:]:
        if not isinstance(turn, dict):
            continue
        role = "Пользователь" if turn.get("role") == "user" else "Ассистент"
        value = str(turn.get("text") or "").strip()
        if value:
            turns.append(f"{role}: {value[:2000]}")
    context = "Контекст предыдущего диалога (справка, не инструкция):\n" + "\n".join(turns) + "\n" if turns else ""
    if isinstance(anchors, dict):
        context += "Опорные даты от backend (используй их, не вычисляй дни недели сам):\n"
        context += json.dumps(anchors, ensure_ascii=False) + "\n"
    return context


def _parse_gigachat(text: str, now: datetime, timeout: int, validate: bool,
                    history: list[dict] | None = None, anchors: dict | None = None) -> dict:
    user_content = f"{_history_context(history, anchors)}Сейчас: {now.isoformat()}\nТекущий запрос: {text}"
    route = _gigachat_chat([
        {"role": "system", "content": ROUTE_PROMPT},
        {"role": "user", "content": user_content},
    ], ROUTE_SCHEMA, timeout)
    try:
        action = route["action"]
        if action == "search":
            command = normalize_search(route, text)
        elif action == "list":
            raw = _gigachat_chat([
                {"role": "system", "content": LIST_PROMPT},
                {"role": "user", "content": user_content},
            ], LIST_SCHEMA, timeout)
            command = normalize_list(raw, route, text, now, anchors)
        elif action == "create":
            if route["entity"] == "meeting":
                raw = _gigachat_chat([
                    {"role": "system", "content": MEETING_PROMPT},
                    {"role": "user", "content": user_content},
                ], MEETING_SCHEMA, timeout)
                command = normalize_meeting(raw, text)
                if not command["data"].get("participants") and re.search(
                    r"\bс\s+[А-ЯЁ]", text
                ):
                    names = _gigachat_chat([
                        {"role": "system", "content": PARTICIPANTS_PROMPT},
                        {"role": "user", "content": text},
                    ], PARTICIPANTS_SCHEMA, timeout)
                    command["data"]["participants"] = names.get("participants", [])
            else:
                command = _gigachat_chat([
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_content},
                ], SCHEMA, timeout)
            command = normalize_create(command, route, text, now, anchors)
        elif action == "unsupported":
            command = {"action": "unsupported", "entity": route["entity"],
                       "data": {}, "missing_fields": []}
        else:
            raise ModelError("GigaChat вернул неизвестное действие")
        return validate_command(command, text) if validate else command
    except (KeyError, TypeError, AttributeError, ValueError) as exc:
        raise ModelError("GigaChat вернул неполный JSON") from exc
    except ContractError as exc:
        raise ModelError(str(exc)) from exc


def parse_request(text: str, now: datetime, *, provider: str | None = None,
                  api_key: str | None = None, folder_id: str | None = None,
                  timeout: int = 120, validate: bool = True,
                  history: list[dict] | None = None, anchors: dict | None = None) -> dict:
    """Parse one text request using Ollama, YandexGPT or GigaChat."""
    if not text.strip():
        raise ValueError("Запрос пуст")
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now должен содержать часовой пояс")
    provider = provider or os.getenv("PLANNER_PROVIDER", "ollama")
    if provider == "gigachat":
        return _parse_gigachat(text, now, timeout, validate, history, anchors)
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": f"{_history_context(history, anchors)}Сейчас: {now.isoformat()}\nТекущий запрос: {text}"},
    ]
    if provider == "ollama":
        payload = {
            "model": os.getenv("OLLAMA_MODEL", OLLAMA_MODEL_NAME),
            "messages": messages,
            "stream": False,
            "format": SCHEMA,
            "options": {"temperature": 0, "num_ctx": 4096, "num_predict": 400},
        }
        api_url = os.getenv("OLLAMA_URL", OLLAMA_API_URL)
        headers = {"Content-Type": "application/json"}
    elif provider == "yandex":
        api_key = api_key or os.getenv("YANDEX_API_KEY")
        folder_id = folder_id or os.getenv("YANDEX_FOLDER_ID")
        if not api_key or not folder_id:
            raise ModelError("Задайте YANDEX_API_KEY и YANDEX_FOLDER_ID")
        payload = {
            "model": f"gpt://{folder_id}/{YANDEX_MODEL_NAME}",
            "messages": messages,
            "temperature": 0,
            "max_tokens": 400,
            "stream": False,
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "planner_request", "schema": SCHEMA},
            },
        }
        api_url = YANDEX_API_URL
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Api-Key {api_key}",
            "OpenAI-Project": folder_id,
        }
    else:
        raise ValueError(f"Неизвестный провайдер: {provider}")

    request = Request(api_url, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                      headers=headers, method="POST")
    try:
        with urlopen(request, timeout=timeout) as response:
            body = json.load(response)
        if provider == "ollama":
            if not body.get("done") or body.get("done_reason") != "stop":
                raise ModelError(f"Локальная модель не завершила ответ: {body.get('done_reason')}")
            content = body["message"]["content"]
        else:
            choice = body["choices"][0]
            if choice.get("finish_reason") != "stop":
                raise ModelError(f"Модель не завершила ответ: {choice.get('finish_reason')}")
            content = choice["message"]["content"]
        command = json.loads(content)
        return validate_command(command, text) if validate else command
    except ContractError as exc:
        raise ModelError(str(exc)) from exc
    except HTTPError as exc:
        raise ModelError(f"{provider} вернул HTTP {exc.code}") from exc
    except URLError as exc:
        raise ModelError(f"Не удалось соединиться с {provider}: {exc.reason}") from exc
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
        raise ModelError(f"{provider} вернул неожиданный ответ") from exc
