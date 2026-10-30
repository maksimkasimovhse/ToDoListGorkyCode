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
// Входные DTO определяются отдельно; JSON-теги задают представление записи в ответах.
type Item struct {
	ID           string       `json:"id"`
	UserID       string       `json:"user_id"`
	Type         ItemType     `json:"type"`
	Title        string       `json:"title"`
	SourceText   string       `json:"source_text"`
	DueDate      *Date        `json:"due_date"`
	DueAt        *time.Time   `json:"due_at"`
	PeriodStart  *time.Time   `json:"period_start"`
	PeriodEnd    *time.Time   `json:"period_end"`
	StartAt      *time.Time   `json:"start_at"`
	EndAt        *time.Time   `json:"end_at"`
	AllDay       bool         `json:"all_day"`
	Participants []string     `json:"participants"`
	Location     *string      `json:"location"`
	RemindAt     *time.Time   `json:"remind_at"`
	Status       ItemStatus   `json:"status"`
	CreatedAt    time.Time    `json:"created_at"`
	UpdatedAt    time.Time    `json:"updated_at"`
	CompletedAt  *time.Time   `json:"completed_at"`
	DeletedAt    *time.Time   `json:"deleted_at"`
	Computed     ItemComputed `json:"computed"`
}

type ItemComputed struct {
	Overdue    bool `json:"overdue"`
	Occurrence any  `json:"occurrence"`
}
