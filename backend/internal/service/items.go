package service

import (
	"context"
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
