package integration_test

import (
	"encoding/json"
	"gorky/backend/internal/domain"
	"testing"
)

func assertEmptyHistory(t *testing.T, f *fixture, session string) {
	t.Helper()
	var history struct {
		History []any            `json:"history"`
		Pending []domain.Message `json:"pending_messages"`
	}
	if err := json.Unmarshal(f.request(t, "GET", "/api/history?session_id="+session, nil, 200), &history); err != nil {
		t.Fatal(err)
	}
	if len(history.History) != 0 || len(history.Pending) != 0 {
		t.Fatalf("%+v", history)
	}
}

func TestResetCancelsProcessingAndIgnoresLateResult(t *testing.T) {
	f := setup(t)
	m, _ := f.submit(t, "reset-processing", "Создай задачу")
	job := f.job(t)
	f.request(t, "POST", "/api/session/reset", map[string]any{"session_id": "reset-processing"}, 200)
	cancelled := decodeMessage(t, f.request(t, "GET", "/api/messages/"+m.ID, nil, 200))
	if cancelled.Status != "cancelled" {
		t.Fatalf("%+v", cancelled)
	}
	err := f.messages.HandleResult(f.ctx, domain.ResultEnvelope{Version: 1, MessageID: m.ID, AttemptID: job.AttemptID, Result: json.RawMessage(`{"status":"ready","actions":[{"intent":"create_task","params":{"title":"не создавать"}}]}`)})
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err := f.db.QueryRowContext(f.ctx, "SELECT count(*) FROM items").Scan(&count); err != nil || count != 0 {
		t.Fatalf("%d %v", count, err)
	}
	assertEmptyHistory(t, f, "reset-processing")
	f.request(t, "POST", "/api/session/reset", map[string]any{"session_id": "reset-processing"}, 200)
	next, _ := f.submit(t, "reset-processing", "Новая задача")
	nextJob := f.job(t)
	if len(nextJob.Request.History) != 0 || nextJob.Request.Draft != nil || nextJob.Request.Focus != nil || len(nextJob.Request.Candidates) != 0 {
		t.Fatalf("%+v", nextJob.Request)
	}
	f.result(t, nextJob, `{"status":"ready","actions":[{"intent":"create_task","params":{"title":"после сброса"}}]}`)
	done := f.completed(t, next.ID)
	if done.Response.Type != "done" {
		t.Fatalf("%+v", done)
	}
	f.request(t, "POST", "/api/session/reset", map[string]any{"session_id": "reset-processing"}, 200)
	readChoiceItem(t, f, done.Response.Items[0].ID)
	assertEmptyHistory(t, f, "reset-processing")
}

func TestResetClearsChoiceAndScopesUser(t *testing.T) {
	f := setup(t)
	seedChoiceTask(t, f, "сброс один", "")
	seedChoiceTask(t, f, "сброс два", "")
	choose := mutationRequest(t, f, "reset-choice", "complete", map[string]any{"target": map[string]any{"ref": "filter", "query": "сброс"}, "done": true})
	login, err := f.auth.Login(f.ctx, "demo2", "DemoPass2!", "reset-other")
	if err != nil {
		t.Fatal(err)
	}
	original := f.token
	f.token = login.Token
	f.request(t, "POST", "/api/session/reset", map[string]any{"session_id": "reset-choice"}, 200)
	f.token = original
	waiting := decodeMessage(t, f.request(t, "GET", "/api/messages/"+choose.ID, nil, 200))
	if waiting.Status != "awaiting_input" {
		t.Fatalf("чужой reset изменил диалог: %+v", waiting)
	}
	f.request(t, "POST", "/api/session/reset", map[string]any{"session_id": "reset-choice"}, 200)
	f.request(t, "POST", "/api/messages/"+choose.ID+"/answer", map[string]any{"input_token": *choose.InputToken, "text": "первую"}, 409)
	assertEmptyHistory(t, f, "reset-choice")
	for _, item := range choose.Response.Items {
		if readChoiceItem(t, f, item.ID).Status != domain.StatusOpen {
			t.Fatal("reset изменил задачу")
		}
	}
	f.request(t, "POST", "/api/session/reset", map[string]any{}, 400)
	f.request(t, "POST", "/api/session/reset", map[string]any{"session_id": "unknown"}, 200)
}
