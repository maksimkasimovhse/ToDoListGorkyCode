package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorky/backend/internal/domain"
	"gorky/backend/internal/repository"
)

// Каналы, к которым можно привязать аккаунт.
var knownChannels = map[string]bool{"max": true}

func checkChannel(channel string) error {
	if !knownChannels[channel] {
		return invalid("неизвестный канал")
	}
	return nil
}

func checkExternalID(id string) error {
	if strings.TrimSpace(id) == "" || len(id) > 64 {
		return invalid("неверный external_id")
	}
	return nil
}

// Channels связывает аккаунты мессенджеров с пользователями и хранит настройки уведомлений.
type Channels struct {
	repo       repository.NotificationRepository
	auth       *Auth
	sessionTTL time.Duration
	codeTTL    time.Duration
}

func NewChannels(repo repository.NotificationRepository, auth *Auth, sessionTTL time.Duration) *Channels {
	return &Channels{repo: repo, auth: auth, sessionTTL: sessionTTL, codeTTL: 10 * time.Minute}
}

func (c *Channels) Settings(ctx context.Context, user string) (domain.NotificationSettings, error) {
	return c.repo.Settings(ctx, user)
}

// UpdateSettings применяет частичное изменение: незаданные поля остаются прежними.
func (c *Channels) UpdateSettings(ctx context.Context, user string, patch map[string]json.RawMessage) (domain.NotificationSettings, error) {
	settings, err := c.repo.Settings(ctx, user)
	if err != nil {
		return settings, err
	}
	fields := map[string]any{
		"digest_enabled": &settings.DigestEnabled, "digest_time": &settings.DigestTime,
		"quiet_enabled": &settings.QuietEnabled, "quiet_start": &settings.QuietStart, "quiet_end": &settings.QuietEnd,
	}
	for name, raw := range patch {
		target, ok := fields[name]
		if !ok {
			return settings, invalid("неизвестное поле " + name)
		}
		if string(raw) == "null" || json.Unmarshal(raw, target) != nil {
			return settings, invalid("неверное значение " + name)
		}
	}
	if err := settings.Validate(); err != nil {
		return settings, invalid(err.Error())
	}
	if err := c.repo.SaveSettings(ctx, user, settings); err != nil {
		return settings, err
	}
	return settings, nil
}

type LinkCode struct {
	Code      string    `json:"code"`
	ExpiresAt time.Time `json:"expires_at"`
}

func (c *Channels) CreateLinkCode(ctx context.Context, user, channel string) (LinkCode, error) {
	if err := checkChannel(channel); err != nil {
		return LinkCode{}, err
	}
	raw := make([]byte, 10)
	if _, err := rand.Read(raw); err != nil {
		return LinkCode{}, err
	}
	code := LinkCode{Code: hex.EncodeToString(raw), ExpiresAt: time.Now().UTC().Add(c.codeTTL)}
	return code, c.repo.CreateLinkCode(ctx, channel, user, code.Code, code.ExpiresAt)
}

// LinkRequest — привязка от бота: по одноразовому коду с сайта или по логину и паролю.
type LinkRequest struct {
	ExternalID string `json:"external_id"`
	Code       string `json:"code"`
	Login      string `json:"login"`
	Password   string `json:"password"`
}

// Link возвращает долгоживущий токен, с которым бот работает от имени пользователя.
func (c *Channels) Link(ctx context.Context, channel string, req LinkRequest) (LoginResult, error) {
	if err := checkChannel(channel); err != nil {
		return LoginResult{}, err
	}
	if err := checkExternalID(req.ExternalID); err != nil {
		return LoginResult{}, err
	}
	var user domain.User
	switch {
	case req.Code != "" && req.Login == "":
		id, err := c.repo.ConsumeLinkCode(ctx, channel, strings.ToLower(strings.TrimSpace(req.Code)))
		if err != nil {
			return LoginResult{}, err
		}
		if user, err = c.auth.User(ctx, id); err != nil {
			return LoginResult{}, repository.ErrLinkCode
		}
	case req.Code == "" && req.Login != "":
		var err error
		if user, err = c.auth.Verify(ctx, req.Login, req.Password, channel+":"+req.ExternalID); err != nil {
			return LoginResult{}, err
		}
	default:
		return LoginResult{}, invalid("нужен code или login и password")
	}
	result, err := c.auth.Issue(ctx, user, c.sessionTTL)
	if err != nil {
		return LoginResult{}, err
	}
	key := SessionKey(result.Token)
	previous, err := c.repo.LinkChannel(ctx, domain.Channel{Channel: channel, ExternalID: req.ExternalID, UserID: user.ID, SessionKey: &key})
	if err != nil {
		_ = c.auth.Logout(ctx, key)
		return LoginResult{}, err
	}
	if previous != nil && *previous != key {
		_ = c.auth.Logout(ctx, *previous)
	}
	return result, nil
}

