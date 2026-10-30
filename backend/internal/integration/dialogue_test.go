package integration_test

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorky/backend/internal/domain"
	"gorky/backend/internal/repository"
)

func decodeMessage(t *testing.T, raw []byte) domain.Message {
	t.Helper()
	var message domain.Message
	if err := json.Unmarshal(raw, &message); err != nil {
		t.Fatal(err)
	}
	return message
}

func TestBlockedDialogue(t *testing.T) {
	t.Run("уточнения блокируют сценарий до сохранения", func(t *testing.T) {
		f := setup(t)
		m, req := f.submit(t, "modal", "Создай встречу")
		job := f.job(t)
		f.result(t, job, `{"status":"needs_clarification","actions":[{"intent":"create_meeting","params":{}}],"missing":["title","date","time"]}`)
		waiting := f.completed(t, m.ID)
		if waiting.Status != "awaiting_input" || waiting.InputToken == nil {
			t.Fatalf("%+v", waiting)
		}
		initialToken := *waiting.InputToken
		req.ClientMessageID = uuid.NewString()
		f.request(t, "POST", "/api/message", req, 409)
		f.request(t, "POST", "/api/messages/"+m.ID+"/answer", map[string]any{"input_token": initialToken, "time": "17:00"}, 400)
		f.request(t, "POST", "/api/messages/"+m.ID+"/answer", map[string]any{"input_token": initialToken, "confirmed": true}, 400)
		f.request(t, "POST", "/api/messages/"+m.ID+"/answer", map[string]any{"input_token": initialToken, "title": ""}, 400)
		path := "/api/messages/" + m.ID + "/answer"
		firstAnswer := map[string]any{"input_token": initialToken, "title": "Встреча из окна"}
		waiting = decodeMessage(t, f.request(t, "POST", path, firstAnswer, 200))
		if waiting.Status != "awaiting_input" || waiting.ID != m.ID || waiting.InputToken == nil || *waiting.InputToken == initialToken {
			t.Fatalf("неверное продолжение: %+v", waiting)
		}
		nextToken := *waiting.InputToken
		// Повтор первого ответа возвращает актуальный сценарий и не применяет его заново.
		replayed := decodeMessage(t, f.request(t, "POST", path, firstAnswer, 200))
		if replayed.InputToken == nil || *replayed.InputToken != nextToken {
			t.Fatal("повтор ответа изменил состояние")
		}
		f.request(t, "POST", path, map[string]any{"input_token": initialToken, "title": "другое название"}, 409)
		f.request(t, "POST", path, map[string]any{"input_token": uuid.NewString(), "date": "2030-01-02"}, 409)
		date := job.Request.Now.AddDate(0, 0, 2).Format(time.DateOnly)
		waiting = decodeMessage(t, f.request(t, "POST", path, map[string]any{"input_token": nextToken, "date": date}, 200))
		if waiting.Status != "awaiting_input" || waiting.InputToken == nil {
			t.Fatalf("%+v", waiting)
		}
		f.request(t, "POST", "/api/message", req, 409)
		f.request(t, "POST", path, map[string]any{"input_token": *waiting.InputToken, "time": "25:00"}, 400)
		// После перезагрузки фронт должен увидеть окно, а не разблокировать обычный ввод.
		var history struct {
			Pending []domain.Message `json:"pending_messages"`
		}
		if err := json.Unmarshal(f.request(t, "GET", "/api/history?session_id=modal", nil, 200), &history); err != nil {
			t.Fatal(err)
		}
		if len(history.Pending) != 1 || history.Pending[0].Status != "awaiting_input" || history.Pending[0].InputToken == nil {
			t.Fatal("ожидание потеряно в истории")
		}
		lastAnswer := map[string]any{"input_token": *waiting.InputToken, "time": "17:00"}
		done := decodeMessage(t, f.request(t, "POST", path, lastAnswer, 200))
		if done.Status != "completed" || done.ID != m.ID || done.InputToken != nil || done.Response.Type != "done" || len(done.Response.Items) != 1 {
			t.Fatalf("%+v", done)
		}
		f.request(t, "POST", path, lastAnswer, 200)
		var count int
		if err := f.db.QueryRowContext(f.ctx, "SELECT count(*) FROM items WHERE title='Встреча из окна'").Scan(&count); err != nil || count != 1 {
			t.Fatalf("count=%d err=%v", count, err)
		}
		var jobs int
		if err := f.db.QueryRowContext(f.ctx, "SELECT count(*) FROM message_outbox WHERE message_id=$1", m.ID).Scan(&jobs); err != nil || jobs != 1 {
			t.Fatalf("уточнение отправлено в ML: jobs=%d err=%v", jobs, err)
		}
		f.request(t, "POST", "/api/message", req, 202)
	})
	t.Run("отмена обработки и поздний ответ ML", func(t *testing.T) {
		f := setup(t)
		m, _ := f.submit(t, "cancel", "Создай задачу")
		job := f.job(t)
		cancelled := decodeMessage(t, f.request(t, "POST", "/api/messages/"+m.ID+"/cancel", nil, 200))
		if cancelled.Status != "cancelled" {
			t.Fatalf("%+v", cancelled)
		}
		f.request(t, "POST", "/api/messages/"+m.ID+"/cancel", nil, 200)
		err := f.messages.HandleResult(f.ctx, domain.ResultEnvelope{Version: 1, MessageID: job.MessageID, AttemptID: job.AttemptID, Result: json.RawMessage(`{"status":"ready","actions":[{"intent":"create_task","params":{"title":"отменённая"}}]}`)})
		if err != nil {
			t.Fatal(err)
		}
		var count int
		if err = f.db.QueryRowContext(f.ctx, "SELECT count(*) FROM items").Scan(&count); err != nil || count != 0 {
			t.Fatalf("count=%d err=%v", count, err)
		}
		f.submit(t, "cancel", "Новая задача")
	})
	t.Run("ожидание истекает и чужой ответ запрещён", func(t *testing.T) {
		f := setup(t)
		m, req := f.submit(t, "expire", "Встреча завтра")
		job := f.job(t)
		date := job.Request.Now.AddDate(0, 0, 1).Format(time.DateOnly)
		result := `{"status":"ready","actions":[{"intent":"create_meeting","params":{"title":"Встреча","date":"` + date + `"}}]}`
		f.result(t, job, result)
		waiting := f.completed(t, m.ID)
		if waiting.InputToken == nil {
			t.Fatal("нет токена")
		}
		answer := domain.MessageAnswer{InputToken: *waiting.InputToken}
		value := "17:00"
		answer.Time = &value
		if _, err := f.messages.Answer(f.ctx, uuid.NewString(), m.ID, answer); !errors.Is(err, repository.ErrNotFound) {
			t.Fatalf("чужой ответ: %v", err)
		}
		if _, err := f.messages.Cancel(f.ctx, uuid.NewString(), m.ID); !errors.Is(err, repository.ErrNotFound) {
			t.Fatalf("чужая отмена: %v", err)
		}
		if _, err := f.db.ExecContext(f.ctx, "UPDATE messages SET deadline_at=now()-interval '1 second' WHERE id=$1", m.ID); err != nil {
			t.Fatal(err)
		}
		if err := f.store.Expire(f.ctx); err != nil {
			t.Fatal(err)
		}
		done := f.completed(t, m.ID)
		if done.Status != "failed" || done.Response.Type != "error" || done.InputToken != nil {
			t.Fatalf("%+v", done)
		}
		f.request(t, "POST", "/api/messages/"+m.ID+"/answer", answer, 409)
		req.ClientMessageID = uuid.NewString()
		f.request(t, "POST", "/api/message", req, 202)
	})
}
