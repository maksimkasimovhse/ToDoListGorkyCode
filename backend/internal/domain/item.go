// Package domain contains business entities independent of transport and storage.
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

// Date is a calendar date in YYYY-MM-DD form, without a timezone or time of day.
// Validation belongs in the use case before persisting an item.
type Date string

// Item is the initial domain model. Recurrence will be added with its use cases.
// A task may have at most one deadline variant: DueDate, DueAt, or a period.
// HTTP request/response DTOs should be defined separately in the transport layer.
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
