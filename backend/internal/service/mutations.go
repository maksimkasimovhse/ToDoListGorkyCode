package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"gorky/backend/internal/domain"
	"gorky/backend/internal/repository"
)

type mutationTarget struct {
	Ref         string             `json:"ref"`
	Numbers     []int              `json:"numbers"`
	Query       string             `json:"query"`
	Participant string             `json:"participant"`
	Types       []domain.ItemType  `json:"types"`
	From        *time.Time         `json:"from"`
	To          *time.Time         `json:"to"`
	Status      *domain.ItemStatus `json:"status"`
	All         bool               `json:"all"`
}
type mutationParams struct {
	Target  mutationTarget  `json:"target"`
	Changes json.RawMessage `json:"changes"`
	Done    *bool           `json:"done"`
}
type itemChanges struct {
	Title              *string  `json:"title"`
	Date               *string  `json:"date"`
	Time               *string  `json:"time"`
	ShiftMin           *int     `json:"shift_min"`
	DurationMin        *int     `json:"duration_min"`
	ClearDue           bool     `json:"clear_due"`
	ParticipantsAdd    []string `json:"participants_add"`
	ParticipantsRemove []string `json:"participants_remove"`
}

func isMutation(intent string) bool {
	return intent == "update" || intent == "complete" || intent == "delete"
}

func startMutation(ctx context.Context, repo repository.ItemRepository, m domain.Message, state domain.DialogueState, action domain.Action) (domain.Reply, domain.DialogueState, error) {
	var p mutationParams
	if err := json.Unmarshal(action.Params, &p); err != nil {
		return domain.ErrorReply("llm_bad_output", "Неверная команда изменения."), state, nil
	}
	if p.Target.All {
		return domain.NewReply("info", "Пока можно изменить только одну запись за раз.", map[string]any{"reason": "out_of_scope"}), state, nil
	}
	if action.Intent == "update" {
		if _, err := decodeChanges(p.Changes); err != nil {
			return domain.ErrorReply("llm_bad_output", err.Error()), state, nil
		}
	}
	if action.Intent == "complete" && p.Done == nil {
		return domain.ErrorReply("llm_bad_output", "Для complete нужно поле done."), state, nil
	}
	svc := NewItems(repo)
	candidates := []domain.Item{}
	total := 0
	switch p.Target.Ref {
	case "focus":
		// Только контекст, переданный Go; произвольный id из ответа ML не используется.
		if m.ModelRequest.Focus != nil {
			item, err := svc.Get(ctx, m.UserID, m.ModelRequest.Focus.ID)
			if err != nil && !errors.Is(err, repository.ErrNotFound) {
				return domain.Reply{}, state, err
			}
			if err == nil {
				candidates = append(candidates, item)
			}
		}
	case "candidate":
		if len(p.Target.Numbers) != 1 || p.Target.Numbers[0] < 1 || p.Target.Numbers[0] > len(m.ModelRequest.Candidates) {
			return domain.ErrorReply("llm_bad_output", "Нужен номер записи из последнего показанного списка."), state, nil
		}
		snapshot := m.ModelRequest.Candidates[p.Target.Numbers[0]-1]
		item, err := svc.Get(ctx, m.UserID, snapshot.ID)
		if err != nil && !errors.Is(err, repository.ErrNotFound) {
			return domain.Reply{}, state, err
		}
		if err == nil {
			candidates = append(candidates, item)
		}
	case "filter":
		// Пустой фильтр не должен автоматически менять случайную единственную запись.
		if strings.TrimSpace(p.Target.Query) == "" && strings.TrimSpace(p.Target.Participant) == "" && len(p.Target.Types) == 0 && p.Target.From == nil && p.Target.To == nil {
			return domain.ErrorReply("llm_bad_output", "Не указано, какую запись изменить."), state, nil
		}
		filter := repository.ItemFilter{Query: p.Target.Query, Participant: p.Target.Participant, Types: p.Target.Types, From: p.Target.From, To: p.Target.To, Status: p.Target.Status, Timezone: m.ModelRequest.Timezone, Limit: 20}
		var err error
		candidates, err = svc.List(ctx, m.UserID, filter)
		if errors.Is(err, ErrInvalid) {
			return domain.ErrorReply("llm_bad_output", err.Error()), state, nil
		}
		if err != nil {
			return domain.Reply{}, state, err
		}
		total, err = repo.Count(ctx, m.UserID, filter)
		if err != nil {
			return domain.Reply{}, state, err
		}
	default:
		return domain.ErrorReply("llm_bad_output", "Неизвестный способ выбора записи."), state, nil
	}
	if len(candidates) == 0 {
		state.Draft = nil
		state.Expects = nil
		return domain.NewReply("info", "Подходящая запись не найдена. Уточните название или дату.", map[string]any{"reason": "not_found"}), state, nil
	}
	state.Draft = &domain.Draft{Action: action, SourceText: m.ModelRequest.Text, Missing: []string{"item"}, ExpiresAt: m.ModelRequest.Now.Add(10 * time.Minute), Mutation: &domain.PendingMutation{Candidates: candidates, Timezone: m.ModelRequest.Timezone}}
	if len(candidates) > 1 {
		return chooseMutation(&state, total, "Подходит несколько записей. Какую выбрать?"), state, nil
	}
	state.Draft.Mutation.Selected = &candidates[0]
	return prepareMutation(ctx, repo, m, state)
}

