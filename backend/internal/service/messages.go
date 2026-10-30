package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorky/backend/internal/domain"
	"gorky/backend/internal/repository"
)

type Messages struct {
	repo    repository.MessageRepository
	timeout time.Duration
}

func NewMessages(repo repository.MessageRepository, timeout time.Duration) *Messages {
	return &Messages{repo: repo, timeout: timeout}
}

func (s *Messages) Submit(ctx context.Context, user string, req domain.MessageRequest) (domain.Message, error) {
	if strings.TrimSpace(req.ClientMessageID) == "" || len(req.ClientMessageID) > 128 || strings.TrimSpace(req.SessionID) == "" || len(req.SessionID) > 128 {
		return domain.Message{}, invalid("нужны client_message_id и session_id длиной до 128 байт")
	}
	if req.Input != "text" && req.Input != "voice" {
		return domain.Message{}, invalid("input должен быть text или voice")
	}
	if (req.Text == nil || strings.TrimSpace(*req.Text) == "") && req.Choice == nil {
		return domain.Message{}, invalid("нужен text или choice")
	}
	if req.Text != nil && len(*req.Text) > 16000 {
		return domain.Message{}, invalid("text слишком длинный")
	}
	if req.Choice != nil && req.Text != nil && strings.TrimSpace(*req.Text) != "" {
		return domain.Message{}, invalid("передайте text или choice, не оба сразу")
	}
	if req.Choice != nil && (strings.TrimSpace(req.Choice.OptionID) == "" || len(req.Choice.OptionID) > 128) {
		return domain.Message{}, invalid("неверный choice.option_id")
	}
	if req.Context.SelectedItemID != nil {
		if _, err := uuid.Parse(*req.Context.SelectedItemID); err != nil {
			return domain.Message{}, invalid("неверный selected_item_id")
		}
	}
	if req.Timezone == "" {
		req.Timezone = "Europe/Moscow"
	}
	location, err := time.LoadLocation(req.Timezone)
	if err != nil {
		return domain.Message{}, invalid("неверный часовой пояс")
	}
	return s.repo.Submit(ctx, user, req, s.timeout, func(ctx context.Context, items repository.ItemRepository, state *domain.DialogueState) (domain.ModelRequest, error) {
		now := time.Now().In(location)
		if state.Draft != nil && !now.Before(state.Draft.ExpiresAt) {
			state.Draft = nil
			state.Expects = nil
		}
		if req.Context.SelectedItemID != nil {
			item, err := items.GetByID(ctx, user, *req.Context.SelectedItemID)
			if err != nil {
				return domain.ModelRequest{}, err
			}
			state.Focus = &item
		}
		text := ""
		if req.Text != nil {
			text = *req.Text
		}
		return domain.ModelRequest{Text: text, Choice: req.Choice, Now: now, Timezone: req.Timezone, Anchors: anchors(now), History: state.History, Expects: state.Expects, Draft: state.Draft, Focus: state.Focus, Candidates: state.Candidates}, nil
	})
}

func (s *Messages) Get(ctx context.Context, user, id string) (domain.Message, error) {
	if _, err := uuid.Parse(id); err != nil {
		return domain.Message{}, invalid("неверный message_id")
	}
	return s.repo.GetMessage(ctx, user, id)
}

func (s *Messages) History(ctx context.Context, user, session string) ([]domain.Message, error) {
	if strings.TrimSpace(session) == "" {
		return nil, invalid("нужен session_id")
	}
	return s.repo.History(ctx, user, session)
}

func (s *Messages) HandleResult(ctx context.Context, envelope domain.ResultEnvelope) error {
	var result domain.ModelResult
	bad := envelope.Version != 1 || json.Unmarshal(envelope.Result, &result) != nil || !validResult(result)
	err := s.repo.Apply(ctx, envelope, bad && envelope.Error == nil, func(ctx context.Context, items repository.ItemRepository, m domain.Message, state domain.DialogueState) (domain.Reply, domain.DialogueState, error) {
		if envelope.Error != nil {
			return domain.ErrorReply("llm_unavailable", "Модель сейчас недоступна. Попробуйте ещё раз."), state, nil
		}
		if bad {
			return domain.ErrorReply("llm_bad_output", "Не получилось разобрать ответ модели. Попробуйте ещё раз."), state, nil
		}
		return execute(ctx, items, m, state, result)
	})
	if err != nil && ctx.Err() == nil {
		// Исходная транзакция уже отменена; сохраняем ошибку отдельной транзакцией.
		markErr := s.repo.Apply(ctx, envelope, false, func(_ context.Context, _ repository.ItemRepository, _ domain.Message, state domain.DialogueState) (domain.Reply, domain.DialogueState, error) {
			return domain.ErrorReply("db_error", "Не получилось сохранить или прочитать данные. Попробуйте ещё раз."), state, nil
		})
		if markErr != nil {
			return errors.Join(err, markErr)
		}
		return nil
	}
	return err
}

func validResult(r domain.ModelResult) bool {
	if r.Status == "not_understood" {
		return len(r.Actions) == 0
	}
	if r.Status != "ready" && r.Status != "needs_clarification" {
		return false
	}
	if len(r.Actions) == 0 || len(r.Actions) > 20 {
		return false
	}
	for _, a := range r.Actions {
		if a.Intent == "" || len(a.Params) == 0 || a.Params[0] != '{' || !json.Valid(a.Params) {
			return false
		}
		if len(r.Actions) > 1 && !strings.HasPrefix(a.Intent, "create_") {
			return false
		}
		var p params
		if json.Unmarshal(a.Params, &p) != nil {
			return false
		}
	}
	return true
}
