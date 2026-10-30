package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	_ "time/tzdata"

	"github.com/google/uuid"
	"gorky/backend/internal/domain"
	"gorky/backend/internal/repository"
)

var ErrInvalid = errors.New("invalid input")

func invalid(message string) error { return fmt.Errorf("%w: %s", ErrInvalid, message) }

// Проверки общие для ручного создания и команд модели.
func ValidateItem(item domain.Item) error {
	if strings.TrimSpace(item.Title) == "" || len(item.Title) > 1000 {
		return invalid("title обязателен, максимум 1000 байт")
	}
	deadlines := 0
	if item.DueDate != nil {
		deadlines++
		if _, err := time.Parse(time.DateOnly, string(*item.DueDate)); err != nil {
			return invalid("неверная due_date")
		}
	}
	if item.DueAt != nil {
		deadlines++
	}
	if item.PeriodStart != nil {
		deadlines++
	}
	if deadlines > 1 || (item.PeriodStart == nil) != (item.PeriodEnd == nil) {
		return invalid("нужен один вариант срока задачи")
	}
	if item.PeriodStart != nil && !item.PeriodEnd.After(*item.PeriodStart) {
		return invalid("неверный период")
	}
	switch item.Type {
	case domain.ItemTask:
		if item.StartAt != nil || item.EndAt != nil || item.RemindAt != nil || item.AllDay || item.Location != nil {
			return invalid("лишние поля задачи")
		}
	case domain.ItemReminder:
		if item.RemindAt == nil || deadlines != 0 || item.StartAt != nil || item.EndAt != nil || item.AllDay || item.Location != nil || len(item.Participants) > 0 {
			return invalid("напоминанию нужен remind_at, поля срока и встречи недопустимы")
		}
	case domain.ItemMeeting:
		if item.StartAt == nil || item.EndAt == nil || !item.EndAt.After(*item.StartAt) || deadlines != 0 {
			return invalid("встрече нужны start_at и end_at, конец позже начала")
		}
	default:
		return invalid("неизвестный тип записи")
	}
	return nil
}

type Items struct{ repo repository.ItemRepository }

func NewItems(repo repository.ItemRepository) *Items { return &Items{repo: repo} }

func (s *Items) Create(ctx context.Context, user string, item domain.Item) (domain.Item, error) {
	return s.CreateWithOptions(ctx, user, item, SaveOptions{})
}

func (s *Items) CreateWithOptions(ctx context.Context, user string, item domain.Item, options SaveOptions) (domain.Item, error) {
	var saved domain.Item
	err := s.repo.WithUserLock(ctx, user, func(repo repository.ItemRepository) error {
		var err error
		saved, err = NewItems(repo).create(ctx, user, item, options)
		return err
	})
	return saved, err
}

func (s *Items) create(ctx context.Context, user string, item domain.Item, options SaveOptions) (domain.Item, error) {
	item.ID = ""
	item.UserID = user
	item.CompletedAt = nil
	item.DeletedAt = nil
	item.Title = strings.TrimSpace(item.Title)
	item.Status = domain.StatusOpen
	if item.Type == domain.ItemMeeting {
		item.Status = domain.StatusScheduled
	}
	if item.Type == domain.ItemMeeting && item.StartAt != nil && item.EndAt == nil {
		end := item.StartAt.Add(time.Hour)
		item.EndAt = &end
	}
	if err := ValidateItem(item); err != nil {
		return domain.Item{}, err
	}
	if err := s.checkMeeting(ctx, item, options.AllowConflicts); err != nil {
		return domain.Item{}, err
	}
	saved, err := s.repo.Create(ctx, item)
	if err == nil {
		saved = present(saved, "Europe/Moscow", time.Now())
	}
	return saved, err
}

func (s *Items) Get(ctx context.Context, user, id string) (domain.Item, error) {
	if _, err := uuid.Parse(id); err != nil {
		return domain.Item{}, invalid("неверный id")
	}
	item, err := s.repo.GetByID(ctx, user, id)
	if err == nil {
		item = present(item, "Europe/Moscow", time.Now())
	}
	return item, err
}

func (s *Items) List(ctx context.Context, user string, f repository.ItemFilter) ([]domain.Item, error) {
	if f.Timezone == "" {
		f.Timezone = "Europe/Moscow"
	}
	if _, err := time.LoadLocation(f.Timezone); err != nil {
		return nil, invalid("неверный часовой пояс")
	}
	if f.From != nil && f.To != nil && !f.To.After(*f.From) {
		return nil, invalid("to должен быть позже from")
	}
	for _, kind := range f.Types {
		if kind != domain.ItemTask && kind != domain.ItemReminder && kind != domain.ItemMeeting {
			return nil, invalid("неверный тип записи")
		}
	}
	if f.Status != nil && *f.Status != domain.StatusOpen && *f.Status != domain.StatusDone && *f.Status != domain.StatusScheduled && *f.Status != domain.StatusCancelled {
		return nil, invalid("неверный статус")
	}
	items, err := s.repo.List(ctx, user, f)
	if err != nil {
		return nil, err
	}
	for i := range items {
		items[i] = present(items[i], f.Timezone, time.Now())
	}
	return items, nil
}

