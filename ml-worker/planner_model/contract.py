"""Structured command schema and validation for planner requests."""

from __future__ import annotations

import re
from datetime import date, datetime


SCHEMA = {
    "type": "object",
    "properties": {
        "action": {"type": "string", "enum": ["create", "list", "search", "unsupported"]},
        "entity": {"type": "string", "enum": ["task", "reminder", "note", "meeting", "all"]},
        "data": {
            "type": "object",
            "properties": {
                "title": {"type": ["string", "null"]},
                "description": {"type": ["string", "null"]},
                "when": {
                    "type": ["object", "null"],
                    "properties": {
                        "kind": {"type": "string", "enum": ["scheduled", "deadline", "reminder"]},
                        "at": {"type": ["string", "null"]},
                        "source": {"type": ["string", "null"]},
                    },
                    "required": ["kind", "at", "source"],
                    "additionalProperties": False,
                },
                "remind_at": {"type": ["string", "null"]},
                "due_date": {"type": ["string", "null"]},
                "due_at": {"type": ["string", "null"]},
                "project_name": {"type": ["string", "null"]},
                "group_name": {"type": ["string", "null"]},
                "tags": {"type": "array", "items": {"type": "string"}},
                "priority": {"type": ["string", "null"], "enum": ["low", "normal", "high", None]},
                "flags": {"type": "array", "items": {"type": "string", "enum": ["pinned", "private"]}},
                "start_at": {"type": ["string", "null"]},
                "end_at": {"type": ["string", "null"]},
                "duration_minutes": {"type": ["integer", "null"]},
                "participants": {"type": "array", "items": {"type": "string"}},
                "location": {"type": ["string", "null"]},
                "recurrence": {"type": ["string", "null"]},
                "period_start": {"type": ["string", "null"]},
                "period_end": {"type": ["string", "null"]},
                "query": {"type": ["string", "null"]},
                "scope": {"type": "string", "enum": ["past", "future", "all"]},
                "time_expression": {"type": ["string", "null"]},
            },
            "additionalProperties": False,
        },
        "missing_fields": {
            "type": "array",
            "items": {"type": "string", "enum": ["title", "when.at", "due", "remind_at", "start_at", "period", "query"]},
        },
    },
    "required": ["action", "entity", "data", "missing_fields"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = """Разбери один текстовый запрос к личному планировщику. Верни только JSON по схеме.
Сейчас и часовой пояс переданы в сообщении пользователя. Относительные даты вычисляй от них.
Поддерживай create, list, search. task, reminder, note, meeting — разные типы;
all только для списка/поиска. «Напомни» — reminder, «встреча/созвон» — meeting,
«позвонить/написать» без «напомни» — task.
Название обязательно. Для задачи срок — ровно один вариант: due_date (только дата),
due_at (точное время) или period_start + period_end (срок-период).
Не придумывай час: «завтра» без часа — due_date. Если срока нет, добавь due в missing_fields.
Напоминание требует remind_at. Встреча требует start_at; end_at можно опустить,
если время окончания не сказано. Для встречи participants — названные люди,
location — явно названное место. Заметка может быть без времени.
Используй прямые поля due_date, due_at, remind_at, start_at; старое поле when не выводи.
time_expression содержит дословный фрагмент запроса, если он есть.
Для list возвращай [period_start, period_end) в ISO 8601 с часовым поясом.
Для search возвращай query и scope=past для «была/раньше», future для «будет», иначе all.
project_name, group_name, tags, flags, priority и description заполняй только из текста.
Не выдумывай существующие записи, ID, статус сохранения или ответ пользователю.
Неприменимые поля в data опускай. Если не хватает данных, сохраняй action=create
и укажи недостающие поля в missing_fields.
"""


class ContractError(ValueError):
    """The structured model output is unusable."""


def _aware_datetime(value: object, field: str) -> datetime:
    if not isinstance(value, str):
        raise ContractError(f"{field} должен быть строкой ISO 8601")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ContractError(f"{field} содержит некорректную дату") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ContractError(f"{field} должен содержать часовой пояс")
    return parsed


def validate_command(command: object, text: str | None = None) -> dict:
    """Validate a model command before any state-changing action."""
    if not isinstance(command, dict) or set(command) != set(SCHEMA["properties"]):
        raise ContractError("Неверные верхние поля JSON")
    action, entity, data, missing = (command[key] for key in ("action", "entity", "data", "missing_fields"))
    if action not in ("create", "list", "search", "unsupported"):
        raise ContractError("Неизвестное действие")
    if entity not in ("task", "reminder", "note", "meeting", "all"):
        raise ContractError("Неизвестный тип записи")
    if not isinstance(data, dict) or not set(data) <= set(SCHEMA["properties"]["data"]["properties"]):
        raise ContractError("Неверные поля data")
    allowed_missing = ("title", "when.at", "due", "remind_at", "start_at", "period", "query")
    if not isinstance(missing, list) or any(item not in allowed_missing for item in missing) or len(set(missing)) != len(missing):
        raise ContractError("Неверный missing_fields")
    for field in ("title", "description", "remind_at", "due_date", "due_at", "project_name", "group_name",
                  "start_at", "end_at", "location", "recurrence", "period_start", "period_end",
                  "query", "time_expression"):
        if field in data and data[field] is not None and not isinstance(data[field], str):
            raise ContractError(f"{field} должен быть строкой или null")
    if "priority" in data and data["priority"] not in (None, "low", "normal", "high"):
        raise ContractError("Неверный priority")
    if "scope" in data and data["scope"] not in ("past", "future", "all"):
        raise ContractError("Неверный scope")
    for field in ("tags", "flags", "participants"):
        if field in data and (not isinstance(data[field], list) or any(not isinstance(x, str) for x in data[field])):
            raise ContractError(f"{field} должен быть списком строк")
    if any(flag not in ("pinned", "private") for flag in data.get("flags", [])):
        raise ContractError("Неизвестный флаг")
    if "duration_minutes" in data and data["duration_minutes"] is not None:
        if not isinstance(data["duration_minutes"], int) or data["duration_minutes"] <= 0:
            raise ContractError("Неверная длительность")
    when = data.get("when")
    if when is not None:
        if not isinstance(when, dict) or set(when) != {"kind", "at", "source"}:
            raise ContractError("Неверная структура when")
        if when["kind"] not in ("scheduled", "deadline", "reminder"):
            raise ContractError("Неверный тип времени")
        if when["at"] is not None:
            _aware_datetime(when["at"], "when.at")
        if when["source"] is not None:
            if not isinstance(when["source"], str) or (text is not None and when["source"].lower() not in text.lower()):
                raise ContractError("when.source не является фрагментом запроса")
    if data.get("time_expression") and text is not None and data["time_expression"].lower() not in text.lower():
        raise ContractError("time_expression не является фрагментом запроса")
    if data.get("due_date") is not None:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", data["due_date"]):
            raise ContractError("due_date должен быть датой YYYY-MM-DD")
        try:
            date.fromisoformat(data["due_date"])
        except ValueError as exc:
            raise ContractError("due_date содержит некорректную дату") from exc
    for field in ("remind_at", "due_at", "start_at", "end_at", "period_start", "period_end"):
        if data.get(field) is not None:
            _aware_datetime(data[field], field)

    if bool(data.get("period_start")) != bool(data.get("period_end")) and action == "create":
        raise ContractError("Для срока-периода нужны обе границы")
    if data.get("period_start") and data.get("period_end"):
        if _aware_datetime(data["period_start"], "period_start") >= _aware_datetime(data["period_end"], "period_end"):
            raise ContractError("Конец периода должен быть позже начала")
    if action == "create" and entity == "meeting" and data.get("start_at") and data.get("end_at"):
        if _aware_datetime(data["start_at"], "start_at") >= _aware_datetime(data["end_at"], "end_at"):
            raise ContractError("Конец встречи должен быть позже начала")

    if action == "create":
        if entity == "all":
            raise ContractError("Нельзя создать запись типа all")
        if not data.get("title") and "title" not in missing:
            raise ContractError("Название отсутствует без уточнения")
        due_variants = sum(bool(value) for value in (
            data.get("due_date"), data.get("due_at") or (when and when.get("at")),
            data.get("period_start") and data.get("period_end"),
        ))
        if entity == "task" and due_variants > 1:
            raise ContractError("У задачи должен быть один вариант срока")
        if entity == "task" and not due_variants and not {"due", "when.at"}.intersection(missing):
            raise ContractError("Для задачи нужен срок")
        if entity == "reminder" and not (data.get("remind_at") or (when and when.get("at"))):
            if "remind_at" not in missing and "when.at" not in missing:
                raise ContractError("Для напоминания нужно точное время")
        if entity == "meeting" and not data.get("start_at") and "start_at" not in missing:
            raise ContractError("Для встречи нужно время начала")
    elif action == "list":
        start, end = data.get("period_start"), data.get("period_end")
        if start and end:
            if _aware_datetime(start, "period_start") >= _aware_datetime(end, "period_end"):
                raise ContractError("Конец периода должен быть позже начала")
        elif "period" not in missing:
            raise ContractError("Для списка нужен период")
    elif action == "search" and not data.get("query") and "query" not in missing:
        raise ContractError("Для поиска нужен предмет поиска")
    return command
