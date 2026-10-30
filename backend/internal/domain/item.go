// Пакет domain содержит сущности предметной области, независимые от транспорта и хранилища.
package domain

import "time"

type ItemType string

const (
	ItemTask     ItemType = "task"
	ItemReminder ItemType = "reminder"
	ItemMeeting  ItemType = "meeting"
)

type ItemStatus string

const (
	StatusOpen      ItemStatus = "open"
	StatusDone      ItemStatus = "done"
	StatusScheduled ItemStatus = "scheduled"
	StatusCancelled ItemStatus = "cancelled"
)

// Date — календарная дата в формате YYYY-MM-DD, без часового пояса и времени суток.
// Проверка выполняется в бизнес-сценарии перед сохранением записи.
type Date string

// Item — начальная модель записи. Повторы будут добавлены вместе с соответствующими сценариями.
// У задачи может быть не больше одного варианта срока: DueDate, DueAt или период.
// DTO запросов и ответов HTTP следует определять отдельно в транспортном слое.
type Item struct {
	ID           string
	UserID       string
	Type         ItemType
	Title        string
	SourceText   string
	DueDate      *Date
	DueAt        *time.Time
	PeriodStart  *time.Time
	PeriodEnd    *time.Time
	StartAt      *time.Time
	EndAt        *time.Time
	AllDay       bool
	Participants []string
	Location     *string
	RemindAt     *time.Time
	Status       ItemStatus
	CreatedAt    time.Time
	UpdatedAt    time.Time
	CompletedAt  *time.Time
	DeletedAt    *time.Time
}