type ChannelState struct {
	Linked   bool   `json:"linked"`
	Enabled  bool   `json:"enabled"`
	UserID   string `json:"user_id,omitempty"`
	Login    string `json:"login,omitempty"`
	Timezone string `json:"timezone,omitempty"`
}

func (c *Channels) State(ctx context.Context, channel, externalID string) (ChannelState, error) {
	if err := checkChannel(channel); err != nil {
		return ChannelState{}, err
	}
	link, err := c.repo.Channel(ctx, channel, externalID)
	if errors.Is(err, repository.ErrNotFound) {
		return ChannelState{}, nil
	}
	if err != nil {
		return ChannelState{}, err
	}
	user, err := c.auth.User(ctx, link.UserID)
	if err != nil {
		return ChannelState{}, nil
	}
	return ChannelState{Linked: true, Enabled: link.Enabled, UserID: user.ID, Login: user.Login, Timezone: user.Timezone}, nil
}

func (c *Channels) SetEnabled(ctx context.Context, channel, externalID string, enabled bool) error {
	if err := checkChannel(channel); err != nil {
		return err
	}
	return c.repo.SetChannelEnabled(ctx, channel, externalID, enabled)
}

func (c *Channels) Unlink(ctx context.Context, channel, externalID string) error {
	if err := checkChannel(channel); err != nil {
		return err
	}
	key, err := c.repo.UnlinkChannel(ctx, channel, externalID)
	if err != nil {
		return err
	}
	if key != nil {
		return c.auth.Logout(ctx, *key)
	}
	return nil
}

func (c *Channels) UserChannels(ctx context.Context, user string) ([]domain.Channel, error) {
	return c.repo.UserChannels(ctx, user)
}

// AckRequest — итог доставки от бота. DisableChannel — пользователь заблокировал бота.
type AckRequest struct {
	Status         string `json:"status"`
	Error          string `json:"error"`
	Channel        string `json:"channel"`
	ExternalID     string `json:"external_id"`
	DisableChannel bool   `json:"disable_channel"`
}

func (c *Channels) Ack(ctx context.Context, id string, req AckRequest) error {
	if _, err := uuid.Parse(id); err != nil {
		return invalid("неверный id уведомления")
	}
	if req.Status != "sent" && req.Status != "failed" {
		return invalid("status должен быть sent или failed")
	}
	if err := c.repo.Ack(ctx, id, req.Status == "sent", req.Error); err != nil {
		return err
	}
	if req.DisableChannel {
		if err := c.SetEnabled(ctx, req.Channel, req.ExternalID, false); err != nil && !errors.Is(err, repository.ErrNotFound) {
			return err
		}
	}
	return nil
}

// NotificationMoment — момент, о котором уведомляем (повторяет item_notification_moment в БД).
func NotificationMoment(item domain.Item) *time.Time {
	switch {
	case item.DeletedAt != nil:
		return nil
	case item.Type == domain.ItemReminder && item.Status == domain.StatusOpen:
		return item.RemindAt
	case item.Type == domain.ItemMeeting && item.Status == domain.StatusScheduled && !item.AllDay:
		return item.StartAt
	}
	return nil
}

// Publisher отправляет доставку в поток канала.
type Publisher interface {
	PublishNotification(ctx context.Context, channel string, payload []byte) error
}

// Dispatcher раз в Interval ставит наступившие уведомления в очереди ботов и планирует сводки.
type Dispatcher struct {
	Repo      repository.NotificationRepository
	Items     repository.ItemRepository
	Publisher Publisher
	Logger    *slog.Logger
	Interval  time.Duration
	// Через сколько неподтверждённое уведомление снова считается неотправленным
	AckTimeout time.Duration
	Now        func() time.Time
}

func (d *Dispatcher) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

