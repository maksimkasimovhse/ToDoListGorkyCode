import unittest

from adapter import _all_day, _anchors_context, _has_explicit_time, _history_context, _map_command, _mutation, _record_cancellation
from planner_model.gigachat_contract import _relative_day
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

    def test_cancel_record_is_not_cancel_dialogue(self):
        self.assertTrue(_record_cancellation("Отмени встречу"))
        self.assertFalse(_record_cancellation("Отмени текущую команду"))
        self.assertTrue(_all_day("добавь на целый день"))
        self.assertFalse(_has_explicit_time("Поставь встречу завтра"))
        self.assertTrue(_has_explicit_time("Поставь встречу завтра в 9"))

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


if __name__ == "__main__":
    unittest.main()
