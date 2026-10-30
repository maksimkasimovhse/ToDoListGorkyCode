"""Small GigaChat schemas mapped to the planner's internal command contract."""

from __future__ import annotations

import re
from datetime import datetime, time, timedelta


ROUTE_SCHEMA = {
    "type": "object",
    "properties": {
        "action": {"type": "string", "enum": ["create", "list", "search", "unsupported"]},
        "entity": {"type": "string", "enum": ["task", "reminder", "note", "meeting", "all"]},
        "query": {"type": "string"},
        "scope": {"type": "string", "enum": ["past", "future", "all"]},
        "project_name": {"type": "string"},
        "group_name": {"type": "string"},
    },
    "required": ["action", "entity", "query", "scope", "project_name", "group_name"],
    "additionalProperties": False,
}

LIST_SCHEMA = {
    "type": "object",
    "properties": {
        "entity": {"type": "string", "enum": ["task", "reminder", "note", "meeting", "all"]},
        "period_start": {"type": "string"},
        "period_end": {"type": "string"},
        "time_expression": {"type": "string"},
    },
    "required": ["entity", "period_start", "period_end", "time_expression"],
    "additionalProperties": False,
}

MEETING_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "description": {"type": "string"},
        "start_at": {"type": "string"},
        "end_at": {"type": "string"},
        "duration_minutes": {"type": "integer"},
        "remind_at": {"type": "string"},
        "participants": {"type": "array", "items": {"type": "string"}},
        "location": {"type": "string"},
        "recurrence": {"type": "string"},
    },
    "required": ["title", "description", "start_at", "end_at", "duration_minutes",
                 "remind_at", "participants", "location", "recurrence"],
    "additionalProperties": False,
}

PARTICIPANTS_SCHEMA = {
    "type": "object",
    "properties": {"participants": {"type": "array", "items": {"type": "string"}}},
    "required": ["participants"],
    "additionalProperties": False,
}

ROUTE_PROMPT = """Определи действие пользователя в планировщике: create, list, search или unsupported.
Верни JSON по схеме. entity=reminder для «напомни», entity=meeting для «встреча/созвон».
query — только предмет поиска, без слов «найди» и «задача».
Для create и list query — пустая строка. scope=past для «старую», «раньше», «была»;
scope=future для «будет»; иначе all. Название проекта и группы бери только из текста,
иначе верни пустые строки. group_name заполняй только после слова «группа»;
#метка — это тег, не группа. Не придумывай записи из базы.
"""

LIST_PROMPT = """Разбери запрос просмотра планировщика. Верни JSON по схеме.
Сейчас и часовой пояс указаны в сообщении. period_start включительно,
period_end исключительно, оба ISO 8601 с часовым поясом.
time_expression — дословный фрагмент исходного запроса, задающий период.
Если период не указан, верни пустые строки для обеих границ.
"""

MEETING_PROMPT = """Разбери запрос на создание встречи. Верни JSON по схеме.
Сейчас и часовой пояс указаны в сообщении. start_at и end_at — ISO 8601 с часовым поясом.
Участники — имена людей из запроса в начальной форме; место — явно названное место.
Если время конца не указано, end_at — пустая строка и duration_minutes=0:
приложение назначит 60 минут. Остальные отсутствующие строки оставь пустыми,
participants — пустым массивом. Название — короткая суть встречи без времени.
"""

PARTICIPANTS_PROMPT = """Извлеки только явно названных участников встречи.
Верни их имена в начальной форме, например «с Иваном» → «Иван».
Не добавляй людей, которых нет в исходном тексте. Верни JSON по схеме.
"""


def normalize_meeting(raw: dict, text: str = "") -> dict:
    data = {}
    for field in ("title", "description", "start_at", "end_at", "remind_at",
                  "location", "recurrence"):
        value = raw.get(field)
        if isinstance(value, str) and value.strip():
            data[field] = value.strip()
    duration = raw.get("duration_minutes")
    if isinstance(duration, int) and duration > 0:
        data["duration_minutes"] = duration
    if isinstance(raw.get("participants"), list):
        data["participants"] = raw["participants"]
    # The model occasionally returns 00:00 for both bounds of an explicitly
    # all-day meeting. Keep only the start date: the backend will create the
    # [00:00, next 00:00) interval itself.
    if re.search(r"\b(?:на\s+)?(?:целый|весь)\s+день\b", text, flags=re.IGNORECASE):
        data.pop("end_at", None)
    missing = []
    if not data.get("title"):
        missing.append("title")
    if not data.get("start_at"):
        missing.append("start_at")
    return {"action": "create", "entity": "meeting", "data": data, "missing_fields": missing}


def _explicit_name(route: dict, field: str, text: str) -> str | None:
    value = route[field].strip()
    cue = "проект" if field == "project_name" else "групп"
    if value and not value.startswith("#") and value.lower() in text.lower() and cue in text.lower():
        return value
    return None


def _remove_metadata(value: str, project: str | None, group: str | None,
                     tags: list[str], source: str | None = None) -> str:
    result = value
    if source:
        result = re.sub(re.escape(source), " ", result, flags=re.IGNORECASE)
    if project:
        result = re.sub(r"\b(?:в|по)?\s*проект[еуа]?\s+" + re.escape(project) + r"\b",
                        " ", result, flags=re.IGNORECASE)
    if group:
        result = re.sub(r"\b(?:в|по)?\s*групп[еуы]?\s+" + re.escape(group) + r"\b",
                        " ", result, flags=re.IGNORECASE)
    for tag in tags:
        result = re.sub(r"#" + re.escape(tag) + r"\b", " ", result, flags=re.IGNORECASE)
    return " ".join(result.split()).strip(" ,.;:-")


