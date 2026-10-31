package integration_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"

	"gorky/backend/internal/domain"
	"gorky/backend/internal/repository/postgres"
	"gorky/backend/internal/service"
)

func undoRequest(t *testing.T, f *fixture, token *string, want int) domain.Reply {
	t.Helper()
	if token == nil {
		t.Fatal("undo_token отсутствует")
	}
	raw := f.request(t, "POST", "/api/undo", map[string]any{"undo_token": *token}, want)
	var reply domain.Reply
	if want == 200 {
		if err := json.Unmarshal(raw, &reply); err != nil {
			t.Fatal(err)
		}
	}
	return reply
}

func TestUndoCreateUpdateAndDelete(t *testing.T) {
	t.Run("создание и повтор undo", func(t *testing.T) {
		f := setup(t)
		item := seedChoiceTask(t, f, "отменить создание", "")
		done := undoRequest(t, f, item.UndoToken, 200)
		if done.Type != "done" || len(done.Items) != 1 || done.Items[0].ID != item.ID || done.Items[0].DeletedAt == nil {
			t.Fatalf("%+v", done)
		}
		f.request(t, "GET", "/api/items/"+item.ID, nil, 404)
		replay := undoRequest(t, f, item.UndoToken, 200)
		if !replay.Items[0].UpdatedAt.Equal(done.Items[0].UpdatedAt) {
			t.Fatal("повтор undo выполнил операцию второй раз")
		}
	})
	t.Run("изменение и выполнение", func(t *testing.T) {
		f := setup(t)
		item := seedChoiceTask(t, f, "исходное название", "2030-01-01")
		raw := f.request(t, "PATCH", "/api/items/"+item.ID, map[string]any{"title": "новое название", "status": "done", "due_date": nil}, 200)
		var updated domain.Item
		if err := json.Unmarshal(raw, &updated); err != nil {
			t.Fatal(err)
		}
		done := undoRequest(t, f, updated.UndoToken, 200)
		saved := readChoiceItem(t, f, item.ID)
		if done.Type != "done" || saved.Title != item.Title || saved.Status != domain.StatusOpen || saved.CompletedAt != nil || saved.DueDate == nil || *saved.DueDate != *item.DueDate {
			t.Fatalf("%+v", saved)
		}
	})
	t.Run("мягкое удаление", func(t *testing.T) {
		f := setup(t)
		item := seedChoiceTask(t, f, "вернуть удалённую", "2030-01-02")
		var deleted struct {
			UndoToken *string `json:"undo_token"`
		}
		if err := json.Unmarshal(f.request(t, "DELETE", "/api/items/"+item.ID, nil, 200), &deleted); err != nil {
			t.Fatal(err)
		}
		f.request(t, "GET", "/api/items/"+item.ID, nil, 404)
		undoRequest(t, f, deleted.UndoToken, 200)
		restored := readChoiceItem(t, f, item.ID)
		if restored.Title != item.Title || restored.DeletedAt != nil || !restored.CreatedAt.Equal(item.CreatedAt) {
			t.Fatalf("%+v", restored)
		}
	})
}

func TestUndoRejectsChangedExpiredAndForeign(t *testing.T) {
	f := setup(t)
	item := seedChoiceTask(t, f, "первое действие", "")
	f.request(t, "PATCH", "/api/items/"+item.ID, map[string]any{"title": "новое действие"}, 200)
	undoRequest(t, f, item.UndoToken, 409)
	if readChoiceItem(t, f, item.ID).Title != "новое действие" {
		t.Fatal("новые изменения затёрты")
	}
	other := seedChoiceTask(t, f, "истекающая отмена", "")
	hash := sha256.Sum256([]byte(*other.UndoToken))
	if _, err := f.db.ExecContext(f.ctx, "UPDATE undo_operations SET expires_at=now()-interval '1 second' WHERE token_hash=$1", hex.EncodeToString(hash[:])); err != nil {
		t.Fatal(err)
	}
	undoRequest(t, f, other.UndoToken, 410)
	readChoiceItem(t, f, other.ID)
	f.request(t, "POST", "/api/undo", map[string]any{"undo_token": "bad"}, 400)
	f.request(t, "POST", "/api/undo", map[string]any{"undo_token": "undo_" + strings.Repeat("A", 43)}, 404)
	own := seedChoiceTask(t, f, "чужой токен", "")
	login, err := f.auth.Login(f.ctx, "demo2", "DemoPass2!", "undo-second")
	if err != nil {
		t.Fatal(err)
	}
	original := f.token
	f.token = login.Token
	undoRequest(t, f, own.UndoToken, 404)
	f.token = original
	readChoiceItem(t, f, own.ID)
}

