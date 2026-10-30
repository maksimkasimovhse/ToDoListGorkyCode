from __future__ import annotations

import json
import re
from datetime import datetime

from planner_model.gigachat_contract import ROUTE_PROMPT, ROUTE_SCHEMA
from planner_model.parser import ModelError, _gigachat_chat, parse_request


INTENT_SCHEMA = {
    "type": "object",
    "properties": {
        "intent": {"type": "string", "enum": ["create", "list", "search", "update", "delete", "complete", "reopen", "help", "cancel", "unsupported"]},
        "entity": {"type": "string", "enum": ["task", "reminder", "meeting", "all"]},
    },
    "required": ["intent", "entity"],
    "additionalProperties": False,
}

INTENT_PROMPT = """Определи намерение команды планировщику.
create — создать, list — показать за период, search — найти, update — изменить/перенести,
delete — удалить, complete — отметить выполненным, reopen — вернуть в работу,
help — помощь, cancel — отмена текущего действия, unsupported — всё остальное.
entity — тип явно названной записи либо all. Не выполняй SQL и не придумывай ID."""

MUTATION_SCHEMA = {
    "type": "object",
    "properties": {
        "target_query": {"type": "string"},
        "target_participant": {"type": "string"},
        "target_type": {"type": "string", "enum": ["task", "reminder", "meeting", "all"]},
        "reference": {"type": "string", "enum": ["filter", "focus", "candidate"]},
        "candidate_number": {"type": "integer"},
        "title": {"type": "string"},
        "date": {"type": "string"},
        "time": {"type": "string"},
        "duration_minutes": {"type": "integer"},
    },
    "required": ["target_query", "target_participant", "target_type", "reference", "candidate_number", "title", "date", "time", "duration_minutes"],
    "additionalProperties": False,
}

MUTATION_PROMPT = """Разбери изменение существующей записи планировщика.
target_query — слова, однозначно описывающие старую запись, без глагола действия.
target_participant — имя участника только если явно названо. target_type — явно названный тип или all.
reference=focus для «её/это/эту», candidate для «первую/вторую» и заполни candidate_number,
иначе filter. Для update новые значения положи в title/date YYYY-MM-DD/time HH:MM/duration_minutes;
отсутствующие строки оставь пустыми, отсутствующее число — 0. Сейчас передан в сообщении."""


def _iso_parts(value: str | None) -> tuple[str | None, str | None]:
    if not value:
        return None, None
    parsed = datetime.fromisoformat(value)
    return parsed.date().isoformat(), parsed.strftime("%H:%M")


def _types(entity: str) -> list[str]:
    return [] if entity == "all" else [entity]


def _map_command(command: dict) -> dict:
    action, entity, data, missing = command["action"], command["entity"], command["data"], command["missing_fields"]
    if action == "create":
        intent = f"create_{entity}"
        params: dict = {"title": data.get("title", "")}
        if entity == "task":
            date, clock = _iso_parts(data.get("due_at"))
            params.update({"date": data.get("due_date") or date, "time": clock})
            if data.get("period_start") and data.get("period_end"):
                params["period"] = {"from": data["period_start"], "to": data["period_end"]}
        elif entity == "reminder":
            date, clock = _iso_parts(data.get("remind_at"))
            params.update({"date": date, "time": clock})
        else:
            date, clock = _iso_parts(data.get("start_at"))
            _, end = _iso_parts(data.get("end_at"))
            params.update({"date": date, "time": clock, "end_time": end,
                           "duration_min": data.get("duration_minutes"),
                           "participants": data.get("participants", []),
                           "location": data.get("location")})
        missing_map = {"start_at": "time", "remind_at": "time", "due": "date", "when.at": "date"}
        mapped_missing = list(dict.fromkeys(missing_map.get(field, field) for field in missing))
        return _result([{"intent": intent, "params": _compact(params)}], mapped_missing)
    if action == "list":
        params = {"from": data.get("period_start"), "to": data.get("period_end"), "types": _types(entity), "kind": "list"}
        return _result([{"intent": "list", "params": _compact(params)}], ["date"] if missing else [])
    if action == "search":
        params = {"query": data.get("query"), "types": _types(entity), "direction": data.get("scope", "any")}
        return _result([{"intent": "search", "params": _compact(params)}], ["query"] if missing else [])
    return {"status": "not_understood", "actions": [], "missing": [], "question": None, "options": []}


def _compact(value: dict) -> dict:
    return {key: item for key, item in value.items() if item is not None and item != ""}


def _result(actions: list[dict], missing: list[str] | None = None) -> dict:
    missing = missing or []
    return {"status": "needs_clarification" if missing else "ready", "actions": actions,
            "missing": missing, "question": None, "options": []}


def _mutation(intent: str, entity: str, raw: dict) -> dict:
    reference = raw["reference"]
    if reference == "candidate":
        target = {"ref": "candidate", "numbers": [raw["candidate_number"]]}
    elif reference == "focus":
        target = {"ref": "focus"}
    else:
        target = {"ref": "filter", "query": raw["target_query"] or None,
                  "participant": raw["target_participant"] or None,
                  "types": _types(raw["target_type"] if raw["target_type"] != "all" else entity),
                  "from": None, "to": None, "status": None, "all": False}
    if intent == "update":
        changes = _compact({"title": raw["title"], "date": raw["date"], "time": raw["time"],
                            "duration_min": raw["duration_minutes"] or None})
        return _result([{"intent": "update", "params": {"target": target, "changes": changes}}])
    if intent in ("complete", "reopen"):
        return _result([{"intent": "complete", "params": {"target": target, "done": intent == "complete"}}])
    return _result([{"intent": "delete", "params": {"target": target}}])


def _parse_single(request: dict, text: str) -> dict:
    now = datetime.fromisoformat(request["now"])
    user_content = f"Сейчас: {now.isoformat()}\nЗапрос: {text}"
    route = _gigachat_chat([{"role": "system", "content": INTENT_PROMPT}, {"role": "user", "content": user_content}], INTENT_SCHEMA, 60)
    intent, entity = route["intent"], route["entity"]
    if intent in ("create", "list", "search"):
        command = parse_request(text, now, provider="gigachat", timeout=60)
        return _map_command(command)
    if intent in ("update", "delete", "complete", "reopen"):
        context = {key: request.get(key) for key in ("focus", "candidates") if request.get(key)}
        raw = _gigachat_chat([{"role": "system", "content": MUTATION_PROMPT},
                              {"role": "user", "content": user_content + "\nКонтекст: " + json.dumps(context, ensure_ascii=False)}], MUTATION_SCHEMA, 60)
        return _mutation(intent, entity, raw)
    if intent in ("help", "cancel"):
        return _result([{"intent": intent, "params": {}}])
    return {"status": "not_understood", "actions": [], "missing": [], "question": None, "options": []}


def parse_backend_request(request: dict) -> dict:
    text = str(request.get("text") or "").strip()
    parts = [part.strip() for part in re.split(
        r"\s+и\s+(?=(?:напомни|добавь|поставь|создай|запиши)\s)", text,
        flags=re.IGNORECASE,
    ) if part.strip()]
    if len(parts) == 1:
        return _parse_single(request, text)
    actions = []
    for part in parts[:20]:
        result = _parse_single(request, part)
        if result["status"] != "ready" or any(not action["intent"].startswith("create_") for action in result["actions"]):
            return result
        actions.extend(result["actions"])
    return _result(actions)
