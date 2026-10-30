package integration_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorky/backend/internal/domain"
	"gorky/backend/internal/repository/postgres"
	"gorky/backend/internal/service"
)

func TestManualMeetingConflicts(t *testing.T) {
	f := setup(t)
	create := func(title, start, end string, allow bool, code int) domain.Item {
		t.Helper()
		raw := f.request(t, "POST", "/api/items", map[string]any{"type": "meeting", "title": title, "start_at": start, "end_at": end, "allow_conflicts": allow}, code)
		var item domain.Item
		if code == 201 {
			if err := json.Unmarshal(raw, &item); err != nil {
				t.Fatal(err)
			}
		} else {
			var body struct {
				Error struct {
					Code      string
					Conflicts []domain.Item
				}
			}
			if err := json.Unmarshal(raw, &body); err != nil {
				t.Fatal(err)
			}
			if body.Error.Code != "meeting_conflict" || len(body.Error.Conflicts) == 0 {
				t.Fatalf("%s", raw)
			}
		}
		return item
	}
	base := create("основная", "2030-01-02T10:00:00+03:00", "2030-01-02T11:00:00+03:00", false, 201)
	for _, span := range [][2]string{
		{"2030-01-02T10:00:00+03:00", "2030-01-02T11:00:00+03:00"},
		{"2030-01-02T10:15:00+03:00", "2030-01-02T10:30:00+03:00"},
		{"2030-01-02T09:30:00+03:00", "2030-01-02T11:30:00+03:00"},
		{"2030-01-02T07:30:00Z", "2030-01-02T08:30:00Z"},
	} {
		create("пересечение", span[0], span[1], false, 409)
	}
	create("до", "2030-01-02T09:00:00+03:00", "2030-01-02T10:00:00+03:00", false, 201)
	after := create("после", "2030-01-02T11:00:00+03:00", "2030-01-02T12:00:00+03:00", false, 201)
	path := "/api/items/" + after.ID
	// Собственная встреча исключается при переносе внутри её прежнего интервала.
	f.request(t, "PATCH", "/api/items/"+base.ID, map[string]any{"start_at": "2030-01-02T10:15:00+03:00", "end_at": "2030-01-02T10:45:00+03:00"}, 200)
	f.request(t, "PATCH", "/api/items/"+base.ID, map[string]any{"start_at": "2030-01-02T10:00:00+03:00", "end_at": "2030-01-02T11:00:00+03:00"}, 200)
	f.request(t, "PATCH", "/api/items/"+base.ID, map[string]any{"title": "переименованная"}, 200)
	f.request(t, "PATCH", path, map[string]any{"start_at": "2030-01-02T10:30:00+03:00", "end_at": "2030-01-02T11:30:00+03:00"}, 409)
	var unchanged domain.Item
	if err := json.Unmarshal(f.request(t, "GET", path, nil, 200), &unchanged); err != nil {
		t.Fatal(err)
	}
	if !unchanged.StartAt.Equal(*after.StartAt) {
		t.Fatal("перенос сохранился до подтверждения")
	}
	f.request(t, "PATCH", path, map[string]any{"start_at": "2030-01-02T10:30:00+03:00", "end_at": "2030-01-02T11:30:00+03:00", "allow_conflicts": true}, 200)
	f.request(t, "PATCH", path, map[string]any{"title": "разрешённое пересечение"}, 200)
	f.request(t, "PATCH", path, map[string]any{"status": "cancelled"}, 200)
	f.request(t, "PATCH", path, map[string]any{"status": "scheduled"}, 409)
	f.request(t, "PATCH", path, map[string]any{"status": "scheduled", "allow_conflicts": true}, 200)
	f.request(t, "PATCH", path, map[string]any{"status": "cancelled"}, 200)
	// Отменённая встреча не мешает создать новую в её свободной части интервала.
	free := create("свободно", "2030-01-02T11:00:00+03:00", "2030-01-02T12:00:00+03:00", false, 201)
	f.request(t, "DELETE", "/api/items/"+free.ID, nil, 200)
	create("после удаления", "2030-01-02T11:00:00+03:00", "2030-01-02T12:00:00+03:00", false, 201)
	create("явное подтверждение", "2030-01-02T10:00:00+03:00", "2030-01-02T11:00:00+03:00", true, 201)
	// Встречи другого пользователя не раскрываются и не блокируют расписание.
	svc := service.NewItems(postgres.NewItems(f.db))
	_, err := svc.Create(f.ctx, uuid.NewString(), domain.Item{Type: domain.ItemMeeting, Title: "другой пользователь", StartAt: base.StartAt, EndAt: base.EndAt})
	if err != nil {
		t.Fatal(err)
	}
	// Встреча на весь день также проверяется по точным границам интервала.
	f.request(t, "POST", "/api/items", map[string]any{"type": "meeting", "title": "весь день", "start_at": "2030-01-02T00:00:00+03:00", "end_at": "2030-01-03T00:00:00+03:00", "all_day": true}, 409)
}

func TestConcurrentMeetingConflicts(t *testing.T) {
	f := setup(t)
	svc := service.NewItems(postgres.NewItems(f.db))
	start := time.Date(2030, 1, 2, 10, 0, 0, 0, time.UTC)
	end := start.Add(time.Hour)
	gate := make(chan struct{})
	results := make(chan error, 8)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-gate
			_, err := svc.Create(f.ctx, domain.DemoUserID, domain.Item{Type: domain.ItemMeeting, Title: fmt.Sprintf("параллельная %d", i), StartAt: &start, EndAt: &end})
			results <- err
		}(i)
	}
	close(gate)
	wg.Wait()
	close(results)
	saved, rejected := 0, 0
	for err := range results {
		var conflict *service.MeetingConflictError
		if err == nil {
			saved++
		} else if errors.As(err, &conflict) {
			rejected++
		} else {
			t.Fatal(err)
		}
	}
	if saved != 1 || rejected != 7 {
		t.Fatalf("saved=%d rejected=%d", saved, rejected)
	}
}