func chooseMutation(state *domain.DialogueState, total int, text string) domain.Reply {
	pending := state.Draft.Mutation
	pending.Stage = "choose"
	pending.Selected = nil
	state.Draft.Missing = []string{"item"}
	expects := "item"
	state.Expects = &expects
	state.Candidates = pending.Candidates
	state.Focus = nil
	if total < len(pending.Candidates) {
		total = len(pending.Candidates)
	}
	if total > len(pending.Candidates) {
		text += fmt.Sprintf(" Показаны первые %d из %d. Можно отменить и уточнить поиск.", len(pending.Candidates), total)
	}
	reply := domain.NewReply("choose", text, map[string]any{"expects": "item", "pending_intent": state.Draft.Intent, "total": total, "shown": len(pending.Candidates)})
	reply.Items = pending.Candidates
	for i, item := range pending.Candidates {
		item = present(item, pending.Timezone, time.Now())
		label := fmt.Sprintf("%d. %s", i+1, item.Title)
		if day := itemDay(item, pending.Timezone); day != "" {
			label += " — " + day
		}
		if at := item.StartAt; at != nil {
			label += " " + at.Format("15:04")
		}
		reply.Options = append(reply.Options, domain.Option{ID: item.ID, Label: label})
	}
	return reply
}

func continueMutation(ctx context.Context, repo repository.ItemRepository, m domain.Message, state domain.DialogueState, answer domain.MessageAnswer) (domain.Reply, domain.DialogueState, error) {
	pending := state.Draft.Mutation
	if pending.Stage == "choose" {
		if (answer.OptionID == nil) == (answer.Text == nil) || answer.Confirmed != nil || answer.Date != nil || answer.Time != nil || answer.Title != nil || answer.DurationMin != nil {
			return domain.Reply{}, state, invalid("передайте только option_id или text для выбора записи")
		}
		selected := -1
		if answer.OptionID != nil {
			for i, item := range pending.Candidates {
				if item.ID == *answer.OptionID {
					selected = i
				}
			}
		} else {
			selected = choiceNumber(*answer.Text) - 1
		}
		if selected < 0 || selected >= len(pending.Candidates) {
			return domain.Reply{}, state, invalid("выберите номер или кнопку из показанного списка")
		}
		snapshot := pending.Candidates[selected]
		item, err := NewItems(repo).Get(ctx, m.UserID, snapshot.ID)
		if err != nil && !errors.Is(err, repository.ErrNotFound) {
			return domain.Reply{}, state, err
		}
		if errors.Is(err, repository.ErrNotFound) || !item.UpdatedAt.Equal(snapshot.UpdatedAt) {
			return refreshMutationChoices(ctx, repo, m, state)
		}
		pending.Selected = &item
		return prepareMutation(ctx, repo, m, state)
	}
	if answer.OptionID != nil || answer.Text != nil {
		return domain.Reply{}, state, invalid("выбор записи уже завершён")
	}
	if pending.Stage == "time" {
		if answer.Time == nil || answer.Confirmed != nil || answer.Title != nil {
			return domain.Reply{}, state, invalid("передайте новое time, при необходимости date и duration_min")
		}
		// Продолжаем перенос уже выбранной встречи, сохраняя остальные изменения.
		proposed, err := itemWithPatch(*pending.Selected, pending.Patch)
		if err != nil {
			return domain.Reply{}, state, err
		}
		changes := itemChanges{Time: answer.Time, Date: answer.Date, DurationMin: answer.DurationMin}
		patch, err := changesPatch(proposed, changes, m.ModelRequest.Timezone)
		if err != nil {
			return domain.Reply{}, state, err
		}
		for k, v := range patch {
			pending.Patch[k] = v
		}
		pending.ConflictKeys = nil
		return applyMutation(ctx, repo, m, state, false)
	}
	if answer.Confirmed == nil || answer.Date != nil || answer.Time != nil || answer.Title != nil || answer.DurationMin != nil {
		return domain.Reply{}, state, invalid("передайте только confirmed для подтверждения")
	}
	if !*answer.Confirmed {
		if pending.Stage == "conflict" {
			pending.Stage = "time"
			expects := "time"
			state.Expects = &expects
			state.Draft.Missing = []string{expects}
			return domain.NewReply("clarify", "Хорошо. На какое время поставить?", map[string]any{"expects": expects}), state, nil
		}
		state.Draft = nil
		state.Expects = nil
		return domain.NewReply("info", "Хорошо, не удаляю.", map[string]any{"reason": "cancelled"}), state, nil
	}
	return applyMutation(ctx, repo, m, state, pending.Stage == "conflict")
}

