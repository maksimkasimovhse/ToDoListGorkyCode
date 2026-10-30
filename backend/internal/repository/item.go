// Package repository defines storage contracts; implementations live in subpackages.
package repository

import (
	"context"
	"errors"
	"time"

	"gorky/backend/internal/domain"
)

var ErrNotFound = errors.New("item not found")

// ItemRepository always scopes access by userID, including writes.
// Deleted items are excluded. Foreign IDs must return ErrNotFound.
type ItemRepository interface {
	Create(ctx context.Context, item domain.Item) (domain.Item, error)
	GetByID(ctx context.Context, userID, itemID string) (domain.Item, error)
	List(ctx context.Context, userID string, filter ItemFilter) ([]domain.Item, error)
}

type ItemFilter struct {
	// From is inclusive; To is exclusive. Nil means no bound.
	From   *time.Time
	To     *time.Time
	Types  []domain.ItemType
	Status *domain.ItemStatus
}
