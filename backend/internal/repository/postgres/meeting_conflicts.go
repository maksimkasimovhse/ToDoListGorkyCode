package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"gorky/backend/internal/domain"
	"gorky/backend/internal/repository"
)

// WithUserLock сериализует проверку и запись расписания, в том числе между экземплярами API.
// В обработке сообщения используется уже открытая транзакция, без вложенного commit.
func (r *Items) WithUserLock(ctx context.Context, user string, fn func(repository.ItemRepository) error) error {
	if tx, ok := r.db.(*sql.Tx); ok {
		if _, err := tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", "schedule:"+user); err != nil {
			return err
		}
		return fn(r)
	}
	db, ok := r.db.(*sql.DB)
	if !ok {
		return fmt.Errorf("unsupported database handle")
	}
	tx, err := db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := (&Items{db: tx}).WithUserLock(ctx, user, fn); err != nil {
		return err
	}
	return tx.Commit()
}

// MeetingConflicts возвращает все активные пересечения, исключая саму изменяемую запись.
func (r *Items) MeetingConflicts(ctx context.Context, item domain.Item) ([]domain.Item, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT to_jsonb(i) FROM items i
 WHERE user_id=$1 AND type='meeting' AND status='scheduled' AND deleted_at IS NULL
 AND id::text <> $2 AND start_at < $4 AND end_at > $3
 ORDER BY start_at,id`, item.UserID, item.ID, item.StartAt, item.EndAt)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	found := []domain.Item{}
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var existing domain.Item
		if err := json.Unmarshal(raw, &existing); err != nil {
			return nil, err
		}
		found = append(found, existing)
	}
	return found, rows.Err()
}