func prepareMutation(ctx context.Context, repo repository.ItemRepository, m domain.Message, state domain.DialogueState) (domain.Reply, domain.DialogueState, error) {
	var p mutationParams
	if err := json.Unmarshal(state.Draft.Params, &p); err != nil {
		return domain.Reply{}, state, err
	}
	pending := state.Draft.Mutation
	if state.Draft.Intent == "delete" {
		return confirmMutation(&state, "delete", "Удалить запись «"+pending.Selected.Title+"»?", nil), state, nil
	}
	if state.Draft.Intent == "complete" {
		if pending.Selected.Type == domain.ItemMeeting {
			return domain.ErrorReply("validation", "Встречу нельзя отметить выполненной."), state, nil
		}
		status := domain.StatusOpen
		if *p.Done {
			status = domain.StatusDone
		}
		raw, _ := json.Marshal(status)
		pending.Patch = map[string]json.RawMessage{"status": raw}
	} else {
		changes, err := decodeChanges(p.Changes)
		if err != nil {
			return domain.ErrorReply("llm_bad_output", err.Error()), state, nil
		}
		patch, err := changesPatch(*pending.Selected, changes, m.ModelRequest.Timezone)
		if err != nil {
			return domain.ErrorReply("validation", err.Error()), state, nil
		}
		pending.Patch = patch
	}
	return applyMutation(ctx, repo, m, state, false)
}

