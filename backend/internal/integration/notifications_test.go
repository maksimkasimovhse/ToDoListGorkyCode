package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"gorky/backend/internal/domain"
	"gorky/backend/internal/repository/postgres"
	"gorky/backend/internal/service"
	httptransport "gorky/backend/internal/transport/http"
)

const botToken = "test-bot-token-0123456789abcdef0123456789"

type capture struct {
	mu         sync.Mutex
	deliveries []domain.Delivery
}

func (c *capture) PublishNotification(_ context.Context, channel string, payload []byte) error {
	var d domain.Delivery
	if err := json.Unmarshal(payload, &d); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.deliveries = append(c.deliveries, d)
	return nil
}

func (c *capture) take() []domain.Delivery {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := c.deliveries
	c.deliveries = nil
	return out
}

type notifyFixture struct {
	*fixture
	repo       *postgres.Notifications
	channels   *service.Channels
	items      *service.Items
	published  *capture
	dispatcher *service.Dispatcher
	api        *httptest.Server
}

func setupNotify(t *testing.T) *notifyFixture {
	t.Helper()
	f := setup(t)
	repo := postgres.NewNotifications(f.db)
	channels := service.NewChannels(repo, f.auth, 24*time.Hour)
	published := &capture{}
	itemsRepo := postgres.NewItems(f.db)
	dispatcher := &service.Dispatcher{Repo: repo, Items: itemsRepo, Publisher: published, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Interval: time.Second, AckTimeout: time.Minute}
	items := service.NewItems(itemsRepo)
	api := httptest.NewServer(httptransport.NewRouter(f.messages, items, f.auth, filepath.Join("..", "..", "..", "web"),
		httptransport.Channels{Service: channels, BotToken: botToken, BotLinks: map[string]string{"max": "https://max.ru/test_bot"}}))
	t.Cleanup(api.Close)
	return &notifyFixture{fixture: f, repo: repo, channels: channels, items: items, published: published, dispatcher: dispatcher, api: api}
}

func (f *notifyFixture) call(t *testing.T, method, path, auth string, body any, status int) []byte {
	t.Helper()
	var payload io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		payload = bytes.NewReader(raw)
	}
	req, _ := http.NewRequestWithContext(f.ctx, method, f.api.URL+path, payload)
	req.Header.Set("Content-Type", "application/json")
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	resp, err := f.api.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != status {
		t.Fatalf("%s %s: status=%d want=%d body=%s", method, path, resp.StatusCode, status, raw)
	}
	return raw
}

type row struct {
	Kind    string
	Status  string
	FireAt  time.Time
	EventAt time.Time
	Held    bool
}

