package integration_test

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"gorky/backend/internal/domain"
	"gorky/backend/internal/repository"
	"gorky/backend/internal/repository/postgres"
	"gorky/backend/internal/service"
)

func TestManualItemChanges(t *testing.T) {
	f := setup(t)
	repo := postgres.NewItems(f.db)
	svc := service.NewItems(repo)
	item, err := svc.Create(f.ctx, domain.DemoUserID, domain.Item{Type: domain.ItemTask, Title: "исходная задача"})
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/items/" + item.ID
	call := func(method, path, body string, status int) []byte {
		t.Helper()
		req, err := http.NewRequest(method, f.server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+f.token)
		resp, err := f.server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		data, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != status {
			t.Fatalf("%s %s: status=%d body=%s", method, path, resp.StatusCode, data)
		}
		return data
	}
	var updated domain.Item
	data := call("PATCH", path, `{"title":"новое название","due_date":"2026-11-01","status":"done"}`, 200)
	if err := json.Unmarshal(data, &updated); err != nil {
		t.Fatal(err)
	}
	if updated.Title != "новое название" || updated.Status != domain.StatusDone || updated.CompletedAt == nil || updated.DueDate == nil {
		t.Fatalf("unexpected update: %+v", updated)
	}
	call("PATCH", path, `{"status":"done"}`, 200)
	again, err := svc.Get(f.ctx, domain.DemoUserID, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !again.CompletedAt.Equal(*updated.CompletedAt) {
		t.Fatal("повторная отметка изменила completed_at")
	}
	data = call("PATCH", path, `{"due_date":null,"status":"open"}`, 200)
	if err := json.Unmarshal(data, &updated); err != nil {
		t.Fatal(err)
	}
	if updated.DueDate != nil || updated.CompletedAt != nil || updated.Title != "новое название" {
		t.Fatalf("unexpected reset: %+v", updated)
	}
	for _, body := range []string{`{}`, `null`, `[]`, `{"title":null}`, `{"title":" "}`, `{"status":"scheduled"}`, `{"user_id":"fake"}`, `{"type":"meeting"}`, `{"due_date":"bad"}`, `{"due_at":"2026-11-01T12:00:00Z","due_date":"2026-11-01"}`} {
		call("PATCH", path, body, 400)
	}
	// Устаревшая версия не должна перезаписывать уже сохранённые изменения.
	if _, err := repo.Update(f.ctx, item, item.UpdatedAt); !errors.Is(err, repository.ErrConflict) {
		t.Fatalf("stale update: %v", err)
	}
	otherUser := uuid.NewString()
	if _, err := svc.Update(f.ctx, otherUser, item.ID, map[string]json.RawMessage{"title": json.RawMessage(`"чужое изменение"`)}); !errors.Is(err, repository.ErrNotFound) {
		t.Fatalf("foreign update: %v", err)
	}
	if err := svc.Delete(f.ctx, otherUser, item.ID); !errors.Is(err, repository.ErrNotFound) {
		t.Fatalf("foreign delete: %v", err)
	}
	call("DELETE", path, "", 200)
	call("GET", path, "", 404)
	call("PATCH", path, `{"title":"после удаления"}`, 404)
	call("DELETE", path, "", 404)
	var deleted bool
	if err := f.db.QueryRowContext(f.ctx, "SELECT deleted_at IS NOT NULL FROM items WHERE id=$1", item.ID).Scan(&deleted); err != nil || !deleted {
		t.Fatalf("soft delete: %v, %v", deleted, err)
	}
	list, err := svc.List(f.ctx, domain.DemoUserID, repository.ItemFilter{})
	if err != nil || len(list) != 0 {
		t.Fatalf("deleted item in list: %+v, %v", list, err)
	}
}