func applyMutation(ctx context.Context, repo repository.ItemRepository, m domain.Message, state domain.DialogueState, approved bool) (domain.Reply, domain.DialogueState, error) {
	pending := state.Draft.Mutation
	current, err := NewItems(repo).Get(ctx, m.UserID, pending.Selected.ID)
	if err != nil && !errors.Is(err, repository.ErrNotFound) {
		return domain.Reply{}, state, err
	}
	if errors.Is(err, repository.ErrNotFound) || !current.UpdatedAt.Equal(pending.Selected.UpdatedAt) {
		return refreshMutationChoices(ctx, repo, m, state)
	}
	current = present(current, m.ModelRequest.Timezone, time.Now())
	before := current
	action := "updated"
	if state.Draft.Intent == "delete" {
		if err := NewItems(repo).Delete(ctx, m.UserID, current.ID); err != nil {
			return domain.Reply{}, state, err
		}
		now := time.Now()
		current.DeletedAt = &now
		action = "deleted"
	} else {
		// Сначала проверяем актуальные конфликты без обхода предупреждения.
		current, err = NewItems(repo).Update(ctx, m.UserID, current.ID, pending.Patch)
		var conflict *MeetingConflictError
		if errors.As(err, &conflict) {
			known := map[string]bool{}
			for _, key := range pending.ConflictKeys {
				known[key] = true
			}
			keys := []string{}
			allKnown := approved
			for _, item := range conflict.Conflicts {
				key := item.ID + ":" + item.UpdatedAt.UTC().Format(time.RFC3339Nano)
				keys = append(keys, key)
				if !known[key] {
					allKnown = false
				}
			}
			if !allKnown {
				pending.ConflictKeys = keys
				return confirmMutation(&state, "conflict", conflictQuestion(conflict.Conflicts, m.ModelRequest.Timezone), conflict.Conflicts), state, nil
			}
			patch := map[string]json.RawMessage{}
			for k, v := range pending.Patch {
				patch[k] = v
			}
			patch["allow_conflicts"] = json.RawMessage("true")
			current, err = NewItems(repo).Update(ctx, m.UserID, before.ID, patch)
		}
		if errors.Is(err, ErrInvalid) {
			return domain.ErrorReply("validation", err.Error()), state, nil
		}
		if err != nil {
			return domain.Reply{}, state, err
		}
		if state.Draft.Intent == "complete" {
			action = "reopened"
			if current.Status == domain.StatusDone {
				action = "completed"
			}
		}
	}
	current = present(current, m.ModelRequest.Timezone, time.Now())
	text := map[string]string{"updated": "Изменил запись.", "deleted": "Удалил запись.", "completed": "Отметил выполненной.", "reopened": "Вернул в работу."}[action]
	reply := domain.NewReply("done", text, map[string]any{"actions": []map[string]any{{"action": action, "item_id": current.ID, "before": before, "after": current}}})
	reply.Items = []domain.Item{current}
	state.Focus = &current
	if action == "deleted" {
		state.Focus = nil
	}
	state.Candidates = nil
	state.Draft = nil
	state.Expects = nil
	return reply, state, nil
}

func confirmMutation(state *domain.DialogueState, stage, text string, conflicts []domain.Item) domain.Reply {
	pending := state.Draft.Mutation
	pending.Stage = stage
	expects := "yes_no"
	state.Expects = &expects
	state.Draft.Missing = []string{expects}
	data := map[string]any{"pending_intent": state.Draft.Intent, "count": 1}
	if stage == "conflict" {
		data["reason"] = "meeting_conflict"
		data["conflicts"] = conflicts
	}
	reply := domain.NewReply("confirm", text, data)
	reply.Items = []domain.Item{*pending.Selected}
	if conflicts != nil {
		reply.Items = conflicts
	}
	reply.Options = []domain.Option{{ID: "yes", Label: "Да"}, {ID: "no", Label: "Нет"}}
	return reply
}

func refreshMutationChoices(ctx context.Context, repo repository.ItemRepository, m domain.Message, state domain.DialogueState) (domain.Reply, domain.DialogueState, error) {
	pending := state.Draft.Mutation
	alive := []domain.Item{}
	for _, old := range pending.Candidates {
		item, err := NewItems(repo).Get(ctx, m.UserID, old.ID)
		if errors.Is(err, repository.ErrNotFound) {
			continue
		}
		if err != nil {
			return domain.Reply{}, state, err
		}
		alive = append(alive, item)
	}
	if len(alive) == 0 {
		state.Draft = nil
		state.Expects = nil
		return domain.NewReply("info", "Показанные записи уже удалены. Повторите поиск.", map[string]any{"reason": "not_found"}), state, nil
	}
	pending.Candidates = alive
	pending.Patch = nil
	pending.ConflictKeys = nil
	return chooseMutation(&state, len(alive), "Записи изменились после показа. Выберите запись заново."), state, nil
}

