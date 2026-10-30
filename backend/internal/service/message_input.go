package service

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorky/backend/internal/domain"
	"gorky/backend/internal/repository"
)

func (s *Messages) Answer(ctx context.Context, user, id string, answer domain.MessageAnswer) (domain.Message, error) {
	if _, err := uuid.Parse(id); err != nil {
		return domain.Message{}, invalid("неверный message_id")
	}
	if _, err := uuid.Parse(answer.InputToken); err != nil {
		return domain.Message{}, invalid("нужен корректный input_token из ответа сервера")
	}
	if answer.Text != nil && (strings.TrimSpace(*answer.Text) == "" || len(*answer.Text) > 256) {
		return domain.Message{}, invalid("неверный текст выбора")
	}
	if answer.OptionID != nil && (strings.TrimSpace(*answer.OptionID) == "" || len(*answer.OptionID) > 128) {
		return domain.Message{}, invalid("неверный option_id")
	}
	if answer.Date != nil {
		if _, err := time.Parse(time.DateOnly, *answer.Date); err != nil {
			return domain.Message{}, invalid("date должна быть в формате YYYY-MM-DD")
		}
	}
	if answer.Time != nil {
		if _, err := time.Parse("15:04", *answer.Time); err != nil {
			return domain.Message{}, invalid("time должно быть в формате HH:MM")
		}
	}
	if answer.Title != nil && (strings.TrimSpace(*answer.Title) == "" || len(*answer.Title) > 1000) {
		return domain.Message{}, invalid("title обязателен, максимум 1000 байт")
	}
	if answer.DurationMin != nil && (*answer.DurationMin <= 0 || *answer.DurationMin > 10080) {
		return domain.Message{}, invalid("неверная длительность")
	}
	return s.repo.Answer(ctx, user, id, answer, func(ctx context.Context, items repository.ItemRepository, m domain.Message, state domain.DialogueState) (domain.Reply, domain.DialogueState, error) {
		if state.Draft == nil || state.Expects == nil {
			return domain.Reply{}, state, repository.ErrMessageState
		}
		if state.Draft.Mutation != nil {
			m.ModelRequest.Now = time.Now().In(m.ModelRequest.Now.Location())
			var reply domain.Reply
			var next domain.DialogueState
			token, err := items.WithUndo(ctx, user, func(locked repository.ItemRepository) error {
				var err error
				reply, next, err = continueMutation(ctx, locked, m, state, answer)
				return err
			})
			if err == nil {
				reply.UndoToken = token
			}
			return reply, next, err
		}
		if answer.OptionID != nil || answer.Text != nil {
			return domain.Reply{}, state, invalid("сейчас выбор записи не ожидается")
		}
		var value json.RawMessage
		if m.Status == "awaiting_confirmation" {
			if answer.Confirmed == nil || answer.Date != nil || answer.Time != nil || answer.Title != nil || answer.DurationMin != nil {
				return domain.Reply{}, state, invalid("для подтверждения передайте только confirmed и input_token")
			}
			value, _ = json.Marshal(*answer.Confirmed)
			text := "нет"
			if *answer.Confirmed {
				text = "да"
			}
			m.Request.Text = &text
			m.Request.Choice = nil
		} else {
			if answer.Confirmed != nil {
				return domain.Reply{}, state, invalid("сейчас ожидаются поля записи, а не подтверждение")
			}
			provided := map[string]bool{"date": answer.Date != nil, "time": answer.Time != nil, "title": answer.Title != nil, "datetime": answer.Date != nil && answer.Time != nil}
			if !provided[*state.Expects] {
				return domain.Reply{}, state, invalid("нужно заполнить поле " + *state.Expects)
			}
			patch := map[string]any{}
			if answer.Date != nil {
				patch["date"] = *answer.Date
			}
			if answer.Time != nil {
				patch["time"] = *answer.Time
			}
			if answer.Title != nil {
				patch["title"] = *answer.Title
			}
			if answer.DurationMin != nil {
				patch["duration_min"] = *answer.DurationMin
			}
			value, _ = json.Marshal(patch)
			var merged map[string]json.RawMessage
			if err := json.Unmarshal(state.Draft.Params, &merged); err != nil {
				return domain.Reply{}, state, err
			}
			for key, v := range patch {
				merged[key], _ = json.Marshal(v)
			}
			encoded, _ := json.Marshal(merged)
			var p params
			if err := json.Unmarshal(encoded, &p); err != nil {
				return domain.Reply{}, state, invalid("неверные поля уточнения")
			}
			if _, _, err := normalize(state.Draft.Intent, p, m); err != nil {
				return domain.Reply{}, state, err
			}
		}
		m.ModelRequest.Now = time.Now().In(m.ModelRequest.Now.Location())
		payload, _ := json.Marshal(map[string]any{"value": value})
		return execute(ctx, items, m, state, domain.ModelResult{Status: "ready", Actions: []domain.Action{{Intent: "answer", Params: payload}}})
	})
}

func (s *Messages) Cancel(ctx context.Context, user, id string) (domain.Message, error) {
	if _, err := uuid.Parse(id); err != nil {
		return domain.Message{}, invalid("неверный message_id")
	}
	return s.repo.Cancel(ctx, user, id)
}