// Start запускает цикл и возвращает функцию ожидания его остановки.
func (d *Dispatcher) Start(ctx context.Context) func() {
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(d.Interval)
		defer ticker.Stop()
		for {
			if err := d.Tick(ctx); err != nil && ctx.Err() == nil {
				d.Logger.Error("notification dispatch", "error", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return func() { <-done }
}

// Tick — один проход: возврат зависших, сводки, наступившие уведомления.
func (d *Dispatcher) Tick(ctx context.Context) error {
	if n, err := d.Repo.RequeueStale(ctx, d.AckTimeout); err != nil {
		return fmt.Errorf("requeue: %w", err)
	} else if n > 0 {
		d.Logger.Warn("notifications requeued without ack", "count", n)
	}
	if err := d.planDigests(ctx); err != nil {
		return fmt.Errorf("plan digests: %w", err)
	}
	for {
		due, err := d.Repo.ClaimDue(ctx, 100)
		if err != nil {
			return fmt.Errorf("claim: %w", err)
		}
		for _, n := range due {
			if err := d.process(ctx, n); err != nil {
				d.Logger.Error("notification failed", "id", n.ID, "error", err)
				_ = d.Repo.Release(ctx, n.ID)
			}
		}
		if len(due) < 100 {
			return nil
		}
	}
}

func location(name string) *time.Location {
	if loc, err := time.LoadLocation(name); err == nil {
		return loc
	}
	loc, _ := time.LoadLocation("Europe/Moscow")
	return loc
}

func (d *Dispatcher) planDigests(ctx context.Context) error {
	candidates, err := d.Repo.DigestCandidates(ctx)
	if err != nil {
		return err
	}
	now := d.now()
	for _, c := range candidates {
		moment, day, ok := c.Settings.DigestDue(now, location(c.Timezone), c.PlannedOn)
		if !ok {
			continue
		}
		if _, err := d.Repo.PlanDigest(ctx, c.UserID, day, moment); err != nil {
			return err
		}
	}
	return nil
}

func (d *Dispatcher) process(ctx context.Context, n repository.DueNotification) error {
	if len(n.Channels) == 0 {
		return d.Repo.Skip(ctx, n.ID)
	}
	now := d.now()
	loc := location(n.Timezone)
	delivery := domain.Delivery{Version: 1, ID: n.ID, Kind: n.Kind, UserID: n.UserID, Timezone: loc.String(), EventAt: n.EventAt, Held: n.Held}
	if n.Kind == domain.NotifyDigest {
		local := n.EventAt.In(loc)
		start := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)
		end := start.AddDate(0, 0, 1)
		items, err := d.Items.List(ctx, n.UserID, repository.ItemFilter{From: &start, To: &end, Types: []domain.ItemType{domain.ItemMeeting, domain.ItemReminder}, Timezone: loc.String(), Limit: 100})
		if err != nil {
			return err
		}
		delivery.Items = []domain.Item{}
		for _, item := range items {
			if item.Status == domain.StatusScheduled || item.Status == domain.StatusOpen {
				delivery.Items = append(delivery.Items, item)
			}
		}
		delivery.Day = start.Format("2006-01-02")
	} else {
		if n.ItemID == nil {
			return d.Repo.Cancel(ctx, n.ID)
		}
		item, err := d.Items.GetByID(ctx, n.UserID, *n.ItemID)
		if errors.Is(err, repository.ErrNotFound) {
			return d.Repo.Cancel(ctx, n.ID)
		}
		if err != nil {
			return err
		}
		// Запись могли изменить после постановки в расписание: триггер уже создал новую строку
		moment := NotificationMoment(item)
		if moment == nil || !moment.Equal(n.EventAt) || (n.Kind == domain.NotifySoon && !now.Before(n.EventAt)) {
			return d.Repo.Cancel(ctx, n.ID)
		}
		delivery.Item = &item
	}
	if until := n.Settings.QuietUntil(now, loc); !until.IsZero() {
		// «Скоро» о событии, которое начнётся до конца тихих часов, не нужно: придёт «началось»
		if n.Kind == domain.NotifySoon && !until.Before(n.EventAt) {
			return d.Repo.Cancel(ctx, n.ID)
		}
		return d.Repo.Hold(ctx, n.ID, until)
	}
	for _, channel := range n.Channels {
		delivery.Channel, delivery.ExternalID = channel.Channel, channel.ExternalID
		payload, err := json.Marshal(delivery)
		if err != nil {
			return err
		}
		if err := d.Publisher.PublishNotification(ctx, channel.Channel, payload); err != nil {
			return err
		}
	}
	return nil
}