func TestMeetingConflictDialogue(t *testing.T) {
	f := setup(t)
	svc := service.NewItems(postgres.NewItems(f.db))
	m, _ := f.submit(t, "conflict-dialogue", "Создай встречу")
	job := f.job(t)
	date := job.Request.Now.AddDate(0, 0, 3).Format(time.DateOnly)
	start, err := time.Parse(time.RFC3339, date+"T17:00:00+03:00")
	if err != nil {
		t.Fatal(err)
	}
	end := start.Add(time.Hour)
	if _, err := svc.Create(f.ctx, domain.DemoUserID, domain.Item{Type: domain.ItemMeeting, Title: "существующая", StartAt: &start, EndAt: &end}); err != nil {
		t.Fatal(err)
	}
	result := fmt.Sprintf(`{"status":"ready","actions":[{"intent":"create_meeting","params":{"title":"новая","date":"%s","time":"17:30","duration_min":60}}]}`, date)
	f.result(t, job, result)
	waiting := f.completed(t, m.ID)
	if waiting.Status != "awaiting_confirmation" || waiting.Response.Type != "confirm" || len(waiting.Response.Items) != 1 || waiting.InputToken == nil {
		t.Fatalf("%+v", waiting)
	}
	firstToken := *waiting.InputToken
	// Новый конфликт после предупреждения требует нового подтверждения.
	nextStart, nextEnd := end, end.Add(time.Hour)
	if _, err := svc.Create(f.ctx, domain.DemoUserID, domain.Item{Type: domain.ItemMeeting, Title: "появившаяся позже", StartAt: &nextStart, EndAt: &nextEnd}); err != nil {
		t.Fatal(err)
	}
	path := "/api/messages/" + m.ID + "/answer"
	waiting = decodeMessage(t, f.request(t, "POST", path, map[string]any{"input_token": firstToken, "confirmed": true}, 200))
	if waiting.Status != "awaiting_confirmation" || waiting.InputToken == nil || *waiting.InputToken == firstToken || len(waiting.Response.Items) != 2 {
		t.Fatalf("%+v", waiting)
	}
	answer := map[string]any{"input_token": *waiting.InputToken, "confirmed": true}
	done := decodeMessage(t, f.request(t, "POST", path, answer, 200))
	if done.Status != "completed" || done.Response.Type != "done" || len(done.Response.Items) != 1 {
		t.Fatalf("%+v", done)
	}
	f.request(t, "POST", path, answer, 200)
	var count int
	if err := f.db.QueryRowContext(f.ctx, "SELECT count(*) FROM items WHERE title='новая'").Scan(&count); err != nil || count != 1 {
		t.Fatalf("count=%d err=%v", count, err)
	}
	m, _ = f.submit(t, "conflict-cancel", "Создай ещё встречу")
	job = f.job(t)
	f.result(t, job, strings.Replace(result, "новая", "другая встреча", 1))
	waiting = f.completed(t, m.ID)
	clarify := decodeMessage(t, f.request(t, "POST", "/api/messages/"+m.ID+"/answer", map[string]any{"input_token": *waiting.InputToken, "confirmed": false}, 200))
	if clarify.Status != "awaiting_input" || clarify.Response.Type != "clarify" {
		t.Fatalf("%+v", clarify)
	}
	cancelled := decodeMessage(t, f.request(t, "POST", "/api/messages/"+m.ID+"/cancel", nil, 200))
	if cancelled.Status != "cancelled" {
		t.Fatalf("%+v", cancelled)
	}
	if err := f.db.QueryRowContext(f.ctx, "SELECT count(*) FROM items").Scan(&count); err != nil || count != 3 {
		t.Fatalf("cancel count=%d err=%v", count, err)
	}
}

func TestConflictsWithinCompoundCommand(t *testing.T) {
	f := setup(t)
	m, _ := f.submit(t, "batch-conflict", "Две встречи и задача")
	job := f.job(t)
	date := job.Request.Now.AddDate(0, 0, 3).Format(time.DateOnly)
	result := fmt.Sprintf(`{"status":"ready","actions":[{"intent":"create_task","params":{"title":"задача"}},{"intent":"create_meeting","params":{"title":"первая","date":"%s","time":"10:00","duration_min":60}},{"intent":"create_meeting","params":{"title":"вторая","date":"%s","time":"10:30","duration_min":60}}]}`, date, date)
	f.result(t, job, strings.Replace(result, "новая", "другая встреча", 1))
	waiting := f.completed(t, m.ID)
	if waiting.Status != "awaiting_confirmation" || waiting.InputToken == nil {
		t.Fatalf("%+v", waiting)
	}
	var count int
	if err := f.db.QueryRowContext(f.ctx, "SELECT count(*) FROM items").Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial write: %d %v", count, err)
	}
	done := decodeMessage(t, f.request(t, "POST", "/api/messages/"+m.ID+"/answer", map[string]any{"input_token": *waiting.InputToken, "confirmed": true}, 200))
	if done.Status != "completed" || len(done.Response.Items) != 3 {
		t.Fatalf("%+v", done)
	}
}