def normalize_search(route: dict, text: str) -> dict:
    project = _explicit_name(route, "project_name", text)
    group = _explicit_name(route, "group_name", text)
    query = _remove_metadata(route["query"], project, group, [])
    data = {"query": query or None, "scope": route["scope"]}
    if project:
        data["project_name"] = project
    if group:
        data["group_name"] = group
    return {
        "action": "search",
        "entity": route["entity"],
        "data": data,
        "missing_fields": [] if data["query"] else ["query"],
    }


def normalize_create(command: dict, route: dict, text: str, now: datetime) -> dict:
    if command.get("action") != "create" or not isinstance(command.get("data"), dict):
        return command
    data = command["data"]
    if route["entity"] == "reminder" and re.search(r"\bнапом\w*\b", text, flags=re.IGNORECASE):
        command["entity"] = "reminder"
    project = _explicit_name(route, "project_name", text)
    group = _explicit_name(route, "group_name", text)
    if project:
        data["project_name"] = project
    else:
        data.pop("project_name", None)
    if group:
        data["group_name"] = group
    else:
        data.pop("group_name", None)
    tags = list(dict.fromkeys(re.findall(r"#([\w-]+)", text, flags=re.UNICODE)))
    for tag in data.get("tags") or []:
        if isinstance(tag, str) and tag.lower() in text.lower() and "тег" in text.lower() and tag not in tags:
            tags.append(tag)
    if tags:
        data["tags"] = tags
    else:
        data.pop("tags", None)
    flag_patterns = {
        "pinned": r"\b(?:закреп\w*|прикреп\w*)\b",
        "private": r"\b(?:личн\w*|приватн\w*|скрыт\w*)\b",
    }
    flags = [flag for flag in dict.fromkeys(data.get("flags") or [])
             if flag in flag_patterns and re.search(flag_patterns[flag], text, flags=re.IGNORECASE)]
    if flags:
        data["flags"] = flags
    else:
        data.pop("flags", None)
    participants = [name for name in data.get("participants") or []
                    if isinstance(name, str) and len(name) >= 3 and name.lower()[:4] in text.lower()]
    if participants:
        data["participants"] = list(dict.fromkeys(participants))
    else:
        data.pop("participants", None)
    location = data.get("location")
    if isinstance(location, str) and location.lower()[:4] not in text.lower():
        data.pop("location", None)
    for field in ("query", "scope", "period_start", "period_end"):
        data.pop(field, None)
    when = data.get("when")
    relative = _relative_day(text, now)
    if relative:
        target_day = datetime.fromisoformat(relative[0]).date()
        if isinstance(data.get("due_date"), str):
            data["due_date"] = target_day.isoformat()
        for field in ("due_at", "remind_at"):
            if isinstance(data.get(field), str):
                parsed = datetime.fromisoformat(data[field])
                data[field] = parsed.replace(year=target_day.year, month=target_day.month,
                                             day=target_day.day, tzinfo=now.tzinfo).isoformat()
    if isinstance(when, dict) and isinstance(when.get("at"), str):
        when_relative = _relative_day(when.get("source") or "", now)
        if when_relative:
            parsed = datetime.fromisoformat(when["at"])
            day = datetime.fromisoformat(when_relative[0]).date()
            when["at"] = parsed.replace(year=day.year, month=day.month, day=day.day,
                                        tzinfo=now.tzinfo).isoformat()
    if command["entity"] == "reminder" and not data.get("remind_at") and isinstance(when, dict):
        data["remind_at"] = when.get("at")
    if command.get("entity") == "meeting" and isinstance(data.get("start_at"), str):
        if relative:
            parsed = datetime.fromisoformat(data["start_at"])
            day = datetime.fromisoformat(relative[0]).date()
            data["start_at"] = parsed.replace(year=day.year, month=day.month, day=day.day,
                                               tzinfo=now.tzinfo).isoformat()
    title = data.get("title")
    if isinstance(title, str):
        source = (when.get("source") if isinstance(when, dict) else None) or data.get("time_expression")
        cleaned = _remove_metadata(title, project, group, tags, source)
        if cleaned:
            data["title"] = cleaned
    return command


def _relative_day(text: str, now: datetime) -> tuple[str, str, str] | None:
    # Resolve unambiguous day words independently of the LLM's date arithmetic.
    words = (("послезавтра", 2), ("позавчера", -2), ("сегодня", 0),
             ("завтра", 1), ("вчера", -1))
    for word, days in words:
        if re.search(rf"(?<!\w){word}(?!\w)", text, flags=re.IGNORECASE):
            day = (now + timedelta(days=days)).date()
            start = datetime.combine(day, time.min, tzinfo=now.tzinfo)
            end = datetime.combine(day + timedelta(days=1), time.min, tzinfo=now.tzinfo)
            return start.isoformat(), end.isoformat(), word
    return None


def normalize_list(raw: dict, route: dict, text: str, now: datetime) -> dict:
    data = {}
    relative = _relative_day(text, now)
    if relative:
        data["period_start"], data["period_end"], data["time_expression"] = relative
    elif raw.get("period_start") and raw.get("period_end"):
        data["period_start"] = raw["period_start"]
        data["period_end"] = raw["period_end"]
        expression = raw.get("time_expression", "")
        if expression and expression.lower() in text.lower():
            data["time_expression"] = expression
    for field in ("project_name", "group_name"):
        name = _explicit_name(route, field, text)
        if name:
            data[field] = name
    return {
        "action": "list",
        "entity": route["entity"],
        "data": data,
        "missing_fields": [] if data.get("period_start") and data.get("period_end") else ["period"],
    }
