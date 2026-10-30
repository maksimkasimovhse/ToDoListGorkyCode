package integration_test

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorky/backend/internal/domain"
	"gorky/backend/internal/repository/postgres"
	"gorky/backend/internal/service"
)

func mutationRequest(t *testing.T, f *fixture, session, intent string, params any) domain.Message {
	t.Helper()
	m, _ := f.submit(t, session, "Измени запись")
	job := f.job(t)
	raw, err := json.Marshal(map[string]any{"status": "ready", "actions": []any{map[string]any{"intent": intent, "params": params}}})
	if err != nil {
		t.Fatal(err)
	}
	f.result(t, job, string(raw))
	return f.completed(t, m.ID)
}
func seedChoiceTask(t *testing.T, f *fixture, title, date string) domain.Item {
	t.Helper()
	var due *domain.Date
	if date != "" {
		d := domain.Date(date)
		due = &d
	}
	item, err := service.NewItems(postgres.NewItems(f.db)).Create(f.ctx, domain.DemoUserID, domain.Item{Type: domain.ItemTask, Title: title, DueDate: due})
	if err != nil {
		t.Fatal(err)
	}
	return item
}
func readChoiceItem(t *testing.T, f *fixture, id string) domain.Item {
	t.Helper()
	var item domain.Item
	if err := json.Unmarshal(f.request(t, "GET", "/api/items/"+id, nil, 200), &item); err != nil {
		t.Fatal(err)
	}
	return item
}

func TestMutationChoiceAndIdempotency(t *testing.T) {
	f := setup(t)
	first := seedChoiceTask(t, f, "позвонить Ивану", "2030-01-01")
	second := seedChoiceTask(t, f, "написать Ивану", "2030-01-02")
	waiting := mutationRequest(t, f, "choice", "update", map[string]any{"target": map[string]any{"ref": "filter", "query": "Иван", "types": []string{"task"}}, "changes": map[string]any{"title": "выбранная задача"}})
	if waiting.Status != "awaiting_input" || waiting.Response.Type != "choose" || len(waiting.Response.Items) != 2 || len(waiting.Response.Options) != 2 || waiting.InputToken == nil {
		t.Fatalf("%+v", waiting)
	}
	if readChoiceItem(t, f, first.ID).Title != first.Title || readChoiceItem(t, f, second.ID).Title != second.Title {
		t.Fatal("изменения до выбора")
	}
	path := "/api/messages/" + waiting.ID + "/answer"
	for _, answer := range []map[string]any{
		{"option_id": uuid.NewString()}, {"text": "99"}, {"text": "Иван"}, {"confirmed": true}, {"text": "вторую", "title": "лишнее"},
	} {
		answer["input_token"] = *waiting.InputToken
		f.request(t, "POST", path, answer, 400)
	}
	f.request(t, "POST", "/api/message", map[string]any{"client_message_id": uuid.NewString(), "session_id": "choice", "text": "Новый запрос", "input": "voice"}, 409)
	var history struct {
		Pending []domain.Message `json:"pending_messages"`
	}
	if err := json.Unmarshal(f.request(t, "GET", "/api/history?session_id=choice", nil, 200), &history); err != nil {
		t.Fatal(err)
	}
	if len(history.Pending) != 1 || history.Pending[0].Response.Type != "choose" {
		t.Fatalf("%+v", history)
	}
	answer := map[string]any{"input_token": *waiting.InputToken, "text": "вторую"}
	done := decodeMessage(t, f.request(t, "POST", path, answer, 200))
	if done.Status != "completed" || done.Response.Type != "done" || len(done.Response.Items) != 1 || done.Response.Items[0].ID != second.ID {
		t.Fatalf("%+v", done)
	}
	if readChoiceItem(t, f, first.ID).Title != first.Title || readChoiceItem(t, f, second.ID).Title != "выбранная задача" {
		t.Fatal("изменена не та запись")
	}
	f.request(t, "POST", path, answer, 200)
	f.request(t, "POST", path, map[string]any{"input_token": *waiting.InputToken, "text": "первую"}, 409)
	var calls int
	if err := f.db.QueryRowContext(f.ctx, "SELECT count(*) FROM message_outbox WHERE message_id=$1", waiting.ID).Scan(&calls); err != nil || calls != 1 {
		t.Fatalf("ML calls=%d err=%v", calls, err)
	}
}