func TestUndoCompoundAndAtomicConflict(t *testing.T) {
	for _, modify := range []bool{false, true} {
		t.Run(fmt.Sprint(modify), func(t *testing.T) {
			f := setup(t)
			m, _ := f.submit(t, "undo-batch", "Создай две задачи")
			job := f.job(t)
			result := `{"status":"ready","actions":[{"intent":"create_task","params":{"title":"первая"}},{"intent":"create_task","params":{"title":"вторая"}}]}`
			f.result(t, job, result)
			done := f.completed(t, m.ID)
			if done.Response.Type != "done" || len(done.Response.Items) != 2 || done.Response.UndoToken == nil {
				t.Fatalf("%+v", done)
			}
			if modify {
				f.request(t, "PATCH", "/api/items/"+done.Response.Items[0].ID, map[string]any{"title": "изменено позже"}, 200)
				undoRequest(t, f, done.Response.UndoToken, 409)
				for _, item := range done.Response.Items {
					readChoiceItem(t, f, item.ID)
				}
			} else {
				restored := undoRequest(t, f, done.Response.UndoToken, 200)
				if len(restored.Items) != 2 {
					t.Fatalf("%+v", restored)
				}
				for _, item := range done.Response.Items {
					f.request(t, "GET", "/api/items/"+item.ID, nil, 404)
				}
			}
		})
	}
}

func TestUndoMessageMutationAndDelete(t *testing.T) {
	f := setup(t)
	item := seedChoiceTask(t, f, "цель изменения", "")
	done := mutationRequest(t, f, "undo-mutation", "update", map[string]any{"target": map[string]any{"ref": "filter", "query": "цель изменения"}, "changes": map[string]any{"title": "после изменения"}})
	if done.Response.Type != "done" || done.Response.UndoToken == nil {
		t.Fatalf("%+v", done)
	}
	undoRequest(t, f, done.Response.UndoToken, 200)
	if readChoiceItem(t, f, item.ID).Title != item.Title {
		t.Fatal("не восстановлено название")
	}
	confirm := mutationRequest(t, f, "undo-delete", "delete", map[string]any{"target": map[string]any{"ref": "filter", "query": item.Title}})
	if confirm.Response.Type != "confirm" || confirm.Status != "awaiting_confirmation" {
		raw, _ := json.Marshal(confirm)
		t.Fatalf("delete not awaiting confirmation: %s", raw)
	}
	deleted := decodeMessage(t, f.request(t, "POST", "/api/messages/"+confirm.ID+"/answer", map[string]any{"input_token": *confirm.InputToken, "confirmed": true}, 200))
	if deleted.Response.Type != "done" || deleted.Response.UndoToken == nil {
		t.Fatalf("%+v", deleted)
	}
	undoRequest(t, f, deleted.Response.UndoToken, 200)
	readChoiceItem(t, f, item.ID)
}

func TestConcurrentUndoIsAppliedOnce(t *testing.T) {
	f := setup(t)
	item := seedChoiceTask(t, f, "одна отмена", "")
	svc := service.NewItems(postgres.NewItems(f.db))
	var wg sync.WaitGroup
	replies := make(chan domain.Reply, 2)
	failures := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			reply, err := svc.Undo(f.ctx, domain.DemoUserID, *item.UndoToken)
			if err != nil {
				failures <- err
			} else {
				replies <- reply
			}
		}()
	}
	wg.Wait()
	close(failures)
	close(replies)
	for err := range failures {
		t.Fatal(err)
	}
	count := 0
	var first domain.Reply
	for reply := range replies {
		if count == 0 {
			first = reply
		} else if !reply.Items[0].UpdatedAt.Equal(first.Items[0].UpdatedAt) {
			t.Fatal("undo применён дважды")
		}
		count++
	}
	if count != 2 {
		t.Fatalf("count=%d", count)
	}
}

func TestUndoMeetingCannotRestoreNewConflict(t *testing.T) {
	f := setup(t)
	create := func(title string) domain.Item {
		t.Helper()
		var item domain.Item
		raw := f.request(t, "POST", "/api/items", map[string]any{"type": "meeting", "title": title, "start_at": "2030-01-02T10:00:00+03:00", "end_at": "2030-01-02T11:00:00+03:00"}, 201)
		if err := json.Unmarshal(raw, &item); err != nil {
			t.Fatal(err)
		}
		return item
	}
	first := create("исходная встреча")
	var deleted struct {
		UndoToken *string `json:"undo_token"`
	}
	if err := json.Unmarshal(f.request(t, "DELETE", "/api/items/"+first.ID, nil, 200), &deleted); err != nil {
		t.Fatal(err)
	}
	second := create("новая встреча")
	undoRequest(t, f, deleted.UndoToken, 409)
	f.request(t, "GET", "/api/items/"+first.ID, nil, 404)
	readChoiceItem(t, f, second.ID)
	f.request(t, "DELETE", "/api/items/"+second.ID, nil, 200)
	undoRequest(t, f, deleted.UndoToken, 200)
	readChoiceItem(t, f, first.ID)
}
