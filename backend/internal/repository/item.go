// Пакет repository определяет контракты хранилища; реализации находятся во вложенных пакетах.
package repository

import (
	"context"
	"errors"
	"time"

	"gorky/backend/internal/domain"
)

var ErrNotFound = errors.New("item not found")

// ItemRepository всегда ограничивает доступ по userID, включая операции записи.
// Удалённые записи исключаются. Для чужих идентификаторов возвращается ErrNotFound.
type ItemRepository interface {
	Create(ctx context.Context, item domain.Item) (domain.Item, error)
	GetByID(ctx context.Context, userID, itemID string) (domain.Item, error)
	List(ctx context.Context, userID string, filter ItemFilter) ([]domain.Item, error)
}

type ItemFilter struct {
	// Граница From включается, To не включается. nil означает отсутствие границы.
	From   *time.Time
	To     *time.Time
	Types  []domain.ItemType
	Status *domain.ItemStatus
}