func TestMutationUniqueMissingAndFocus(t *testing.T) {
	f := setup(t)
	item := seedChoiceTask(t, f, "единственная", "2030-01-01")
	done := mutationRequest(t, f, "unique", "update", map[string]any{"target": map[string]any{"ref": "filter", "query": "единственная"}, "changes": map[string]any{"date": "2030-02-02", "time": "16:00"}})
	if done.Response.Type != "done" || done.Response.Items[0].ID != item.ID || done.Response.Items[0].DueAt == nil {
		t.Fatalf("%+v", done)
	}
	text := "Отметь её выполненной"
	req := domain.MessageRequest{ClientMessageID: uuid.NewString(), SessionID: "unique", Text: &text, Input: "voice", Timezone: "Europe/Moscow"}
	req.Context.SelectedItemID = &item.ID
	accepted := decodeMessage(t, f.request(t, "POST", "/api/message", req, 202))
	job := f.job(t)
	f.result(t, job, `{"status":"ready","actions":[{"intent":"complete","params":{"target":{"ref":"focus"},"done":true}}]}`)
	result := f.completed(t, accepted.ID)
	if result.Response.Type != "done" || result.Response.Items[0].Status != domain.StatusDone {
		t.Fatalf("%+v", result)
	}
	missing := mutationRequest(t, f, "missing", "update", map[string]any{"target": map[string]any{"ref": "filter", "query": "несуществующая"}, "changes": map[string]any{"title": "не применять"}})
	if missing.Response.Type != "info" || readChoiceItem(t, f, item.ID).Title != item.Title {
		t.Fatalf("%+v", missing)
	}
	invalid := mutationRequest(t, f, "invalid", "update", map[string]any{"target": map[string]any{"ref": "filter"}, "changes": map[string]any{"title": "не применять"}})
	if invalid.Response.Type != "error" {
		t.Fatalf("%+v", invalid)
	}
}

func TestChoiceStaleDeletedAndForeign(t *testing.T) {
	f := setup(t)
	first := seedChoiceTask(t, f, "кандидат один", "2030-01-01")
	second := seedChoiceTask(t, f, "кандидат два", "2030-01-02")
	svc := service.NewItems(postgres.NewItems(f.db))
	waiting := mutationRequest(t, f, "stale-choice", "complete", map[string]any{"target": map[string]any{"ref": "filter", "query": "кандидат"}, "done": true})
	foreign := uuid.NewString()
	answer := domain.MessageAnswer{InputToken: *waiting.InputToken, OptionID: &first.ID}
	if _, err := f.messages.Answer(f.ctx, foreign, waiting.ID, answer); err == nil {
		t.Fatal("чужой ответ принят")
	}
	raw := json.RawMessage(`"переименованная"`)
	if _, err := svc.Update(f.ctx, domain.DemoUserID, first.ID, map[string]json.RawMessage{"title": raw}); err != nil {
		t.Fatal(err)
	}
	path := "/api/messages/" + waiting.ID + "/answer"
	refreshed := decodeMessage(t, f.request(t, "POST", path, map[string]any{"input_token": *waiting.InputToken, "option_id": first.ID}, 200))
	if refreshed.Response.Type != "choose" || *refreshed.InputToken == *waiting.InputToken || readChoiceItem(t, f, first.ID).Status != domain.StatusOpen {
		t.Fatalf("%+v", refreshed)
	}
	if err := svc.Delete(f.ctx, domain.DemoUserID, second.ID); err != nil {
		t.Fatal(err)
	}
	refreshed = decodeMessage(t, f.request(t, "POST", path, map[string]any{"input_token": *refreshed.InputToken, "option_id": second.ID}, 200))
	if refreshed.Response.Type != "choose" || len(refreshed.Response.Items) != 1 {
		t.Fatalf("%+v", refreshed)
	}
	completed := decodeMessage(t, f.request(t, "POST", path, map[string]any{"input_token": *refreshed.InputToken, "option_id": first.ID}, 200))
	if completed.Response.Type != "done" || completed.Response.Items[0].Status != domain.StatusDone {
		t.Fatalf("%+v", completed)
	}
}

func TestDeleteChoiceRequiresConfirmation(t *testing.T) {
	f := setup(t)
	first := seedChoiceTask(t, f, "удаляемая один", "")
	seedChoiceTask(t, f, "удаляемая два", "")
	waiting := mutationRequest(t, f, "delete-choice", "delete", map[string]any{"target": map[string]any{"ref": "filter", "query": "удаляемая"}})
	path := "/api/messages/" + waiting.ID + "/answer"
	confirm := decodeMessage(t, f.request(t, "POST", path, map[string]any{"input_token": *waiting.InputToken, "option_id": first.ID}, 200))
	if confirm.Status != "awaiting_confirmation" || confirm.Response.Type != "confirm" {
		t.Fatalf("%+v", confirm)
	}
	readChoiceItem(t, f, first.ID)
	answer := map[string]any{"input_token": *confirm.InputToken, "confirmed": true}
	done := decodeMessage(t, f.request(t, "POST", path, answer, 200))
	if done.Response.Type != "done" {
		t.Fatalf("%+v", done)
	}
	f.request(t, "GET", "/api/items/"+first.ID, nil, 404)
	f.request(t, "POST", path, answer, 200)
}

