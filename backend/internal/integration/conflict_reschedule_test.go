package integration_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"gorky/backend/internal/domain"
	"gorky/backend/internal/repository/postgres"
	"gorky/backend/internal/service"
)

func TestConflictNoAsksForNewTime(t *testing.T) {
	for _, tc := range []struct {
		name, extra string
		duration    time.Duration
	}{
		{"явный конец", `,"end_time":"16:30"`, 75 * time.Minute},
		{"явная длительность", `,"duration_min":90`, 90 * time.Minute},
		{"длительность по умолчанию", "", time.Hour},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := setup(t)
			m, _ := f.submit(t, "reschedule", "Создай встречу с клиентом")
			job := f.job(t)
			date := job.Request.Now.AddDate(0, 0, 3).Format(time.DateOnly)
			start, err := time.Parse(time.RFC3339, date+"T15:00:00+03:00")
			if err != nil {
				t.Fatal(err)
			}
			end := start.Add(time.Hour)
			_, err = service.NewItems(postgres.NewItems(f.db)).Create(f.ctx, domain.DemoUserID, domain.Item{Type: domain.ItemMeeting, Title: "с дизайнером", StartAt: &start, EndAt: &end})
			if err != nil {
				t.Fatal(err)
			}
			result := fmt.Sprintf(`{"status":"ready","actions":[{"intent":"create_meeting","params":{"title":"с клиентом","date":"%s","time":"15:15","participants":["Иван"],"location":"офис","remind_before_min":10%s}}]}`, date, tc.extra)
			f.result(t, job, result)
			waiting := f.completed(t, m.ID)
			if waiting.Response.Type != "confirm" || !strings.Contains(waiting.Response.Reply, "с дизайнером") || !strings.Contains(waiting.Response.Reply, "15:00–16:00") {
				t.Fatalf("%+v", waiting)
			}
			path := "/api/messages/" + m.ID + "/answer"
			no := map[string]any{"input_token": *waiting.InputToken, "confirmed": false}
			clarify := decodeMessage(t, f.request(t, "POST", path, no, 200))
			if clarify.Status != "awaiting_input" || clarify.Response.Type != "clarify" || clarify.Response.Reply != "Хорошо. На какое время поставить?" || clarify.InputToken == nil || *clarify.InputToken == *waiting.InputToken {
				t.Fatalf("%+v", clarify)
			}
			// Повтор «нет» не сбрасывает черновик и не создаёт новый этап.
			replay := decodeMessage(t, f.request(t, "POST", path, no, 200))
			if replay.InputToken == nil || *replay.InputToken != *clarify.InputToken {
				t.Fatal("повтор изменил окно")
			}
			var history struct {
				Pending []domain.Message `json:"pending_messages"`
			}
			if err := json.Unmarshal(f.request(t, "GET", "/api/history?session_id=reschedule", nil, 200), &history); err != nil {
				t.Fatal(err)
			}
			if len(history.Pending) != 1 || history.Pending[0].Status != "awaiting_input" {
				t.Fatalf("%+v", history)
			}
			var count int
			if err := f.db.QueryRowContext(f.ctx, "SELECT count(*) FROM items").Scan(&count); err != nil || count != 1 {
				t.Fatalf("count=%d err=%v", count, err)
			}
			f.request(t, "POST", path, map[string]any{"input_token": *clarify.InputToken, "confirmed": true}, 400)
			f.request(t, "POST", path, map[string]any{"input_token": *clarify.InputToken, "time": "25:00"}, 400)
			// Новый час тоже занят: снова предупреждение вместо записи.
			waiting = decodeMessage(t, f.request(t, "POST", path, map[string]any{"input_token": *clarify.InputToken, "time": "15:30"}, 200))
			if waiting.Status != "awaiting_confirmation" || waiting.Response.Type != "confirm" {
				t.Fatalf("%+v", waiting)
			}
			clarify = decodeMessage(t, f.request(t, "POST", path, map[string]any{"input_token": *waiting.InputToken, "confirmed": false}, 200))
			answer := map[string]any{"input_token": *clarify.InputToken, "time": "18:00"}
			done := decodeMessage(t, f.request(t, "POST", path, answer, 200))
			if done.Status != "completed" || done.Response.Type != "done" || len(done.Response.Items) != 1 {
				t.Fatalf("%+v", done)
			}
			item := done.Response.Items[0]
			if item.Title != "с клиентом" || item.StartAt.Format("15:04") != "18:00" || item.StartAt.Format(time.DateOnly) != date || item.EndAt.Sub(*item.StartAt) != tc.duration || item.Location == nil || *item.Location != "офис" || len(item.Participants) != 1 || item.SourceText != "Создай встречу с клиентом" || item.RemindAt == nil || item.StartAt.Sub(*item.RemindAt) != 10*time.Minute {
				t.Fatalf("потеряны поля: %+v", item)
			}
			f.request(t, "POST", path, answer, 200)
			if err := f.db.QueryRowContext(f.ctx, "SELECT count(*) FROM items").Scan(&count); err != nil || count != 2 {
				t.Fatalf("count=%d err=%v", count, err)
			}
			if err := f.db.QueryRowContext(f.ctx, "SELECT count(*) FROM message_outbox WHERE message_id=$1", m.ID).Scan(&count); err != nil || count != 1 {
				t.Fatalf("лишний вызов ML: count=%d err=%v", count, err)
			}
		})
	}
}

func TestCompoundConflictRescheduleKeepsOtherActions(t *testing.T) {
	f := setup(t)
	m, _ := f.submit(t, "batch-reschedule", "Две встречи и задача")
	job := f.job(t)
	date := job.Request.Now.AddDate(0, 0, 3).Format(time.DateOnly)
	result := fmt.Sprintf(`{"status":"ready","actions":[{"intent":"create_task","params":{"title":"задача"}},{"intent":"create_meeting","params":{"title":"первая","date":"%s","time":"10:00","duration_min":60}},{"intent":"create_meeting","params":{"title":"вторая","date":"%s","time":"10:30","duration_min":90}}]}`, date, date)
	f.result(t, job, result)
	waiting := f.completed(t, m.ID)
	path := "/api/messages/" + m.ID + "/answer"
	clarify := decodeMessage(t, f.request(t, "POST", path, map[string]any{"input_token": *waiting.InputToken, "confirmed": false}, 200))
	if clarify.Status != "awaiting_input" || !strings.Contains(clarify.Response.Reply, "вторая") {
		t.Fatalf("%+v", clarify)
	}
	done := decodeMessage(t, f.request(t, "POST", path, map[string]any{"input_token": *clarify.InputToken, "time": "12:00"}, 200))
	if done.Status != "completed" || len(done.Response.Items) != 3 {
		t.Fatalf("%+v", done)
	}
	items := done.Response.Items
	if items[0].Type != domain.ItemTask || items[1].StartAt.Format("15:04") != "10:00" || items[2].StartAt.Format("15:04") != "12:00" || items[2].EndAt.Sub(*items[2].StartAt) != 90*time.Minute {
		t.Fatalf("%+v", items)
	}
}
