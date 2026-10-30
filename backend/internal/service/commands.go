package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"gorky/backend/internal/domain"
	"gorky/backend/internal/repository"
	"strings"
	"time"
)

type params struct {
	Title           string             `json:"title"`
	Date            string             `json:"date"`
	Time            string             `json:"time"`
	EndTime         string             `json:"end_time"`
	DurationMin     *int               `json:"duration_min"`
	AllDay          bool               `json:"all_day"`
	Participants    []string           `json:"participants"`
	Location        *string            `json:"location"`
	RemindBeforeMin *int               `json:"remind_before_min"`
	Period          json.RawMessage    `json:"period"`
	Recurrence      json.RawMessage    `json:"recurrence"`
	ForMeeting      json.RawMessage    `json:"for_meeting"`
	From            *time.Time         `json:"from"`
	To              *time.Time         `json:"to"`
	Types           []domain.ItemType  `json:"types"`
	Status          *domain.ItemStatus `json:"status"`
	Kind            string             `json:"kind"`
	YesNo           bool               `json:"yes_no"`
	Query           string             `json:"query"`
	Participant     string             `json:"participant"`
	Direction       string             `json:"direction"`
	Value           json.RawMessage    `json:"value"`
}

func execute(ctx context.Context, repo repository.ItemRepository, m domain.Message, state domain.DialogueState, result domain.ModelResult) (domain.Reply, domain.DialogueState, error) {
	confirmed := false
	progress := false
	if result.Status == "not_understood" {
		state.Draft = nil
		state.Expects = nil
		return domain.NewReply("info", "Не понял запрос. Например: «Что у меня завтра?».", map[string]any{"reason": "out_of_scope"}), state, nil
	}
	if result.Actions[0].Intent == "cancel" {
		state.Draft = nil
		state.Expects = nil
		return domain.NewReply("info", "Хорошо, не добавляю.", map[string]any{"reason": "cancelled"}), state, nil
	}
	if len(result.Actions) == 1 && result.Actions[0].Intent == "answer" {
		if state.Draft == nil || !m.ModelRequest.Now.Before(state.Draft.ExpiresAt) {
			state.Draft = nil
			state.Expects = nil
			return domain.NewReply("info", "Нет незавершённого действия. Скажите запрос полностью.", map[string]any{"reason": "draft_dropped"}), state, nil
		}
		m.ModelRequest.Text = state.Draft.SourceText
		if len(state.Draft.PendingActions) > 0 {
			var p params
			if json.Unmarshal(result.Actions[0].Params, &p) != nil {
				return clarifyAgain(state)
			}
			var yes bool
			if json.Unmarshal(p.Value, &yes) != nil {
				return clarifyAgain(state)
			}
			text := ""
			if m.Request.Text != nil {
				text = strings.ToLower(strings.Trim(strings.TrimSpace(*m.Request.Text), ".!?"))
			}
			allowedYes := map[string]bool{"да": true, "ок": true, "давай": true, "угу": true, "конечно": true, "верно": true, "подтверждаю": true}
			allowedNo := map[string]bool{"нет": true, "не надо": true, "отмена": true, "не": true}
			if m.Request.Choice != nil {
				text = m.Request.Choice.OptionID
				allowedYes["yes"] = true
				allowedNo["no"] = true
			}
			if (!yes || !allowedYes[text]) && !allowedNo[text] {
				return clarifyAgain(state)
			}
			if allowedNo[text] {
				state.Draft = nil
				state.Expects = nil
				return domain.NewReply("info", "Хорошо, не добавляю.", map[string]any{"reason": "cancelled"}), state, nil
			}
			result.Actions = state.Draft.PendingActions
			result.Status = "ready"
			confirmed = true
		} else {
			var p params
			if err := json.Unmarshal(result.Actions[0].Params, &p); err != nil {
				return domain.ErrorReply("llm_bad_output", "Неверный ответ модели."), state, nil
			}
			var original, patch map[string]json.RawMessage
			if json.Unmarshal(state.Draft.Action.Params, &original) != nil || json.Unmarshal(p.Value, &patch) != nil {
				return clarifyAgain(state)
			}
			for key, value := range patch {
				if key != "date" && key != "time" && key != "title" && key != "duration_min" {
					continue
				}
				original[key] = value
				progress = true
			}
			raw, _ := json.Marshal(original)
			result.Actions = []domain.Action{{Intent: state.Draft.Action.Intent, Params: raw}}
			result.Status = "ready"
		}
	} else if state.Draft != nil {
		state.Draft = nil
		state.Expects = nil
	}
	var created []domain.Item
	for _, action := range result.Actions {
		var p params
		if err := json.Unmarshal(action.Params, &p); err != nil {
			return domain.ErrorReply("llm_bad_output", "Неверные параметры команды."), state, nil
		}
		switch action.Intent {
		case "create_task", "create_reminder", "create_meeting":
			item, missing, err := normalize(action.Intent, p, m)
			if err != nil {
				return domain.ErrorReply("llm_bad_output", err.Error()), state, nil
			}
			if len(missing) > 0 || result.Status == "needs_clarification" {
				if len(result.Actions) != 1 {
					return domain.ErrorReply("llm_bad_output", "Для составной команды нужны все обязательные поля."), state, nil
				}
				if len(missing) == 0 {
					missing = result.Missing
				}
				if len(missing) == 0 {
					return domain.ErrorReply("llm_bad_output", "Не указано недостающее поле."), state, nil
				}
				attempt := 0
				if state.Draft != nil {
					attempt = state.Draft.Attempt
					if !progress {
						attempt++
					}
				}
				if attempt >= 2 {
					state.Draft = nil
					state.Expects = nil
					return domain.NewReply("info", "Не получилось уточнить запрос. Скажите его полностью.", map[string]any{"reason": "draft_dropped"}), state, nil
				}
				state.Draft = &domain.Draft{Action: action, SourceText: m.ModelRequest.Text, Missing: missing, Attempt: attempt, ExpiresAt: m.ModelRequest.Now.Add(10 * time.Minute)}
				state.Expects = &missing[0]
				question := map[string]string{"time": "На какое время?", "date": "На какую дату?", "title": "Что нужно добавить?"}[missing[0]]
				if question == "" {
					question = "Уточните дату и время."
				}
				return domain.NewReply("clarify", question, map[string]any{"expects": missing[0], "draft": state.Draft, "attempt": attempt + 1}), state, nil
			}
			created = append(created, item)
		case "list", "search":
			if len(result.Actions) != 1 {
				return domain.ErrorReply("llm_bad_output", "Выполняйте команды по очереди."), state, nil
			}
			f := repository.ItemFilter{From: p.From, To: p.To, Types: p.Types, Status: p.Status, Timezone: m.ModelRequest.Timezone, Query: p.Query, Participant: p.Participant, Limit: 100}
			if action.Intent == "list" && (p.From == nil || p.To == nil) {
				return domain.ErrorReply("llm_bad_output", "Для списка нужен период."), state, nil
			}
			if action.Intent == "search" && p.Query == "" && p.Participant == "" {
				return domain.ErrorReply("llm_bad_output", "Не указана тема поиска."), state, nil
			}
			if p.Direction == "past" {
				t := m.ModelRequest.Now
				f.To = &t
			} else if p.Direction == "future" {
				t := m.ModelRequest.Now
				f.From = &t
			}
			items, err := NewItems(repo).List(ctx, m.UserID, f)
			if err != nil {
				if errors.Is(err, ErrInvalid) {
					return domain.ErrorReply("llm_bad_output", "Неверные параметры поиска или периода."), state, nil
				}
				return domain.Reply{}, state, err
			}
			total, err := repo.Count(ctx, m.UserID, f)
			if err != nil {
				return domain.Reply{}, state, err
			}
			limit := 10
			if action.Intent == "search" {
				limit = 5
			}
			if len(items) > limit {
				items = items[:limit]
			}
			text := fmt.Sprintf("Найдено записей: %d.", total)
			if total == 0 {
				text = "Записей не найдено."
			}
			data := map[string]any{"kind": action.Intent, "from": f.From, "to": f.To, "types": f.Types, "total": total, "shown": len(items), "overdue": []domain.Item{}, "answer": nil, "query": p.Query, "semantic": false}
			if p.YesNo {
				data["answer"] = total > 0
				if total > 0 {
					text = "Да, есть записи."
				} else {
					text = "Нет, записей нет."
				}
			}
			if action.Intent == "search" {
				text += " Искал только по точным словам."
			}
			reply := domain.NewReply("results", text, data)
			reply.Items = items
			state.Candidates = items
			if len(items) == 1 {
				state.Focus = &items[0]
			}
			state.Draft = nil
			state.Expects = nil
			return reply, state, nil
		case "help", "unknown":
			return domain.NewReply("info", "Я помогаю создавать задачи, напоминания и встречи, показывать планы и искать записи.", map[string]any{"reason": "help"}), state, nil
		default:
			return domain.NewReply("info", "Это действие пока не поддерживается.", map[string]any{"reason": "out_of_scope"}), state, nil
		}
	}
	if !confirmed && len(created) > 0 {
		past := false
		proposal := m.ModelRequest.Now.AddDate(0, 0, 1).Format(time.DateOnly)
		for i, item := range created {
			at := item.DueAt
			if item.Type == domain.ItemMeeting {
				at = item.StartAt
			} else if item.Type == domain.ItemReminder {
				at = item.RemindAt
			}
			if (at != nil && at.Before(m.ModelRequest.Now)) || (item.DueDate != nil && string(*item.DueDate) < m.ModelRequest.Now.Format(time.DateOnly)) {
				past = true
				var fields map[string]json.RawMessage
				_ = json.Unmarshal(result.Actions[i].Params, &fields)
				fields["date"], _ = json.Marshal(proposal)
				result.Actions[i].Params, _ = json.Marshal(fields)
			}
		}
		if past {
			return confirmation(state, m, result.Actions, "Указанное время уже прошло. Перенести прошедшие сроки на завтра, "+proposal+"?")
		}
		for _, item := range created {
			found, err := repo.List(ctx, m.UserID, repository.ItemFilter{Query: item.Title, Timezone: m.ModelRequest.Timezone, Limit: 100})
			if err != nil {
				return domain.Reply{}, state, err
			}
			for _, existing := range found {
				if existing.Type == item.Type && (existing.Status == domain.StatusOpen || existing.Status == domain.StatusScheduled) && strings.EqualFold(existing.Title, item.Title) && itemDay(existing, m.ModelRequest.Timezone) == itemDay(item, m.ModelRequest.Timezone) {
					return confirmation(state, m, result.Actions, "У вас уже есть похожая запись «"+item.Title+"». Добавить ещё?")
				}
			}
		}
	}
	// Сначала проверяются все команды, затем все записи сохраняются в общей транзакции.
	items := []domain.Item{}
	actions := []map[string]any{}
	for _, item := range created {
		saved, err := NewItems(repo).Create(ctx, m.UserID, item)
		if err != nil {
			return domain.Reply{}, state, err
		}
		saved = present(saved, m.ModelRequest.Timezone, time.Now())
		items = append(items, saved)
		actions = append(actions, map[string]any{"action": "created", "item_id": saved.ID})
	}
	text := fmt.Sprintf("Добавил записей: %d.", len(items))
	if len(items) == 1 {
		text = describe(items[0], m.ModelRequest.Timezone)
		state.Focus = &items[0]
	}
	reply := domain.NewReply("done", text, map[string]any{"actions": actions})
	reply.Items = items
	state.Draft = nil
	state.Expects = nil
	return reply, state, nil
}