func choiceNumber(text string) int {
	text = strings.ReplaceAll(strings.ToLower(strings.Trim(strings.TrimSpace(text), ".!?")), "ё", "е")
	text = strings.Trim(strings.TrimSuffix(text, "пожалуйста"), " ,")
	for _, suffix := range []string{" задачу", " встречу", " запись", " вариант"} {
		text = strings.TrimSuffix(text, suffix)
	}
	for _, prefix := range []string{"выбираю ", "выбери ", "номер ", "вариант ", "запись "} {
		text = strings.TrimPrefix(text, prefix)
	}
	if number, err := strconv.Atoi(text); err == nil {
		return number
	}
	words := [][]string{{"первую", "первый", "первая", "один"}, {"вторую", "второй", "вторая", "два"}, {"третью", "третий", "третья", "три"}, {"четвертую", "четвёртую", "четвертый", "четвёртый", "четыре"}, {"пятую", "пятый", "пятая", "пять"}, {"шестую", "шестой", "шесть"}, {"седьмую", "седьмой", "семь"}, {"восьмую", "восьмой", "восемь"}, {"девятую", "девятый", "девять"}, {"десятую", "десятый", "десять"}, {"одиннадцатую", "одиннадцатый", "одиннадцать"}, {"двенадцатую", "двенадцатый", "двенадцать"}, {"тринадцатую", "тринадцатый", "тринадцать"}, {"четырнадцатую", "четырнадцатый", "четырнадцать"}, {"пятнадцатую", "пятнадцатый", "пятнадцать"}, {"шестнадцатую", "шестнадцатый", "шестнадцать"}, {"семнадцатую", "семнадцатый", "семнадцать"}, {"восемнадцатую", "восемнадцатый", "восемнадцать"}, {"девятнадцатую", "девятнадцатый", "девятнадцать"}, {"двадцатую", "двадцатый", "двадцать"}}
	for i, forms := range words {
		for _, word := range forms {
			if text == word {
				return i + 1
			}
		}
	}
	return 0
}

func decodeChanges(raw json.RawMessage) (itemChanges, error) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || len(fields) == 0 {
		return itemChanges{}, invalid("нужен непустой объект changes")
	}
	for _, value := range fields {
		if string(bytes.TrimSpace(value)) == "null" {
			return itemChanges{}, invalid("поля changes не могут быть null")
		}
	}
	var changes itemChanges
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&changes); err != nil {
		return changes, invalid("неизвестные или неверные поля changes")
	}
	return changes, nil
}

func itemWithPatch(item domain.Item, patch map[string]json.RawMessage) (domain.Item, error) {
	raw, err := json.Marshal(item)
	if err != nil {
		return item, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return item, err
	}
	for k, v := range patch {
		fields[k] = v
	}
	raw, err = json.Marshal(fields)
	if err != nil {
		return item, err
	}
	var result domain.Item
	err = json.Unmarshal(raw, &result)
	return result, err
}

