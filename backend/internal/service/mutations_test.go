package service

import (
	"encoding/json"
	"gorky/backend/internal/domain"
	"testing"
	"time"
)

func TestChoiceNumber(t *testing.T) {
	for text, want := range map[string]int{"2": 2, "номер два": 2, "Вторую встречу, пожалуйста": 2, "выбираю третью задачу": 3, "четвёртую": 4, "шестнадцатую": 16, "20": 20, "удали всё": 0, "Иван": 0, "вторую и третью": 0} {
		if got := choiceNumber(text); got != want {
			t.Errorf("%q: got %d want %d", text, got, want)
		}
	}
}

func TestMutationChangesPreserveDurationAndTimezone(t *testing.T) {
	start, err := time.Parse(time.RFC3339, "2030-01-01T23:30:00Z")
	if err != nil {
		t.Fatal(err)
	}
	end := start.Add(90 * time.Minute)
	remind := start.Add(-15 * time.Minute)
	item := domain.Item{Type: domain.ItemMeeting, Title: "встреча", StartAt: &start, EndAt: &end, RemindAt: &remind, Participants: []string{"Иван"}}
	date := "2030-01-05"
	clock := "16:00"
	patch, err := changesPatch(item, itemChanges{Date: &date, Time: &clock, ParticipantsAdd: []string{"Анна"}}, "Asia/Tokyo")
	if err != nil {
		t.Fatal(err)
	}
	updated, err := itemWithPatch(item, patch)
	if err != nil {
		t.Fatal(err)
	}
	loc, err := time.LoadLocation("Asia/Tokyo")
	if err != nil {
		t.Fatal(err)
	}
	if updated.StartAt.In(loc).Format("2006-01-02 15:04") != "2030-01-05 16:00" || updated.EndAt.Sub(*updated.StartAt) != 90*time.Minute || updated.StartAt.Sub(*updated.RemindAt) != 15*time.Minute || len(updated.Participants) != 2 {
		t.Fatalf("%+v", updated)
	}
	if !item.StartAt.Equal(start) || len(item.Participants) != 1 {
		t.Fatal("исходная запись изменилась при построении patch")
	}
	shift := 60
	shifted, err := changesPatch(item, itemChanges{ShiftMin: &shift}, "Europe/Moscow")
	if err != nil {
		t.Fatal(err)
	}
	updated, err = itemWithPatch(item, shifted)
	if err != nil {
		t.Fatal(err)
	}
	if !updated.StartAt.Equal(start.Add(time.Hour)) {
		t.Fatalf("%+v", updated)
	}
}

func TestMutationChangesRejectUnsafeFields(t *testing.T) {
	for _, raw := range []string{`{}`, `null`, `{"title":null}`, `{"user_id":"fake"}`, `{"type":"meeting"}`, `{"allow_conflicts":true}`} {
		if _, err := decodeChanges(json.RawMessage(raw)); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
}
