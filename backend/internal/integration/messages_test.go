package integration_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"gorky/backend/internal/domain"
	"gorky/backend/internal/migration"
	"gorky/backend/internal/queue"
	"gorky/backend/internal/repository"
	"gorky/backend/internal/repository/postgres"
	"gorky/backend/internal/service"
	httptransport "gorky/backend/internal/transport/http"
)

type fixture struct {
	ctx               context.Context
	db                *sql.DB
	redis             *redis.Client
	requests, results string
	store             *postgres.Messages
	messages          *service.Messages
	server            *httptest.Server
	stopWorkers       func()
}

func setup(t *testing.T) *fixture {
	t.Helper()
	dsn, redisURL := os.Getenv("TEST_DATABASE_URL"), os.Getenv("TEST_REDIS_URL")
	if dsn == "" || redisURL == "" {
		t.Skip("нужны TEST_DATABASE_URL и TEST_REDIS_URL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	admin, err := postgres.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	schema := "integration_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err = admin.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, err := admin.ExecContext(cleanup, "DROP SCHEMA "+schema+" CASCADE")
		if err != nil {
			t.Error(err)
		}
		admin.Close()
	})
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	q.Set("search_path", schema)
	u.RawQuery = q.Encode()
	db, err := postgres.Open(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	provider, err := migration.NewProvider(db, filepath.Join("..", "..", "migrations"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = provider.Up(ctx); err != nil {
		t.Fatal(err)
	}
	options, err := redis.ParseURL(redisURL)
	if err != nil {
		t.Fatal(err)
	}
	client := redis.NewClient(options)
	t.Cleanup(func() { client.Close() })
	prefix := "test:" + uuid.NewString()
	requests, results := prefix+":requests", prefix+":results"
	if err = client.XGroupCreateMkStream(ctx, requests, "test-ml", "0").Err(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		client.Del(cleanup, requests, results)
	})
	bus, err := queue.Open(ctx, redisURL, requests, results, "test-backend")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { bus.Close() })
	store := postgres.NewMessages(db)
	messages := service.NewMessages(store, 30*time.Second)
	workerCtx, stop := context.WithCancel(ctx)
	wait := bus.Start(workerCtx, store, messages.HandleResult, slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(func() { stop(); wait() })
	server := httptest.NewServer(httptransport.NewRouter(messages, service.NewItems(postgres.NewItems(db)), filepath.Join("..", "..", "..", "web")))
	t.Cleanup(server.Close)
	return &fixture{ctx: ctx, db: db, redis: client, requests: requests, results: results, store: store, messages: messages, server: server, stopWorkers: func() { stop(); wait() }}
}

func (f *fixture) request(t *testing.T, method, path string, body any, status int) []byte {
	t.Helper()
	var payload []byte
	var err error
	if body != nil {
		payload, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	req, err := http.NewRequestWithContext(f.ctx, method, f.server.URL+path, bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := f.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != status {
		t.Fatalf("%s %s: status=%d want=%d body=%s", method, path, resp.StatusCode, status, raw)
	}
	return raw
}

func (f *fixture) submit(t *testing.T, session, text string) (domain.Message, domain.MessageRequest) {
	t.Helper()
	req := domain.MessageRequest{ClientMessageID: uuid.NewString(), SessionID: session, Text: &text, Input: "text", Timezone: "Europe/Moscow"}
	raw := f.request(t, "POST", "/api/message", req, 202)
	var m domain.Message
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	return m, req
}

func (f *fixture) job(t *testing.T) domain.Job {
	t.Helper()
	streams, err := f.redis.XReadGroup(f.ctx, &redis.XReadGroupArgs{Group: "test-ml", Consumer: "test", Streams: []string{f.requests, ">"}, Count: 1, Block: 5 * time.Second}).Result()
	if err != nil {
		t.Fatal(err)
	}
	entry := streams[0].Messages[0]
	var job domain.Job
	if err = json.Unmarshal([]byte(entry.Values["payload"].(string)), &job); err != nil {
		t.Fatal(err)
	}
	if err = f.redis.XAck(f.ctx, f.requests, "test-ml", entry.ID).Err(); err != nil {
		t.Fatal(err)
	}
	return job
}

func (f *fixture) result(t *testing.T, job domain.Job, result string) {
	t.Helper()
	envelope := domain.ResultEnvelope{Version: 1, MessageID: job.MessageID, AttemptID: job.AttemptID, Result: json.RawMessage(result)}
	raw, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.redis.XAdd(f.ctx, &redis.XAddArgs{Stream: f.results, Values: map[string]any{"payload": string(raw)}}).Err(); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) completed(t *testing.T, id string) domain.Message {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		raw := f.request(t, "GET", "/api/messages/"+id, nil, 200)
		var m domain.Message
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatal(err)
		}
		if m.Status != "processing" {
			return m
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("сообщение не завершилось")
	return domain.Message{}
}

func TestMessagePipeline(t *testing.T) {
	f := setup(t)
	t.Run("идемпотентность, polling и повторная доставка", func(t *testing.T) {
		m, req := f.submit(t, "create", "В пятницу отправить отчёт")
		replay := f.request(t, "POST", "/api/message", req, 202)
		var duplicate domain.Message
		json.Unmarshal(replay, &duplicate)
		if duplicate.ID != m.ID {
			t.Fatal("повтор создал новое сообщение")
		}
		other := req
		other.ClientMessageID = uuid.NewString()
		f.request(t, "POST", "/api/message", other, 409)
		changed := "другой запрос"
		other = req
		other.Text = &changed
		f.request(t, "POST", "/api/message", other, 409)
		job := f.job(t)
		if job.MessageID != m.ID || job.Request.Anchors["today"] == nil {
			t.Fatalf("неверное задание: %+v", job)
		}
		result := fmt.Sprintf(`{"status":"ready","actions":[{"intent":"create_task","params":{"title":"отправить отчёт","date":"%s","time":null}}]}`, job.Request.Now.AddDate(0, 0, 3).Format(time.DateOnly))
		f.result(t, job, result)
		done := f.completed(t, m.ID)
		if done.Status != "completed" || done.Response.Type != "done" || len(done.Response.Items) != 1 || done.Response.Items[0].DueDate == nil {
			t.Fatalf("неверный результат: %+v", done)
		}
		f.request(t, "POST", "/api/message", req, 200)
		envelope := domain.ResultEnvelope{Version: 1, MessageID: job.MessageID, AttemptID: job.AttemptID, Result: json.RawMessage(result)}
		if err := f.messages.HandleResult(f.ctx, envelope); err != nil {
			t.Fatal(err)
		}
		var count int
		if err := f.db.QueryRowContext(f.ctx, "SELECT count(*) FROM items").Scan(&count); err != nil || count != 1 {
			t.Fatalf("count=%d err=%v", count, err)
		}
		if _, err := f.store.GetMessage(f.ctx, uuid.NewString(), m.ID); !errors.Is(err, repository.ErrNotFound) {
			t.Fatalf("чужое сообщение доступно: %v", err)
		}
	})
	t.Run("черновик и уточнение", func(t *testing.T) {
		m, _ := f.submit(t, "clarify", "Поставь встречу с Иваном завтра")
		job := f.job(t)
		f.result(t, job, fmt.Sprintf(`{"status":"needs_clarification","actions":[{"intent":"create_meeting","params":{"title":"Встреча с Иваном","date":"%s","participants":["Иван"]}}],"missing":["time"]}`, job.Request.Now.AddDate(0, 0, 2).Format(time.DateOnly)))
		waiting := f.completed(t, m.ID)
		if waiting.Response.Type != "clarify" || waiting.Status != "awaiting_input" || waiting.InputToken == nil {
			t.Fatalf("ожидалось уточнение: %+v", waiting)
		}
		f.request(t, "POST", "/api/messages/"+m.ID+"/answer", map[string]any{"input_token": *waiting.InputToken, "time": "17:00", "duration_min": 30}, 200)
		done := f.completed(t, m.ID)
		if done.Response.Type != "done" || len(done.Response.Items) != 1 {
			t.Fatalf("%+v", done)
		}
		item := done.Response.Items[0]
		if item.EndAt.Sub(*item.StartAt) != 30*time.Minute {
			t.Fatal("длительность не сохранена")
		}
	})
	t.Run("повтор некорректного ответа и устаревшая попытка", func(t *testing.T) {
		m, _ := f.submit(t, "retry", "Добавь задачу")
		first := f.job(t)
		f.result(t, first, `{"bad":true}`)
		second := f.job(t)
		if second.AttemptID == first.AttemptID || second.MessageID != first.MessageID {
			t.Fatal("не создана новая попытка")
		}
		f.result(t, first, `{"status":"ready","actions":[{"intent":"create_task","params":{"title":"устаревшая"}}]}`)
		f.result(t, second, `{"bad":true}`)
		done := f.completed(t, m.ID)
		if done.Status != "failed" {
			t.Fatal("неверный ответ не отклонён")
		}
	})
	t.Run("поздний результат не меняет БД", func(t *testing.T) {
		m, _ := f.submit(t, "timeout", "Создай задачу")
		job := f.job(t)
		if _, err := f.db.ExecContext(f.ctx, "UPDATE messages SET deadline_at=now()-interval '1 second' WHERE id=$1", m.ID); err != nil {
			t.Fatal(err)
		}
		if err := f.store.Expire(f.ctx); err != nil {
			t.Fatal(err)
		}
		f.result(t, job, `{"status":"ready","actions":[{"intent":"create_task","params":{"title":"опоздала"}}]}`)
		done := f.completed(t, m.ID)
		if done.Status != "failed" {
			t.Fatal("тайм-аут не сохранён")
		}
		var count int
		f.db.QueryRowContext(f.ctx, "SELECT count(*) FROM items WHERE title='опоздала'").Scan(&count)
		if count != 0 {
			t.Fatal("поздняя команда выполнена")
		}
	})
	t.Run("откат бизнес-операции", func(t *testing.T) {
		m, _ := f.submit(t, "rollback", "Создай две задачи")
		job := f.job(t)
		err := f.store.Apply(f.ctx, domain.ResultEnvelope{MessageID: m.ID, AttemptID: job.AttemptID}, false, func(ctx context.Context, repo repository.ItemRepository, m domain.Message, state domain.DialogueState) (domain.Reply, domain.DialogueState, error) {
			_, err := service.NewItems(repo).Create(ctx, m.UserID, domain.Item{Type: domain.ItemTask, Title: "не должна сохраниться"})
			if err != nil {
				return domain.Reply{}, state, err
			}
			return domain.Reply{}, state, fmt.Errorf("сбой второго действия")
		})
		if err == nil {
			t.Fatal("ожидался сбой")
		}
		var count int
		f.db.QueryRowContext(f.ctx, "SELECT count(*) FROM items WHERE title='не должна сохраниться'").Scan(&count)
		if count != 0 {
			t.Fatal("частичная запись не откатилась")
		}
		f.result(t, job, `{"status":"ready","actions":[{"intent":"create_task","params":{"title":"первая"}},{"intent":"create_task","params":{"title":"вторая"}}]}`)
		if done := f.completed(t, m.ID); done.Response.Type != "done" || len(done.Response.Items) != 2 {
			t.Fatal("составная команда не выполнилась")
		}
	})
	t.Run("ручной ввод, границы периода и история", func(t *testing.T) {
		f.request(t, "POST", "/api/items", map[string]any{"type": "reminder", "title": "граница", "remind_at": "2026-11-03T00:00:00+03:00"}, 201)
		raw := f.request(t, "GET", "/api/items?from=2026-11-03T00:00:00%2B03:00&to=2026-11-04T00:00:00%2B03:00", nil, 200)
		var list struct {
			Items []domain.Item `json:"items"`
		}
		json.Unmarshal(raw, &list)
		if len(list.Items) != 1 {
			t.Fatalf("неверная граница периода: %s", raw)
		}
		f.request(t, "POST", "/api/items", map[string]any{"type": "reminder", "title": "без времени"}, 400)
		raw = f.request(t, "GET", "/api/history?session_id=clarify", nil, 200)
		if !bytes.Contains(raw, []byte("Встреча с Иваном")) {
			t.Fatal("история не сохранилась")
		}
	})
	t.Run("подтверждение дубликата", func(t *testing.T) {
		m, _ := f.submit(t, "duplicate", "Добавь первую задачу ещё раз")
		job := f.job(t)
		f.result(t, job, `{"status":"ready","actions":[{"intent":"create_task","params":{"title":"первая"}}]}`)
		waiting := f.completed(t, m.ID)
		if waiting.Response.Type != "confirm" || waiting.Status != "awaiting_confirmation" || waiting.InputToken == nil {
			t.Fatal("не запрошено подтверждение дубликата")
		}
		f.request(t, "POST", "/api/messages/"+m.ID+"/answer", map[string]any{"input_token": *waiting.InputToken, "confirmed": true}, 200)
		if done := f.completed(t, m.ID); done.Response.Type != "done" {
			t.Fatal("подтверждённая запись не создана")
		}
	})
	t.Run("список и поиск через модель", func(t *testing.T) {
		m, _ := f.submit(t, "list", "Что у меня третьего ноября?")
		job := f.job(t)
		f.result(t, job, `{"status":"ready","actions":[{"intent":"list","params":{"from":"2026-11-03T00:00:00+03:00","to":"2026-11-04T00:00:00+03:00","types":["reminder"]}}]}`)
		if done := f.completed(t, m.ID); done.Response.Type != "results" || len(done.Response.Items) != 1 {
			t.Fatalf("неверный список: %+v", done)
		}
		m, _ = f.submit(t, "list", "Найди задачу про отчёт")
		job = f.job(t)
		f.result(t, job, `{"status":"ready","actions":[{"intent":"search","params":{"query":"отчёт","types":["task"]}}]}`)
		if done := f.completed(t, m.ID); done.Response.Type != "results" || len(done.Response.Items) != 1 {
			t.Fatalf("неверный поиск: %+v", done)
		}
	})
	t.Run("прошедшее время требует подтверждения", func(t *testing.T) {
		m, _ := f.submit(t, "past", "Напомни сегодня в полночь")
		job := f.job(t)
		f.result(t, job, fmt.Sprintf(`{"status":"ready","actions":[{"intent":"create_reminder","params":{"title":"прошедшее время","date":"%s","time":"00:00"}}]}`, job.Request.Now.AddDate(0, 0, -1).Format(time.DateOnly)))
		waiting := f.completed(t, m.ID)
		if waiting.Response.Type != "confirm" || waiting.InputToken == nil {
			t.Fatal("не запрошено подтверждение прошедшего времени")
		}
		f.request(t, "POST", "/api/messages/"+m.ID+"/answer", map[string]any{"input_token": *waiting.InputToken, "confirmed": true}, 200)
		done := f.completed(t, m.ID)
		if done.Response.Type != "done" || done.Response.Items[0].RemindAt.Format(time.DateOnly) != job.Request.Now.AddDate(0, 0, 1).Format(time.DateOnly) {
			t.Fatalf("неверный перенос: %+v", done)
		}
	})
	t.Run("outbox переживает повторную публикацию", func(t *testing.T) {
		f.stopWorkers()
		m, _ := f.submit(t, "outbox", "Задача после сбоя публикации")
		publish := func(ctx context.Context, job domain.Job) error {
			raw, err := json.Marshal(job)
			if err != nil {
				return err
			}
			return f.redis.XAdd(ctx, &redis.XAddArgs{Stream: f.requests, Values: map[string]any{"payload": string(raw)}}).Err()
		}
		err := f.store.PublishPending(f.ctx, func(ctx context.Context, job domain.Job) error {
			if err := publish(ctx, job); err != nil {
				return err
			}
			return errors.New("сбой до фиксации published_at")
		})
		if err == nil {
			t.Fatal("ожидался сбой публикации")
		}
		if err = f.store.PublishPending(f.ctx, publish); err != nil {
			t.Fatal(err)
		}
		first, second := f.job(t), f.job(t)
		if first.MessageID != m.ID || first.AttemptID != second.AttemptID {
			t.Fatal("повтор outbox изменил идентификатор попытки")
		}
		for _, job := range []domain.Job{first, second} {
			if err = f.messages.HandleResult(f.ctx, domain.ResultEnvelope{Version: 1, MessageID: job.MessageID, AttemptID: job.AttemptID, Result: json.RawMessage(`{"status":"ready","actions":[{"intent":"create_task","params":{"title":"после сбоя"}}]}`)}); err != nil {
				t.Fatal(err)
			}
		}
		var count int
		if err = f.db.QueryRowContext(f.ctx, "SELECT count(*) FROM items WHERE title='после сбоя'").Scan(&count); err != nil || count != 1 {
			t.Fatalf("count=%d err=%v", count, err)
		}
	})
}
