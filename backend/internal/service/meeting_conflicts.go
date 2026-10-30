package service

import (
	"context"
	"encoding/json"
	"fmt"
	"gorky/backend/internal/domain"
	"strings"
	"time"
)

type MeetingConflictError struct{ Conflicts []domain.Item }

func (e *MeetingConflictError) Error() string {
	return "Время пересекается с другими встречами."
}

// SaveOptions задаётся клиентом явно после показа предупреждения.
type SaveOptions struct{ AllowConflicts bool }

func (s *Items) checkMeeting(ctx context.Context, item domain.Item, allow bool) error {
	if item.Type != domain.ItemMeeting || item.Status != domain.StatusScheduled || allow {
		return nil
	}
	found, err := s.repo.MeetingConflicts(ctx, item)
	if err != nil {
		return err
	}
	if len(found) > 0 {
		return &MeetingConflictError{Conflicts: found}
	}
	return nil
}

func meetingsOverlap(a, b domain.Item) bool {
	return a.Type == domain.ItemMeeting && b.Type == domain.ItemMeeting &&
		a.StartAt != nil && a.EndAt != nil && b.StartAt != nil && b.EndAt != nil &&
		a.StartAt.Before(*b.EndAt) && b.StartAt.Before(*a.EndAt)
}

// rescheduleConflict оставляет всю составную команду в черновике и уточняет одну встречу.
func rescheduleConflict(state domain.DialogueState, m domain.Message) (domain.Reply, domain.DialogueState, error) {
	draft := state.Draft
	index := draft.ConflictActionIndex
	if index < 0 || index >= len(draft.PendingActions) {
		return domain.Reply{}, state, invalid("неверный черновик конфликта")
	}
	action := draft.PendingActions[index]
	var p params
	if err := json.Unmarshal(action.Params, &p); err != nil {
		return domain.Reply{}, state, err
	}
	item, missing, err := normalize(action.Intent, p, m)
	if err != nil {
		return domain.Reply{}, state, err
	}
	if item.Type != domain.ItemMeeting || len(missing) > 0 {
		return domain.Reply{}, state, invalid("неверный черновик встречи")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(action.Params, &fields); err != nil {
		return domain.Reply{}, state, err
	}
	loc, err := time.LoadLocation(m.ModelRequest.Timezone)
	if err != nil {
		return domain.Reply{}, state, err
	}
	// Фиксируем исходную дату и длительность, включая заданный end_time и значение по умолчанию.
	fields["date"], _ = json.Marshal(item.StartAt.In(loc).Format(time.DateOnly))
	fields["duration_min"], _ = json.Marshal(int(item.EndAt.Sub(*item.StartAt) / time.Minute))
	fields["all_day"] = json.RawMessage("false")
	delete(fields, "time")
	delete(fields, "end_time")
	action.Params, _ = json.Marshal(fields)
	pending := append([]domain.Action(nil), draft.PendingActions...)
	pending[index] = action
	expects := "time"
	state.Draft = &domain.Draft{Action: action, SourceText: draft.SourceText,
		PendingActions: pending, RescheduleIndex: &index, Missing: []string{expects}, ExpiresAt: draft.ExpiresAt}
	state.Expects = &expects
	text := "Хорошо. На какое время поставить?"
	if len(pending) > 1 {
		text = fmt.Sprintf("Хорошо. На какое время поставить встречу «%s»?", item.Title)
	}
	return domain.NewReply("clarify", text, map[string]any{"expects": expects, "draft": state.Draft, "attempt": 1}), state, nil
}

func conflictQuestion(items []domain.Item, timezone string) string {
	loc, err := time.LoadLocation(timezone)
	if err != nil {
		loc = time.UTC
	}
	labels := []string{}
	seen := map[string]bool{}
	for _, item := range items {
		if item.StartAt == nil || item.EndAt == nil {
			continue
		}
		start, end := item.StartAt.In(loc), item.EndAt.In(loc)
		endLabel := end.Format("15:04")
		if start.Format(time.DateOnly) != end.Format(time.DateOnly) {
			endLabel = end.Format("02.01 15:04")
		}
		label := fmt.Sprintf("«%s», %s–%s", item.Title, start.Format("02.01 15:04"), endLabel)
		if !seen[label] {
			labels = append(labels, label)
			seen[label] = true
		}
	}
	if len(labels) == 1 {
		return "В это время уже есть встреча " + labels[0] + ". Всё равно добавить?"
	}
	return "В это время пересекаются встречи: " + strings.Join(labels, "; ") + ". Всё равно добавить?"
}
