import io
import json
import unittest
from unittest.mock import patch

from adapter import (_all_day, _anchors_context, _generic_record_cancellation,
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


if __name__ == "__main__":
    unittest.main()