func (s *Items) Count(ctx context.Context, user string, f repository.ItemFilter) (int, error) {
	if f.Timezone == "" {
		f.Timezone = "Europe/Moscow"
	}
	return s.repo.Count(ctx, user, f)
}

func present(item domain.Item, timezone string, now time.Time) domain.Item {
	loc, err := time.LoadLocation(timezone)
	if err != nil {
		loc = time.UTC
	}
	for _, at := range []**time.Time{&item.DueAt, &item.PeriodStart, &item.PeriodEnd, &item.StartAt, &item.EndAt, &item.RemindAt, &item.CompletedAt, &item.DeletedAt} {
		if *at != nil {
			local := (**at).In(loc)
			*at = &local
		}
	}
	item.CreatedAt = item.CreatedAt.In(loc)
	item.UpdatedAt = item.UpdatedAt.In(loc)
	if item.Type == domain.ItemTask && item.Status == domain.StatusOpen {
		if item.DueDate != nil {
			item.Computed.Overdue = string(*item.DueDate) < now.In(loc).Format(time.DateOnly)
		}
		if item.DueAt != nil {
			item.Computed.Overdue = item.DueAt.Before(now)
		}
		if item.PeriodEnd != nil {
			item.Computed.Overdue = item.PeriodEnd.Before(now)
		}
	}
	return item
}

// Update изменяет только переданные поля; null очищает необязательное поле.
func (s *Items) Update(ctx context.Context, user, id string, patch map[string]json.RawMessage) (domain.Item, error) {
	var saved domain.Item
	err := s.repo.WithUserLock(ctx, user, func(repo repository.ItemRepository) error {
		var err error
		saved, err = NewItems(repo).update(ctx, user, id, patch)
		return err
	})
	return saved, err
}

func (s *Items) update(ctx context.Context, user, id string, patch map[string]json.RawMessage) (domain.Item, error) {
	if len(patch) == 0 {
		return domain.Item{}, invalid("нужен непустой объект изменений")
	}
	item, err := s.Get(ctx, user, id)
	if err != nil {
		return domain.Item{}, err
	}
	version := item.UpdatedAt
	original := item
	if item.StartAt != nil {
		at := *item.StartAt
		original.StartAt = &at
	}
	if item.EndAt != nil {
		at := *item.EndAt
		original.EndAt = &at
	}
	allow := false
	fields := map[string]any{
		"title": &item.Title, "source_text": &item.SourceText,
		"due_date": &item.DueDate, "due_at": &item.DueAt,
		"period_start": &item.PeriodStart, "period_end": &item.PeriodEnd,
		"start_at": &item.StartAt, "end_at": &item.EndAt,
		"all_day": &item.AllDay, "participants": &item.Participants,
		"location": &item.Location, "remind_at": &item.RemindAt, "status": &item.Status,
	}
	for key, raw := range patch {
		if key == "allow_conflicts" {
			if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &allow) != nil {
				return domain.Item{}, invalid("allow_conflicts должен быть boolean")
			}
			continue
		}
		target, ok := fields[key]
		if !ok {
			return domain.Item{}, invalid("поле нельзя изменять: " + key)
		}
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			switch key {
			case "title", "source_text", "all_day", "status":
				return domain.Item{}, invalid("поле не может быть null: " + key)
			}
		}
		if err := json.Unmarshal(raw, target); err != nil {
			return domain.Item{}, invalid("неверное поле: " + key)
		}
	}
	item.Title = strings.TrimSpace(item.Title)
	if item.Type == domain.ItemMeeting {
		if item.Status != domain.StatusScheduled && item.Status != domain.StatusCancelled {
			return domain.Item{}, invalid("статус встречи: scheduled или cancelled")
		}
	} else if item.Status != domain.StatusOpen && item.Status != domain.StatusDone {
		return domain.Item{}, invalid("статус задачи или напоминания: open или done")
	}
	if item.Status == domain.StatusDone {
		if item.CompletedAt == nil {
			now := time.Now().UTC()
			item.CompletedAt = &now
		}
	} else {
		item.CompletedAt = nil
	}
	if err := ValidateItem(item); err != nil {
		return domain.Item{}, err
	}
	// Уже подтверждённое пересечение не мешает правке названия; перенос и восстановление проверяются заново.
	scheduleChanged := original.Status != item.Status ||
		(item.StartAt != nil && original.StartAt != nil && !item.StartAt.Equal(*original.StartAt)) ||
		(item.EndAt != nil && original.EndAt != nil && !item.EndAt.Equal(*original.EndAt))
	if scheduleChanged {
		if err := s.checkMeeting(ctx, item, allow); err != nil {
			return domain.Item{}, err
		}
	}
	saved, err := s.repo.Update(ctx, item, version)
	if err != nil {
		return domain.Item{}, err
	}
	return present(saved, "Europe/Moscow", time.Now()), nil
}

func (s *Items) Delete(ctx context.Context, user, id string) error {
	if _, err := uuid.Parse(id); err != nil {
		return invalid("неверный id")
	}
	return s.repo.WithUserLock(ctx, user, func(repo repository.ItemRepository) error { return repo.Delete(ctx, user, id) })
}
