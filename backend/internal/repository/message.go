package repository

import (
	"context"
	"errors"
	"time"

	"gorky/backend/internal/domain"
)

var (
	ErrBusy                = errors.New("conversation is processing another message")
	ErrIdempotencyConflict = errors.New("client_message_id already used for another request")
)

// Выполнение команды, состояние диалога и ответ сохраняются одной транзакцией.
type Executor func(context.Context, ItemRepository, domain.Message, domain.DialogueState) (domain.Reply, domain.DialogueState, error)
type Prepare func(context.Context, ItemRepository, *domain.DialogueState) (domain.ModelRequest, error)

type MessageRepository interface {
	Submit(context.Context, string, domain.MessageRequest, time.Duration, Prepare) (domain.Message, error)
	GetMessage(context.Context, string, string) (domain.Message, error)
	Apply(context.Context, domain.ResultEnvelope, bool, Executor) error
	PublishPending(context.Context, func(context.Context, domain.Job) error) error
	Expire(context.Context) error
	History(context.Context, string, string) ([]domain.Message, error)
}
