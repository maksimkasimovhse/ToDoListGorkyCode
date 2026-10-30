package service

import (
	"encoding/json"
	"testing"
	"time"

	"gorky/backend/internal/domain"
)

func TestNormalizeDates(t *testing.T) {
	now, err := time.Parse(time.RFC3339, "2026-10-29T12:00:00+03:00")
	if err != nil {
		t.Fatal(err)
	}
	loc, err := time.LoadLocation("Europe/Moscow")
	if err != nil {
		t.Fatal(err)
	}
	m := domain.Message{ModelRequest: domain.ModelRequest{Now: now.In(loc), Timezone: "Europe/Moscow", Text: "исходная фраза"}}
	t.Run("задача без времени", func(t *testing.T) {
		item, missing, err := normalize("create_task", params{Title: "отчёт", Date: "2026-10-30"}, m)
		if err != nil || len(missing) != 0 || item.DueDate == nil || item.DueAt != nil {
			t.Fatalf("item=%+v missing=%v err=%v", item, missing, err)
		}
	})
	t.Run("прошедший час без даты означает завтра", func(t *testing.T) {
		item, missing, err := normalize("create_reminder", params{Title: "позвонить", Time: "10:00"}, m)
		if err != nil || len(missing) != 0 || item.RemindAt.Format(time.RFC3339) != "2026-10-30T10:00:00+03:00" {
			t.Fatalf("item=%+v missing=%v err=%v", item, missing, err)
		}
	})
	t.Run("напоминание не бывает на весь день", func(t *testing.T) {
		_, missing, err := normalize("create_reminder", params{Title: "позвонить", Date: "2026-10-30", AllDay: true}, m)
		if err != nil || len(missing) != 1 || missing[0] != "time" {
			t.Fatalf("missing=%v err=%v", missing, err)
		}
	})
	t.Run("период следующей недели", func(t *testing.T) {
		item, missing, err := normalize("create_task", params{Title: "билеты", Period: json.RawMessage(`"next_week"`)}, m)
		if err != nil || len(missing) != 0 || item.PeriodStart.Format(time.RFC3339) != "2026-11-02T00:00:00+03:00" || item.PeriodEnd.Format(time.RFC3339) != "2026-11-08T23:59:59+03:00" {
			t.Fatalf("item=%+v missing=%v err=%v", item, missing, err)
		}
	})
	t.Run("опорные дни недели", func(t *testing.T) {
		a := anchors(m.ModelRequest.Now)
		if a["next_weekday"].(map[string]string)["thu"] != "2026-10-29" || a["following_week_weekday"].(map[string]string)["thu"] != "2026-11-05" {
			t.Fatalf("%+v", a)
		}
	})
}
