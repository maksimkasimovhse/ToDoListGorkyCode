import io
import json
import unittest
from unittest.mock import patch

from datetime import datetime

from adapter import (DONE_STATEMENT, _parse_shift, _named_type, _fix_target, _fix_update, _hh_mm, _query_from_text,
                     _all_day, _anchors_context, _generic_record_cancellation,
                     _has_explicit_time, _history_context, _imperative_reminder, _map_command,
                     _mutation, _protect_explicit_target, _record_cancellation)
from planner_model.gigachat_contract import (_relative_day, _relative_offset,
                                              _relative_period, normalize_create,
                                              normalize_list)
from planner_model.parser import _gigachat_chat
from datetime import datetime


class AdapterTest(unittest.TestCase):
    def test_maps_meeting_to_backend_contract(self):
        result = _map_command({
            "action": "create", "entity": "meeting", "missing_fields": [],
            "data": {"title": "Встреча с Иваном", "start_at": "2026-10-31T16:00:00+03:00",
                     "end_at": "2026-10-31T17:00:00+03:00", "participants": ["Иван"]},
        })
        self.assertEqual("create_meeting", result["actions"][0]["intent"])
        self.assertEqual("16:00", result["actions"][0]["params"]["time"])
        self.assertEqual(["Иван"], result["actions"][0]["params"]["participants"])

    def test_maps_mutation_without_id(self):
        result = _mutation("complete", "task", {
            "reference": "filter", "candidate_number": 0, "target_query": "отчёт",
            "target_participant": "", "target_type": "task", "title": "", "date": "",
            "time": "", "duration_minutes": 0,
        })
        params = result["actions"][0]["params"]
        self.assertEqual("отчёт", params["target"]["query"])
        self.assertNotIn("id", params["target"])

    def test_history_context_keeps_only_last_five_turns(self):
        request = {"history": [
            {"role": "user", "text": f"реплика {index}"} for index in range(7)
        ]}
        context = _history_context(request)
        self.assertNotIn("реплика 0", context)
        self.assertNotIn("реплика 1", context)
        self.assertIn("реплика 2", context)
        self.assertIn("реплика 6", context)

    def test_all_day_meeting_does_not_keep_model_midnight_time(self):
        result = _map_command({
            "action": "create", "entity": "meeting", "missing_fields": [],
            "data": {"title": "Обсудить проект", "start_at": "2026-11-01T00:00:00+03:00",
                     "end_at": "2026-11-01T00:00:00+03:00", "participants": []},
        }, "Обсудить завтра проект, добавь на целый день")
        params = result["actions"][0]["params"]
        self.assertTrue(params["all_day"])
        self.assertNotIn("time", params)
        self.assertEqual("ready", result["status"])

    def test_meeting_without_spoken_time_requires_clarification(self):
        result = _map_command({
            "action": "create", "entity": "meeting", "missing_fields": [],
            "data": {"title": "Встреча", "start_at": "2026-11-01T00:00:00+03:00", "end_at": None},
        }, "Поставь на завтра встречу с Томасом")
        self.assertEqual("needs_clarification", result["status"])
        self.assertIn("time", result["missing"])

    def test_reminder_without_spoken_time_requires_clarification(self):
        self.assertTrue(_imperative_reminder("Напомни через два часа проверить почту"))
        self.assertFalse(_imperative_reminder("Покажи напоминания"))
        result = _map_command({
            "action": "create", "entity": "reminder", "missing_fields": [],
            "data": {"title": "Позвонить маме", "remind_at": "2026-11-08T18:04:00+03:00"},
        }, "Напомни позвонить маме")
        self.assertEqual("needs_clarification", result["status"])
        self.assertNotIn("date", result["actions"][0]["params"])
        self.assertNotIn("time", result["actions"][0]["params"])

    def test_cancel_record_is_not_cancel_dialogue(self):
        self.assertTrue(_record_cancellation("Отмени встречу"))
        self.assertFalse(_record_cancellation("Отмени текущую команду"))
        self.assertTrue(_all_day("добавь на целый день"))
        self.assertFalse(_has_explicit_time("Поставь встречу завтра"))
        self.assertTrue(_has_explicit_time("Поставь встречу завтра в 9"))
        self.assertTrue(_generic_record_cancellation("Отмени встречу"))
        self.assertFalse(_generic_record_cancellation("Отмени встречу с дизайнером"))
        protected = _protect_explicit_target("Удали встречу с дизайнером", {"reference": "focus"})
        self.assertEqual("filter", protected["reference"])

    def test_weekday_comes_from_backend_anchors(self):
        now = datetime.fromisoformat("2026-10-31T18:03:00+03:00")
        anchors = {"next_weekday": {"thu": "2026-11-05"},
                   "following_week_weekday": {"thu": "2026-11-12"}}
        date, _, _ = _relative_day("создай встречу в четверг", now, anchors)
        self.assertTrue(date.startswith("2026-11-05"))
        date, _, _ = _relative_day("создай встречу в следующий четверг", now, anchors)
        self.assertTrue(date.startswith("2026-11-12"))
        context = _anchors_context({"anchors": anchors})
        self.assertIn("2026-11-05", context)

    def test_relative_offset_and_week_period_are_deterministic(self):
        now = datetime.fromisoformat("2026-10-31T18:03:00+03:00")
        self.assertEqual("2026-10-31T20:03:00+03:00", _relative_offset("напомни через два часа", now).isoformat())
        anchors = {"this_week": ["2026-10-26", "2026-11-01"]}
        start, end, _ = _relative_period("покажи до конца недели", now, anchors)
        self.assertEqual(now.isoformat(), start)
        self.assertEqual("2026-11-02T00:00:00+03:00", end)

    def test_normalizer_overrides_model_date_arithmetic(self):
        now = datetime.fromisoformat("2026-10-31T18:03:00+03:00")
        route = {"entity": "meeting", "project_name": "", "group_name": ""}
        command = {"action": "create", "entity": "meeting", "missing_fields": [], "data": {
            "title": "Встреча с Иваном", "start_at": "2026-11-02T15:00:00+03:00",
            "end_at": "2026-11-02T16:00:00+03:00", "participants": ["Иван"],
        }}
        anchors = {"next_weekday": {"thu": "2026-11-05"}, "following_week_weekday": {"thu": "2026-11-12"}}
        normalized = normalize_create(command, route, "создай встречу в четверг с Иваном", now, anchors)
        self.assertEqual("2026-11-05T15:00:00+03:00", normalized["data"]["start_at"])
        self.assertEqual("2026-11-05T16:00:00+03:00", normalized["data"]["end_at"])

        reminder = {"action": "create", "entity": "reminder", "missing_fields": [], "data": {
            "title": "Позвонить", "remind_at": "2026-11-01T17:30:00+03:00",
        }}
        route["entity"] = "reminder"
        normalized = normalize_create(reminder, route, "напомни позвонить через два часа", now, {})
        self.assertEqual("2026-10-31T20:03:00+03:00", normalized["data"]["remind_at"])

        task = {"action": "create", "entity": "task", "missing_fields": [], "data": {"title": "Отчёт"}}
        route["entity"] = "task"
        normalized = normalize_create(task, route, "сделай отчёт до конца недели", now,
                                      {"this_week": ["2026-10-26", "2026-11-01"]})
        self.assertEqual("2026-11-01T23:59:59+03:00", normalized["data"]["period_end"])

    def test_generic_list_forces_all_types(self):
        now = datetime.fromisoformat("2026-10-31T18:03:00+03:00")
        anchors = {"tomorrow": "2026-11-01"}
        command = normalize_list({}, {"entity": "meeting", "project_name": "", "group_name": ""},
                                 "Что у меня завтра?", now, anchors)
        self.assertEqual("all", command["entity"])
        typed = normalize_list({}, {"entity": "all", "project_name": "", "group_name": ""},
                               "Какие встречи завтра?", now, anchors)
        self.assertEqual("meeting", typed["entity"])

    def test_gigachat_retries_empty_structured_output(self):
        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

        empty = Response(json.dumps({"choices": [{"finish_reason": "stop", "message": {"content": ""}}]}).encode())
        valid = Response(json.dumps({"choices": [{"finish_reason": "stop", "message": {"content": json.dumps({"ok": True})}}]}).encode())
        with patch("planner_model.parser._gigachat_access_token", return_value="token"), \
             patch("planner_model.parser._gigachat_ssl_context"), \
             patch("planner_model.parser.time.sleep"), \
             patch("planner_model.parser.urlopen", side_effect=[empty, valid]) as mocked:
            self.assertEqual({"ok": True}, _gigachat_chat([{"role": "user", "content": "test"}], {}, 2))
            self.assertEqual(2, mocked.call_count)

    def test_reminder_with_time_only_uses_today(self):
        result = _map_command({"action": "create", "entity": "reminder", "missing_fields": [],
                               "data": {"title": "почитать", "remind_at": "2026-10-31T21:17:00+03:00"}},
                              "Создай напоминание на 21:17 почитать")
        self.assertEqual("ready", result["status"])
        params = result["actions"][0]["params"]
        self.assertEqual("21:17", params["time"])
        self.assertNotIn("date", params)

    def test_task_without_deadline_needs_no_question(self):
        result = _map_command({"action": "create", "entity": "task", "missing_fields": ["due"],
                               "data": {"title": "почитать книгу"}}, "создай задачу почитать книгу")
        self.assertEqual("ready", result["status"])
        self.assertEqual([], result["missing"])

    def test_repair_adds_timezone_and_asks_missing_time(self):
        from planner_model.parser import _repair_command
        from planner_model.contract import validate_command
        now = datetime.fromisoformat("2026-10-31T21:00:00+03:00")
        command = {"action": "create", "entity": "reminder", "missing_fields": [],
                   "data": {"title": "почитать", "remind_at": "2026-10-31T21:17:00"}}
        fixed = _repair_command(command, now)
        self.assertEqual("2026-10-31T21:17:00+03:00", fixed["data"]["remind_at"])
        validate_command(fixed)
        silent = _repair_command({"action": "create", "entity": "reminder", "missing_fields": [],
                                 "data": {"title": "позвонить маме"}}, now)
        self.assertEqual(["remind_at"], silent["missing_fields"])
        validate_command(silent)
        validate_command({"action": "create", "entity": "task", "missing_fields": [], "data": {"title": "почитать"}})

    def test_target_comes_from_user_words(self):
        self.assertEqual("дизайнер", _query_from_text("Удали встречу с дизайнером"))
        self.assertEqual("иван", _query_from_text("Я позвонил Ивану"))
        self.assertEqual("отчёт", _query_from_text("Отметь задачу про отчёт выполненной"))
        self.assertEqual("команд", _query_from_text("Перенеси встречу с командой на послезавтра"))
        self.assertEqual("", _query_from_text("удали"))

    def test_candidate_without_list_becomes_filter(self):
        raw = {"reference": "candidate", "candidate_number": 1, "target_query": "", "target_participant": "",
               "target_type": "task"}
        fixed = _fix_target("Удали задачу завтра почитать книгу", raw, {})
        self.assertEqual("filter", fixed["reference"])
        self.assertEqual("почитат", fixed["target_query"])
        kept = _fix_target("первую", {**raw, "candidate_number": 1}, {"candidates": [{"id": "1"}]})
        self.assertEqual("candidate", kept["reference"])

    def test_type_named_in_text_wins(self):
        self.assertEqual("task", _named_type("Удали задачу завтра почитать книгу"))
        self.assertEqual("meeting", _named_type("Удали встречу с дизайнером"))
        self.assertEqual("", _named_type("Я позвонил Ивану"))
        self.assertEqual("", _named_type("перенеси задачу на встречу"))
        fixed = _fix_target("Удали задачу почитать книгу", {"reference": "filter", "target_type": "all"}, {})
        self.assertEqual("task", fixed["target_type"])

    def test_named_target_beats_focus(self):
        raw = {"reference": "focus", "target_query": "", "target_participant": ""}
        self.assertEqual("filter", _fix_target("Перенеси встречу с командой на послезавтра", raw, {"focus": {"id": "1"}})["reference"])
        self.assertEqual("focus", _fix_target("Перенеси на послезавтра", raw, {"focus": {"id": "1"}})["reference"])
        self.assertEqual("focus", _fix_target("сдвинь её на час позже", raw, {"focus": {"id": "1"}})["reference"])

    def test_shift_is_sent_as_minutes(self):
        self.assertEqual(60, _parse_shift("А сдвинь её на час позже"))
        self.assertEqual(-30, _parse_shift("на 30 минут раньше"))
        self.assertEqual(-30, _parse_shift("на полчаса раньше"))
        self.assertEqual(2880, _parse_shift("на два дня вперёд"))
        self.assertIsNone(_parse_shift("перенеси на завтра"))
        fixed = _fix_update("сдвинь на час позже", {"date": "2026-11-01", "time": ""}, {"now": "2026-10-31T21:00:00+03:00"})
        self.assertEqual((60, "", ""), (fixed["shift_min"], fixed["date"], fixed["time"]))
        result = _mutation("update", "meeting", {"reference": "focus", "title": "", "date": "", "time": "",
                                                 "duration_minutes": 0, "shift_min": 60})
        self.assertEqual({"shift_min": 60}, result["actions"][0]["params"]["changes"])

    def test_parse_falls_back_to_no_history(self):
        import adapter
        calls = []

        def fake(request, text):
            calls.append(bool(request.get("history")))
            if request.get("history"):
                raise adapter.ModelError("GigaChat вернул пустой JSON по заданной схеме")
            return {"status": "ready", "actions": [], "missing": [], "question": None, "options": []}
        with patch.object(adapter, "_parse_single_once", fake):
            self.assertEqual("ready", adapter._parse_single({"history": [{"role": "user", "text": "привет"}]}, "x")["status"])
            self.assertEqual([True, False], calls)
            with self.assertRaises(adapter.ModelError):
                with patch.object(adapter, "_parse_single_once", side_effect=adapter.ModelError("нет")):
                    adapter._parse_single({}, "x")

    def test_complete_with_meeting_type_from_context(self):
        raw = {"reference": "filter", "target_query": "иван", "target_participant": "", "target_type": "meeting"}
        self.assertEqual(["task", "reminder"], _mutation("complete", "meeting", raw)["actions"][0]["params"]["target"]["types"])

    def test_task_date_without_time_has_no_midnight(self):
        result = _map_command({"action": "create", "entity": "task", "missing_fields": [],
                               "data": {"title": "отправить отчёт", "due_at": "2026-11-06T00:00:00+03:00"}},
                              "В пятницу нужно отправить отчёт")
        self.assertEqual({"title": "отправить отчёт", "date": "2026-11-06"}, result["actions"][0]["params"])
        timed = _map_command({"action": "create", "entity": "task", "missing_fields": [],
                              "data": {"title": "отправить отчёт", "due_at": "2026-11-06T15:00:00+03:00"}},
                             "В пятницу в 15:00 нужно отправить отчёт")
        self.assertEqual("15:00", timed["actions"][0]["params"]["time"])

    def test_complete_never_targets_meetings(self):
        raw = {"reference": "filter", "target_query": "иван", "target_participant": "", "target_type": "all"}
        params = _mutation("complete", "all", raw)["actions"][0]["params"]
        self.assertEqual(["task", "reminder"], params["target"]["types"])

    def test_named_target_replaces_role_participant(self):
        raw = {"reference": "filter", "target_query": "встреча с дизайнером", "target_participant": "дизайнер"}
        fixed = _fix_target("Удали встречу с дизайнером", raw, {})
        self.assertEqual(("дизайнер", ""), (fixed["target_query"], fixed["target_participant"]))

    def test_bare_command_uses_selected_item(self):
        raw = {"reference": "filter", "target_query": "", "target_participant": ""}
        self.assertEqual("focus", _fix_target("удали", raw, {"focus": {"id": "1"}})["reference"])

    def test_done_statement_and_update_dates(self):
        self.assertTrue(DONE_STATEMENT.search("Я позвонил Ивану"))
        self.assertFalse(DONE_STATEMENT.search("Какая погода?"))
        request = {"now": "2026-10-31T21:00:00+03:00", "anchors": {"tomorrow": "2026-11-01", "day_after_tomorrow": "2026-11-02"}}
        fixed = _fix_update("Перенеси встречу на послезавтра", {"date": "2026-11-05", "time": "12:00:00+03:00"}, request)
        self.assertEqual(("2026-11-02", ""), (fixed["date"], fixed["time"]))
        timed = _fix_update("перенеси на завтра в 15:30", {"date": "", "time": "15:30:00"}, request)
        self.assertEqual(("2026-11-01", "15:30"), (timed["date"], timed["time"]))
        self.assertEqual("09:05", _hh_mm("9:05:00+03:00"))


if __name__ == "__main__":
    unittest.main()