func (f *notifyFixture) rows(t *testing.T, itemID string) []row {
	t.Helper()
	rs, err := f.db.QueryContext(f.ctx, `SELECT kind,status,fire_at,event_at,held FROM notifications WHERE item_id=$1 ORDER BY event_at,kind DESC`, itemID)
	if err != nil {
		t.Fatal(err)
	}
	defer rs.Close()
	var out []row
	for rs.Next() {
		var r row
		if err := rs.Scan(&r.Kind, &r.Status, &r.FireAt, &r.EventAt, &r.Held); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	return out
}

func (f *notifyFixture) makeDue(t *testing.T, itemID string) {
	t.Helper()
	if _, err := f.db.ExecContext(f.ctx, `UPDATE notifications SET fire_at=now()-interval '1 second' WHERE item_id=$1 AND status='pending'`, itemID); err != nil {
		t.Fatal(err)
	}
}

func (f *notifyFixture) meeting(t *testing.T, start time.Time) domain.Item {
	t.Helper()
	end := start.Add(time.Hour)
	item, err := f.items.CreateWithOptions(f.ctx, domain.DemoUserID, domain.Item{Type: domain.ItemMeeting, Title: "Созвон", StartAt: &start, EndAt: &end}, service.SaveOptions{AllowConflicts: true})
	if err != nil {
		t.Fatal(err)
	}
	return item
}

func (f *notifyFixture) link(t *testing.T) {
	t.Helper()
	if _, err := f.channels.Link(f.ctx, "max", service.LinkRequest{ExternalID: "777", Login: "demo1", Password: "DemoPass1!"}); err != nil {
		t.Fatal(err)
	}
}

func TestNotificationScheduleFollowsItem(t *testing.T) {
	f := setupNotify(t)
	start := time.Now().Add(2 * time.Hour).Truncate(time.Minute)
	item := f.meeting(t, start)
	rows := f.rows(t, item.ID)
	if len(rows) != 2 || rows[0].Kind != "soon" || rows[1].Kind != "now" {
		t.Fatalf("ожидались soon и now: %+v", rows)
	}
	if !rows[0].FireAt.Equal(start.Add(-15*time.Minute)) || !rows[1].FireAt.Equal(start) {
		t.Fatalf("неверное время: %+v", rows)
	}

	moved := start.Add(time.Hour)
	patch := map[string]json.RawMessage{"start_at": mustJSON(moved), "end_at": mustJSON(moved.Add(time.Hour))}
	if _, err := f.items.Update(f.ctx, domain.DemoUserID, item.ID, patch); err != nil {
		t.Fatal(err)
	}
	pending := 0
	for _, r := range f.rows(t, item.ID) {
		if r.Status == "pending" {
			pending++
			if !r.EventAt.Equal(moved) {
				t.Fatalf("старое время осталось в расписании: %+v", r)
			}
		}
	}
	if pending != 2 {
		t.Fatalf("после переноса ожидалось 2 уведомления: %+v", f.rows(t, item.ID))
	}

	if _, err := f.items.Update(f.ctx, domain.DemoUserID, item.ID, map[string]json.RawMessage{"status": json.RawMessage(`"cancelled"`)}); err != nil {
		t.Fatal(err)
	}
	for _, r := range f.rows(t, item.ID) {
		if r.Status == "pending" {
			t.Fatalf("отменённая встреча не должна уведомлять: %+v", r)
		}
	}

	// Напоминание меньше чем через 15 минут: только «в момент», без немедленного «скоро»
	at := time.Now().Add(10 * time.Minute)
	reminder, err := f.items.Create(f.ctx, domain.DemoUserID, domain.Item{Type: domain.ItemReminder, Title: "позвонить", RemindAt: &at})
	if err != nil {
		t.Fatal(err)
	}
	if rows := f.rows(t, reminder.ID); len(rows) != 1 || rows[0].Kind != "now" {
		t.Fatalf("ожидалось только now: %+v", rows)
	}

	// Задачи не уведомляют
	task, err := f.items.Create(f.ctx, domain.DemoUserID, domain.Item{Type: domain.ItemTask, Title: "отчёт", DueAt: &at})
	if err != nil {
		t.Fatal(err)
	}
	if rows := f.rows(t, task.ID); len(rows) != 0 {
		t.Fatalf("задача не должна уведомлять: %+v", rows)
	}
}

func mustJSON(v any) json.RawMessage {
	raw, _ := json.Marshal(v)
	return raw
}

func TestDispatcherDeliversOnceAndRespectsAck(t *testing.T) {
	f := setupNotify(t)
	// Без привязанного канала уведомление пропускается
	early := f.meeting(t, time.Now().Add(10*time.Minute))
	if err := f.dispatcher.Tick(f.ctx); err != nil {
		t.Fatal(err)
	}
	if got := f.published.take(); len(got) != 0 {
		t.Fatalf("без канала ничего не отправляется: %+v", got)
	}
	if rows := f.rows(t, early.ID); rows[0].Status != "skipped" {
		t.Fatalf("ожидался skipped: %+v", rows)
	}

	f.link(t)
	item := f.meeting(t, time.Now().Add(10*time.Minute).Add(time.Hour))
	f.makeDue(t, item.ID)
	if err := f.dispatcher.Tick(f.ctx); err != nil {
		t.Fatal(err)
	}
	got := f.published.take()
	if len(got) != 2 {
		t.Fatalf("ожидались soon и now: %+v", got)
	}
	var soon domain.Delivery
	for _, d := range got {
		if d.Kind == domain.NotifySoon {
			soon = d
		}
	}
	if soon.ExternalID != "777" || soon.Channel != "max" || soon.Item == nil || soon.Item.ID != item.ID || soon.Timezone != "Europe/Moscow" {
		t.Fatalf("неверная доставка: %+v", soon)
	}
	// Повторный проход не дублирует: уведомление в очереди ждёт подтверждения
	if err := f.dispatcher.Tick(f.ctx); err != nil {
		t.Fatal(err)
	}
	if again := f.published.take(); len(again) != 0 {
		t.Fatalf("дубль: %+v", again)
	}
	f.call(t, "POST", "/internal/notifications/"+soon.ID+"/ack", "", map[string]any{"status": "sent"}, 401)
	f.call(t, "POST", "/internal/notifications/"+soon.ID+"/ack", "Bot "+botToken, map[string]any{"status": "sent"}, 204)
	// Неподтверждённое возвращается в очередь после AckTimeout
	if _, err := f.db.ExecContext(f.ctx, `UPDATE notifications SET queued_at=now()-interval '2 minutes' WHERE status='queued'`); err != nil {
		t.Fatal(err)
	}
	if err := f.dispatcher.Tick(f.ctx); err != nil {
		t.Fatal(err)
	}
	redelivered := f.published.take()
	if len(redelivered) != 1 || redelivered[0].Kind != domain.NotifyNow {
		t.Fatalf("ожидалась повторная доставка неподтверждённого now: %+v", redelivered)
	}
	for _, r := range f.rows(t, item.ID) {
		if r.Kind == "soon" && r.Status != "sent" {
			t.Fatalf("soon подтверждён: %+v", r)
		}
	}
}

func TestQuietHoursHoldNotifications(t *testing.T) {
	f := setupNotify(t)
	f.link(t)
	loc, _ := time.LoadLocation("Europe/Moscow")
	now := time.Now().In(loc)
	settings := domain.DefaultNotificationSettings()
	settings.QuietEnabled = true
	settings.QuietStart = domain.ClockTime(now.Add(-time.Hour).Format("15:04"))
	settings.QuietEnd = domain.ClockTime(now.Add(time.Hour).Format("15:04"))
	if err := f.repo.SaveSettings(f.ctx, domain.DemoUserID, settings); err != nil {
		t.Fatal(err)
	}
	at := time.Now().Add(20 * time.Minute)
	reminder, err := f.items.Create(f.ctx, domain.DemoUserID, domain.Item{Type: domain.ItemReminder, Title: "ночное", RemindAt: &at})
	if err != nil {
		t.Fatal(err)
	}
	f.makeDue(t, reminder.ID)
	if err := f.dispatcher.Tick(f.ctx); err != nil {
		t.Fatal(err)
	}
	if got := f.published.take(); len(got) != 0 {
		t.Fatalf("в тихие часы ничего не отправляется: %+v", got)
	}
	for _, r := range f.rows(t, reminder.ID) {
		switch r.Kind {
		case "soon":
			// Напоминание наступит раньше конца тихих часов — «скоро» не нужно
			if r.Status != "cancelled" {
				t.Fatalf("soon: %+v", r)
			}
		case "now":
			if r.Status != "pending" || !r.Held || r.FireAt.In(loc).Format("15:04") != string(settings.QuietEnd) {
				t.Fatalf("now должен ждать конца тихих часов: %+v", r)
			}
		}
	}
}

func TestMorningDigest(t *testing.T) {
	f := setupNotify(t)
	f.link(t)
	loc, _ := time.LoadLocation("Europe/Moscow")
	day := time.Now().In(loc).AddDate(0, 0, 3)
	fixed := time.Date(day.Year(), day.Month(), day.Day(), 9, 0, 0, 0, loc)
	f.dispatcher.Now = func() time.Time { return fixed }
	f.meeting(t, fixed.Add(3*time.Hour))
	f.meeting(t, fixed.Add(30*time.Hour)) // завтра — не в сводке
	settings := domain.DefaultNotificationSettings()
	settings.DigestTime = "08:45"
	if err := f.repo.SaveSettings(f.ctx, domain.DemoUserID, settings); err != nil {
		t.Fatal(err)
	}
	if err := f.dispatcher.Tick(f.ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.ExecContext(f.ctx, `UPDATE notifications SET fire_at=now()-interval '1 second' WHERE kind='digest'`); err != nil {
		t.Fatal(err)
	}
	if err := f.dispatcher.Tick(f.ctx); err != nil {
		t.Fatal(err)
	}
	got := f.published.take()
	if len(got) != 1 || got[0].Kind != domain.NotifyDigest || got[0].Day != fixed.Format("2006-01-02") || len(got[0].Items) != 1 {
		t.Fatalf("неверная сводка: %+v", got)
	}
	if got[0].EventAt.In(loc).Format("15:04") != "08:45" {
		t.Fatalf("время сводки: %v", got[0].EventAt)
	}
	// Вторая сводка за тот же день не планируется
	if err := f.dispatcher.Tick(f.ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM notifications WHERE kind='digest'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("сводок: %d, %v", count, err)
	}
}

func TestChannelLinkingAndSettingsAPI(t *testing.T) {
	f := setupNotify(t)
	bearer := "Bearer " + f.token
	bot := "Bot " + botToken

	var settings domain.NotificationSettings
	json.Unmarshal(f.call(t, "GET", "/api/notification-settings", bearer, nil, 200), &settings)
	if settings != domain.DefaultNotificationSettings() {
		t.Fatalf("настройки по умолчанию: %+v", settings)
	}
	json.Unmarshal(f.call(t, "PATCH", "/api/notification-settings", bearer, map[string]any{"digest_time": "06:15", "quiet_enabled": true}, 200), &settings)
	if settings.DigestTime != "06:15" || !settings.QuietEnabled || settings.QuietStart != "23:00" {
		t.Fatalf("частичное изменение: %+v", settings)
	}
	f.call(t, "PATCH", "/api/notification-settings", bearer, map[string]any{"digest_time": "25:00"}, 400)
	f.call(t, "PATCH", "/api/notification-settings", bearer, map[string]any{"quiet_start": "08:00", "quiet_end": "08:00"}, 400)

	var code struct {
		Code string `json:"code"`
		URL  string `json:"url"`
	}
	json.Unmarshal(f.call(t, "POST", "/api/channels/max/link-code", bearer, nil, 201), &code)
	if len(code.Code) != 20 || code.URL != "https://max.ru/test_bot?start="+code.Code {
		t.Fatalf("код: %+v", code)
	}
	f.call(t, "POST", "/internal/channels/max/link", bearer, map[string]any{"external_id": "42", "code": code.Code}, 401)
	var linked service.LoginResult
	json.Unmarshal(f.call(t, "POST", "/internal/channels/max/link", bot, map[string]any{"external_id": "42", "code": strings.ToUpper(code.Code)}, 200), &linked)
	if linked.Token == "" || linked.User.ID != domain.DemoUserID {
		t.Fatalf("привязка: %+v", linked)
	}
	// Код одноразовый
	f.call(t, "POST", "/internal/channels/max/link", bot, map[string]any{"external_id": "43", "code": code.Code}, 410)
	// Токен бота работает как обычная сессия
	f.call(t, "GET", "/api/notification-settings", "Bearer "+linked.Token, nil, 200)

	var state service.ChannelState
	json.Unmarshal(f.call(t, "GET", "/internal/channels/max/42", bot, nil, 200), &state)
	if !state.Linked || !state.Enabled || state.Login != "demo1" {
		t.Fatalf("состояние: %+v", state)
	}
	json.Unmarshal(f.call(t, "PATCH", "/internal/channels/max/42", bot, map[string]any{"enabled": false}, 200), &state)
	if state.Enabled {
		t.Fatal("канал выключен")
	}
	// Повторная привязка отзывает прежний токен
	var relinked service.LoginResult
	json.Unmarshal(f.call(t, "POST", "/internal/channels/max/link", bot, map[string]any{"external_id": "42", "login": "demo1", "password": "DemoPass1!"}, 200), &relinked)
	f.call(t, "GET", "/api/me", "Bearer "+linked.Token, nil, 401)
	f.call(t, "POST", "/internal/channels/max/link", bot, map[string]any{"external_id": "42", "login": "demo1", "password": "wrong"}, 401)

	// Отвязка с сайта: токен бота отзывается, повтор безвреден, без входа нельзя
	f.call(t, "DELETE", "/api/channels/max", "", nil, 401)
	var mine struct {
		Channels []domain.Channel `json:"channels"`
	}
	json.Unmarshal(f.call(t, "GET", "/api/channels", bearer, nil, 200), &mine)
	if len(mine.Channels) != 1 || mine.Channels[0].ExternalID != "42" {
		t.Fatalf("привязки до отвязки: %+v", mine.Channels)
	}
	f.call(t, "DELETE", "/api/channels/max", bearer, nil, 204)
	f.call(t, "GET", "/api/me", "Bearer "+relinked.Token, nil, 401)
	json.Unmarshal(f.call(t, "GET", "/api/channels", bearer, nil, 200), &mine)
	if len(mine.Channels) != 0 {
		t.Fatalf("привязки после отвязки: %+v", mine.Channels)
	}
	f.call(t, "DELETE", "/api/channels/max", bearer, nil, 204)
	json.Unmarshal(f.call(t, "POST", "/internal/channels/max/link", bot, map[string]any{"external_id": "42", "login": "demo1", "password": "DemoPass1!"}, 200), &relinked)

	f.call(t, "DELETE", "/internal/channels/max/42", bot, nil, 204)
	f.call(t, "GET", "/api/me", "Bearer "+relinked.Token, nil, 401)
	json.Unmarshal(f.call(t, "GET", "/internal/channels/max/42", bot, nil, 200), &state)
	if state.Linked {
		t.Fatal("отвязан")
	}
}