func TestChosenMeetingMoveConflictsAndNewTime(t *testing.T) {
	f := setup(t)
	svc := service.NewItems(postgres.NewItems(f.db))
	create := func(title, clock string, duration int) domain.Item {
		t.Helper()
		start, err := time.Parse(time.RFC3339, "2030-01-02T"+clock+":00+03:00")
		if err != nil {
			t.Fatal(err)
		}
		end := start.Add(time.Duration(duration) * time.Minute)
		item, err := svc.Create(f.ctx, domain.DemoUserID, domain.Item{Type: domain.ItemMeeting, Title: title, StartAt: &start, EndAt: &end, Participants: []string{"Иван"}})
		if err != nil {
			t.Fatal(err)
		}
		return item
	}
	first := create("созвон Иван", "10:00", 60)
	second := create("план Иван", "12:00", 90)
	create("занято", "14:00", 60)
	waiting := mutationRequest(t, f, "move-choice", "update", map[string]any{"target": map[string]any{"ref": "filter", "query": "Иван", "types": []string{"meeting"}}, "changes": map[string]any{"time": "14:00"}})
	path := "/api/messages/" + waiting.ID + "/answer"
	confirm := decodeMessage(t, f.request(t, "POST", path, map[string]any{"input_token": *waiting.InputToken, "text": "вторая"}, 200))
	if confirm.Response.Type != "confirm" {
		t.Fatalf("%+v", confirm)
	}
	if readChoiceItem(t, f, second.ID).StartAt.Format("15:04") != "12:00" {
		t.Fatal("перенос без подтверждения")
	}
	clarify := decodeMessage(t, f.request(t, "POST", path, map[string]any{"input_token": *confirm.InputToken, "confirmed": false}, 200))
	if clarify.Response.Type != "clarify" {
		t.Fatalf("%+v", clarify)
	}
	done := decodeMessage(t, f.request(t, "POST", path, map[string]any{"input_token": *clarify.InputToken, "time": "16:00"}, 200))
	if done.Response.Type != "done" || done.Response.Items[0].ID != second.ID || done.Response.Items[0].EndAt.Sub(*done.Response.Items[0].StartAt) != 90*time.Minute || done.Response.Items[0].StartAt.Format("15:04") != "16:00" {
		t.Fatalf("%+v", done)
	}
	if readChoiceItem(t, f, first.ID).StartAt.Format("15:04") != "10:00" {
		t.Fatal("перенесена другая встреча")
	}
}

func TestChoiceCancelAndExpiry(t *testing.T) {
	for _, expire := range []bool{false, true} {
		t.Run(fmt.Sprint(expire), func(t *testing.T) {
			f := setup(t)
			first := seedChoiceTask(t, f, "выбор один", "")
			seedChoiceTask(t, f, "выбор два", "")
			waiting := mutationRequest(t, f, "choice-expiry", "complete", map[string]any{"target": map[string]any{"ref": "filter", "query": "выбор"}, "done": true})
			if expire {
				if _, err := f.db.ExecContext(f.ctx, "UPDATE messages SET deadline_at=now()-interval '1 second' WHERE id=$1", waiting.ID); err != nil {
					t.Fatal(err)
				}
				result := decodeMessage(t, f.request(t, "POST", "/api/messages/"+waiting.ID+"/answer", map[string]any{"input_token": *waiting.InputToken, "text": "первую"}, 200))
				if result.Status != "failed" {
					t.Fatalf("%+v", result)
				}
			} else {
				result := decodeMessage(t, f.request(t, "POST", "/api/messages/"+waiting.ID+"/cancel", nil, 200))
				if result.Status != "cancelled" {
					t.Fatalf("%+v", result)
				}
			}
			if readChoiceItem(t, f, first.ID).Status != domain.StatusOpen {
				t.Fatal("изменено после отмены/истечения")
			}
		})
	}
}

func TestMutationCandidateComesFromShownSearch(t *testing.T) {
	f := setup(t)
	first := seedChoiceTask(t, f, "список один", "2030-01-01")
	second := seedChoiceTask(t, f, "список два", "2030-01-02")
	found := mutationRequest(t, f, "candidate-ref", "search", map[string]any{"query": "список"})
	if found.Response.Type != "results" || len(found.Response.Items) != 2 {
		t.Fatalf("%+v", found)
	}
	done := mutationRequest(t, f, "candidate-ref", "complete", map[string]any{"target": map[string]any{"ref": "candidate", "numbers": []int{2}}, "done": true})
	if done.Response.Type != "done" || len(done.Response.Items) != 1 || done.Response.Items[0].ID != second.ID {
		t.Fatalf("%+v", done)
	}
	if readChoiceItem(t, f, first.ID).Status != domain.StatusOpen {
		t.Fatal("изменена первая запись")
	}
	reopened := mutationRequest(t, f, "candidate-ref", "complete", map[string]any{"target": map[string]any{"ref": "focus"}, "done": false})
	if reopened.Response.Type != "done" || reopened.Response.Items[0].Status != domain.StatusOpen || reopened.Response.Items[0].CompletedAt != nil {
		t.Fatalf("%+v", reopened)
	}
}
