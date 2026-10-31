package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gorky/backend/internal/domain"
	"gorky/backend/internal/repository"
	"gorky/backend/internal/repository/postgres"
	"gorky/backend/internal/service"
	httptransport "gorky/backend/internal/transport/http"
)

func authRequest(t *testing.T, client *http.Client, base, method, path string, body any, token string, want int) []byte {
	t.Helper()
	var payload []byte
	var err error
	if body != nil {
		payload, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	req, err := http.NewRequest(method, base+path, bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != want {
		t.Fatalf("%s %s status=%d want=%d", method, path, resp.StatusCode, want)
	}
	return raw
}

func TestAuthenticationRequiredAndLogin(t *testing.T) {
	f := setup(t)
	client := f.server.Client()
	for _, route := range []struct{ method, path string }{
		{"POST", "/api/session/reset"}, {"POST", "/api/undo"}, {"GET", "/api/me"}, {"GET", "/api/items"}, {"GET", "/api/items/search?q=abc"}, {"POST", "/api/items"},
		{"GET", "/api/items/00000000-0000-0000-0000-000000000001"}, {"PATCH", "/api/items/00000000-0000-0000-0000-000000000001"}, {"DELETE", "/api/items/00000000-0000-0000-0000-000000000001"},
		{"POST", "/api/message"}, {"GET", "/api/history?session_id=shared"}, {"GET", "/api/messages/00000000-0000-0000-0000-000000000001"},
		{"POST", "/api/messages/00000000-0000-0000-0000-000000000001/answer"}, {"POST", "/api/messages/00000000-0000-0000-0000-000000000001/cancel"}, {"POST", "/api/auth/logout"},
	} {
		authRequest(t, client, f.server.URL, route.method, route.path, nil, "", 401)
	}
	authRequest(t, client, f.server.URL, "GET", "/healthz", nil, "", 200)
	authRequest(t, client, f.server.URL, "GET", "/", nil, "", 200)
	authRequest(t, client, f.server.URL, "GET", "/api/me", nil, "not-a-token", 401)
	for _, body := range []map[string]string{{"login": "demo1", "password": "wrong"}, {"login": "unknown", "password": "DemoPass1!"}, {"login": "demo1' OR 1=1 --", "password": "DemoPass1!"}} {
		raw := authRequest(t, client, f.server.URL, "POST", "/api/auth/login", body, "", 401)
		if !strings.Contains(string(raw), "invalid_credentials") {
			t.Fatalf("%s", raw)
		}
	}
	raw := authRequest(t, client, f.server.URL, "POST", "/api/auth/login", map[string]string{"login": " DEMO1 ", "password": "DemoPass1!"}, "", 200)
	var result service.LoginResult
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Token) != 43 || result.User.ID != domain.DemoUserID || !time.Now().Before(result.ExpiresAt) || strings.Contains(string(raw), "password_hash") {
		t.Fatal("неверный ответ входа")
	}
	session, _, err := f.auth.Authenticate(f.ctx, result.Token)
	if err != nil {
		t.Fatal(err)
	}
	if session.Key == result.Token || session.Key != service.SessionKey(result.Token) {
		t.Fatal("в хранилище попал открытый токен")
	}
	authRequest(t, client, f.server.URL, "GET", "/api/me", nil, result.Token, 200)
	authRequest(t, client, f.server.URL, "POST", "/api/auth/logout", nil, result.Token, 204)
	authRequest(t, client, f.server.URL, "GET", "/api/me", nil, result.Token, 401)
	authRequest(t, client, f.server.URL, "GET", "/api/me", nil, f.token, 200)
}

func TestUserIsolationAcrossItemsMessagesAndChoices(t *testing.T) {
	f := setup(t)
	first := seedChoiceTask(t, f, "личная один", "")
	seedChoiceTask(t, f, "личная два", "")
	choose := mutationRequest(t, f, "shared-dialogue", "update", map[string]any{"target": map[string]any{"ref": "filter", "query": "личная"}, "changes": map[string]any{"title": "изменённая"}})
	login, err := f.auth.Login(f.ctx, "demo2", "DemoPass2!", "second-user")
	if err != nil {
		t.Fatal(err)
	}
	firstToken := f.token
	f.token = login.Token
	f.request(t, "GET", "/api/items/"+first.ID, nil, 404)
	f.request(t, "PATCH", "/api/items/"+first.ID, map[string]any{"title": "чужое"}, 404)
	f.request(t, "DELETE", "/api/items/"+first.ID, nil, 404)
	f.request(t, "GET", "/api/messages/"+choose.ID, nil, 404)
	f.request(t, "POST", "/api/messages/"+choose.ID+"/answer", map[string]any{"input_token": *choose.InputToken, "option_id": first.ID}, 404)
	f.request(t, "POST", "/api/messages/"+choose.ID+"/cancel", nil, 404)
	var list struct{ Items []domain.Item }
	if err := json.Unmarshal(f.request(t, "GET", "/api/items", nil, 200), &list); err != nil || len(list.Items) != 0 {
		t.Fatalf("чужие записи: %v", err)
	}
	// session_id диалога одинаковый, но пользователи и контекст разделены.
	m, _ := f.submit(t, "shared-dialogue", "Создай задачу второго пользователя")
	job := f.job(t)
	f.result(t, job, `{"status":"ready","actions":[{"intent":"create_task","params":{"title":"второй пользователь"}}]}`)
	done := f.completed(t, m.ID)
	if done.Response.Type != "done" || done.Response.Items[0].UserID != login.User.ID {
		t.Fatalf("%+v", done)
	}
	secondID := done.Response.Items[0].ID
	f.token = firstToken
	f.request(t, "GET", "/api/items/"+secondID, nil, 404)
	f.request(t, "GET", "/api/messages/"+m.ID, nil, 404)
	f.request(t, "POST", "/api/messages/"+choose.ID+"/cancel", nil, 200)
}

func TestExpiredOrRevokedSessionCannotApplyML(t *testing.T) {
	for _, expired := range []bool{false, true} {
		t.Run(map[bool]string{false: "logout", true: "expired"}[expired], func(t *testing.T) {
			f := setup(t)
			originalToken := f.token
			ttl := time.Hour
			if expired {
				ttl = 800 * time.Millisecond
			}
			shortAuth := service.NewAuth(postgres.NewUsers(f.db), f.sessions, ttl)
			login, err := shortAuth.Login(f.ctx, "demo1", "DemoPass1!", "short")
			if err != nil {
				t.Fatal(err)
			}
			f.token = login.Token
			m, _ := f.submit(t, "auth-expiry", "Создай задачу")
			job := f.job(t)
			if expired {
				time.Sleep(time.Until(login.ExpiresAt) + 30*time.Millisecond)
			} else {
				f.request(t, "POST", "/api/auth/logout", nil, 204)
			}
			f.request(t, "GET", "/api/messages/"+m.ID, nil, 401)
			f.result(t, job, `{"status":"ready","actions":[{"intent":"create_task","params":{"title":"не создавать"}}]}`)
			f.token = originalToken
			done := f.completed(t, m.ID)
			if done.Status != "failed" || done.Response.Type != "error" {
				t.Fatalf("%+v", done)
			}
			data, _ := json.Marshal(done.Response.Data)
			if !strings.Contains(string(data), "session_expired") {
				t.Fatalf("%s", data)
			}
			var count int
			if err := f.db.QueryRowContext(f.ctx, "SELECT count(*) FROM items").Scan(&count); err != nil || count != 0 {
				t.Fatalf("count=%d err=%v", count, err)
			}
		})
	}
}

func TestRevocationDuringMLExecutionRollsBackItems(t *testing.T) {
	f := setup(t)
	originalToken := f.token
	login, err := f.auth.Login(f.ctx, "demo1", "DemoPass1!", "revoke-during-execution")
	if err != nil {
		t.Fatal(err)
	}
	f.token = login.Token
	m, _ := f.submit(t, "revoke-inside", "Создай задачу")
	job := f.job(t)
	err = f.store.Apply(f.ctx, domain.ResultEnvelope{MessageID: m.ID, AttemptID: job.AttemptID}, false, func(ctx context.Context, repo repository.ItemRepository, m domain.Message, state domain.DialogueState) (domain.Reply, domain.DialogueState, error) {
		if _, err := service.NewItems(repo).Create(ctx, m.UserID, domain.Item{Type: domain.ItemTask, Title: "откатить"}); err != nil {
			return domain.Reply{}, state, err
		}
		if err := f.sessions.Delete(ctx, service.SessionKey(login.Token)); err != nil {
			return domain.Reply{}, state, err
		}
		return domain.NewReply("done", "Готово", nil), state, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	f.token = originalToken
	done := f.completed(t, m.ID)
	if done.Status != "failed" {
		t.Fatalf("%+v", done)
	}
	var count int
	if err := f.db.QueryRowContext(f.ctx, "SELECT count(*) FROM items").Scan(&count); err != nil || count != 0 {
		t.Fatalf("count=%d err=%v", count, err)
	}
}

type unavailableSessions struct{ repository.SessionRepository }

func (s unavailableSessions) Get(context.Context, string) (domain.AuthSession, error) {
	return domain.AuthSession{}, errors.New("redis unavailable")
}

func TestAuthUnavailableFailsClosedAndDisabledUser(t *testing.T) {
	f := setup(t)
	broken := service.NewAuth(postgres.NewUsers(f.db), unavailableSessions{f.sessions}, time.Hour)
	server := httptest.NewServer(httptransport.NewRouter(f.messages, service.NewItems(postgres.NewItems(f.db)), broken, filepath.Join("..", "..", "..", "web")))
	defer server.Close()
	authRequest(t, server.Client(), server.URL, "GET", "/api/items", nil, f.token, 503)
	if _, err := f.db.ExecContext(f.ctx, "UPDATE users SET is_active=false WHERE id=$1", domain.DemoUserID); err != nil {
		t.Fatal(err)
	}
	f.request(t, "GET", "/api/me", nil, 401)
	authRequest(t, f.server.Client(), f.server.URL, "POST", "/api/auth/login", map[string]string{"login": "demo1", "password": "DemoPass1!"}, "", 401)
}

func TestLoginRateLimit(t *testing.T) {
	f := setup(t)
	for range 20 {
		authRequest(t, f.server.Client(), f.server.URL, "POST", "/api/auth/login", map[string]string{"login": "", "password": ""}, "", 401)
	}
	authRequest(t, f.server.Client(), f.server.URL, "POST", "/api/auth/login", map[string]string{"login": "demo1", "password": "DemoPass1!"}, "", 429)
}

func TestSessionExpiresWhileChoosing(t *testing.T) {
	f := setup(t)
	originalToken := f.token
	first := seedChoiceTask(t, f, "выбор сессия один", "")
	seedChoiceTask(t, f, "выбор сессия два", "")
	auth := service.NewAuth(postgres.NewUsers(f.db), f.sessions, time.Second)
	login, err := auth.Login(f.ctx, "demo1", "DemoPass1!", "choice-ttl")
	if err != nil {
		t.Fatal(err)
	}
	f.token = login.Token
	waiting := mutationRequest(t, f, "auth-choice", "complete", map[string]any{"target": map[string]any{"ref": "filter", "query": "выбор сессия"}, "done": true})
	if waiting.Response.Type != "choose" {
		t.Fatalf("%+v", waiting)
	}
	time.Sleep(time.Until(login.ExpiresAt) + 30*time.Millisecond)
	path := "/api/messages/" + waiting.ID + "/answer"
	answer := map[string]any{"input_token": *waiting.InputToken, "option_id": first.ID}
	f.request(t, "POST", path, answer, 401)
	f.token = originalToken
	if readChoiceItem(t, f, first.ID).Status != domain.StatusOpen {
		t.Fatal("выполнено с истёкшей сессией")
	}
	// input_token не является авторизацией. После нового входа тот же владелец может продолжить диалог.
	done := decodeMessage(t, f.request(t, "POST", path, answer, 200))
	if done.Response.Type != "done" || done.Response.Items[0].Status != domain.StatusDone {
		t.Fatalf("%+v", done)
	}
}
