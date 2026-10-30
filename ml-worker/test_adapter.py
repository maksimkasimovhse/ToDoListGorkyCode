import unittest

from adapter import _map_command, _mutation


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


if __name__ == "__main__":
    unittest.main()