func confirmation(state domain.DialogueState, m domain.Message, actions []domain.Action, text string) (domain.Reply, domain.DialogueState, error) {
	expects := "yes_no"
	state.Expects = &expects
	state.Draft = &domain.Draft{Action: actions[0], SourceText: m.ModelRequest.Text, PendingActions: actions, Missing: []string{"yes_no"}, ExpiresAt: m.ModelRequest.Now.Add(10 * time.Minute)}
	reply := domain.NewReply("confirm", text, map[string]any{"pending_intent": "create", "count": len(actions)})
	reply.Options = []domain.Option{{ID: "yes", Label: "Да"}, {ID: "no", Label: "Нет"}}
	return reply, state, nil
}

func itemDay(item domain.Item, timezone string) string {
	loc, _ := time.LoadLocation(timezone)
	if item.DueDate != nil {
		return string(*item.DueDate)
	}
	for _, at := range []*time.Time{item.StartAt, item.RemindAt, item.DueAt, item.PeriodEnd} {
		if at != nil {
			return at.In(loc).Format(time.DateOnly)
		}
	}
	return ""
}

func describe(item domain.Item, timezone string) string {
	loc, _ := time.LoadLocation(timezone)
	label := map[domain.ItemType]string{domain.ItemTask: "задачу", domain.ItemReminder: "напоминание", domain.ItemMeeting: "встречу"}[item.Type]
	text := "Добавил " + label + ": " + item.Title
	for _, at := range []*time.Time{item.StartAt, item.RemindAt, item.DueAt} {
		if at != nil {
			return text + ", " + at.In(loc).Format("02.01.2006 15:04") + "."
		}
	}
	if item.DueDate != nil {
		return text + ", срок " + string(*item.DueDate) + "."
	}
	if item.PeriodEnd != nil {
		return text + ", срок до " + item.PeriodEnd.In(loc).Format("02.01.2006 15:04") + "."
	}
	return text + ", без срока."
}

func clarifyAgain(state domain.DialogueState) (domain.Reply, domain.DialogueState, error) {
	state.Draft.Attempt++
	if state.Draft.Attempt >= 2 {
		state.Draft = nil
		state.Expects = nil
		return domain.NewReply("info", "Не получилось уточнить запрос. Скажите его полностью.", map[string]any{"reason": "draft_dropped"}), state, nil
	}
	return domain.NewReply("clarify", "Уточните, пожалуйста, дату или время.", map[string]any{"expects": state.Expects, "attempt": state.Draft.Attempt + 1}), state, nil
}
