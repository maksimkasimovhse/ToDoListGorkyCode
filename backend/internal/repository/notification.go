package repository

import (
	"context"
	"errors"
	"time"

	"gorky/backend/internal/domain"
)

var ErrLinkCode = errors.New("link code is missing, used or expired")

// DigestCandidate — пользователь с включённым каналом, которому может понадобиться сводка.
type DigestCandidate struct {
	UserID    string
	Timezone  string
	Settings  domain.NotificationSettings
	PlannedOn *time.Time
}

// DueNotification — заявленное диспетчером уведомление вместе с данными пользователя.
type DueNotification struct {
	domain.Notification
	Timezone string
	Settings domain.NotificationSettings
	Channels []domain.Channel
}

type NotificationRepository interface {
	Settings(ctx context.Context, userID string) (domain.NotificationSettings, error)
	SaveSettings(ctx context.Context, userID string, settings domain.NotificationSettings) error

	CreateLinkCode(ctx context.Context, channel, userID, code string, expires time.Time) error
	// ConsumeLinkCode возвращает пользователя кода и удаляет код; ErrLinkCode, если код недействителен.
	ConsumeLinkCode(ctx context.Context, channel, code string) (string, error)
	// LinkChannel привязывает внешний аккаунт и возвращает ключ сессии прежней привязки (для отзыва).
	LinkChannel(ctx context.Context, channel domain.Channel) (*string, error)
	Channel(ctx context.Context, channel, externalID string) (domain.Channel, error)
	UserChannels(ctx context.Context, userID string) ([]domain.Channel, error)
	SetChannelEnabled(ctx context.Context, channel, externalID string, enabled bool) error
	UnlinkChannel(ctx context.Context, channel, externalID string) (*string, error)

	RequeueStale(ctx context.Context, olderThan time.Duration) (int64, error)
	DigestCandidates(ctx context.Context) ([]DigestCandidate, error)
	// PlanDigest ставит сводку в расписание и запоминает день; false — уже запланирована.
	PlanDigest(ctx context.Context, userID string, day time.Time, moment time.Time) (bool, error)
	// ClaimDue переводит до limit наступивших уведомлений в queued и возвращает их.
	ClaimDue(ctx context.Context, limit int) ([]DueNotification, error)
	Release(ctx context.Context, id string) error
	Cancel(ctx context.Context, id string) error
	Skip(ctx context.Context, id string) error
	Hold(ctx context.Context, id string, until time.Time) error
	Ack(ctx context.Context, id string, sent bool, reason string) error
}