func changesPatch(item domain.Item, c itemChanges, timezone string) (map[string]json.RawMessage, error) {
	patch := map[string]json.RawMessage{}
	set := func(key string, value any) { patch[key], _ = json.Marshal(value) }
	if c.Title != nil {
		set("title", *c.Title)
	}
	if len(c.ParticipantsAdd) > 0 || len(c.ParticipantsRemove) > 0 {
		if item.Type != domain.ItemMeeting {
			return nil, invalid("участники изменяются только у встречи")
		}
		participants := []string{}
		for _, name := range append(append([]string{}, item.Participants...), c.ParticipantsAdd...) {
			name = strings.TrimSpace(name)
			if name == "" {
				return nil, invalid("пустой участник")
			}
			skip := false
			for _, remove := range c.ParticipantsRemove {
				if strings.EqualFold(name, strings.TrimSpace(remove)) {
					skip = true
				}
			}
			for _, existing := range participants {
				if strings.EqualFold(name, existing) {
					skip = true
				}
			}
			if !skip {
				participants = append(participants, name)
			}
		}
		set("participants", participants)
	}
	timing := c.Date != nil || c.Time != nil || c.ShiftMin != nil || c.DurationMin != nil
	if c.ClearDue {
		if item.Type != domain.ItemTask || timing {
			return nil, invalid("clear_due допустим только для задачи без других изменений срока")
		}
		for _, key := range []string{"due_date", "due_at", "period_start", "period_end"} {
			set(key, nil)
		}
	}
	if timing {
		loc, err := time.LoadLocation(timezone)
		if err != nil {
			return nil, invalid("неверный часовой пояс")
		}
		at := item.DueAt
		if item.Type == domain.ItemMeeting {
			at = item.StartAt
		}
		if item.Type == domain.ItemReminder {
			at = item.RemindAt
		}
		var date, clock string
		if at != nil {
			date = at.In(loc).Format(time.DateOnly)
			clock = at.In(loc).Format("15:04")
		} else if item.DueDate != nil {
			date = string(*item.DueDate)
		}
		if item.PeriodStart != nil {
			return nil, invalid("для изменения срока-периода сначала укажите новый срок вручную")
		}
		if c.ShiftMin != nil && (c.Date != nil || c.Time != nil) {
			return nil, invalid("нельзя смешивать shift_min с date/time")
		}
		if c.Date != nil {
			date = *c.Date
		}
		if c.Time != nil {
			clock = *c.Time
		}
		if date == "" {
			return nil, invalid("для записи без срока укажите дату")
		}
		day, err := time.ParseInLocation(time.DateOnly, date, loc)
		if err != nil {
			return nil, invalid("неверная дата")
		}
		if clock == "" {
			if item.Type != domain.ItemTask || c.ShiftMin != nil || c.DurationMin != nil {
				return nil, invalid("нужно точное время")
			}
			set("due_date", day.Format(time.DateOnly))
		} else {
			next, err := time.ParseInLocation("2006-01-02 15:04", date+" "+clock, loc)
			if err != nil {
				return nil, invalid("неверное время")
			}
			if c.ShiftMin != nil {
				if *c.ShiftMin < -525600 || *c.ShiftMin > 525600 {
					return nil, invalid("слишком большой сдвиг")
				}
				next = next.Add(time.Duration(*c.ShiftMin) * time.Minute)
			}
			switch item.Type {
			case domain.ItemMeeting:
				duration := item.EndAt.Sub(*item.StartAt)
				if c.DurationMin != nil {
					if *c.DurationMin <= 0 || *c.DurationMin > 10080 {
						return nil, invalid("неверная длительность")
					}
					duration = time.Duration(*c.DurationMin) * time.Minute
				}
				end := next.Add(duration)
				set("start_at", next)
				set("end_at", end)
				if item.AllDay && (c.Time != nil || c.ShiftMin != nil) {
					set("all_day", false)
				}
				if item.RemindAt != nil {
					set("remind_at", next.Add(item.RemindAt.Sub(*item.StartAt)))
				}
			case domain.ItemReminder:
				if c.DurationMin != nil {
					return nil, invalid("длительность есть только у встречи")
				}
				set("remind_at", next)
			case domain.ItemTask:
				if c.DurationMin != nil {
					return nil, invalid("длительность есть только у встречи")
				}
				set("due_at", next)
				set("due_date", nil)
			}
		}
	}
	if len(patch) == 0 {
		return nil, invalid("не указаны изменения")
	}
	proposed, err := itemWithPatch(item, patch)
	if err != nil {
		return nil, invalid("неверные изменения")
	}
	if err := ValidateItem(proposed); err != nil {
		return nil, err
	}
	return patch, nil
}
