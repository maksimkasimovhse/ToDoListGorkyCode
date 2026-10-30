package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorky/backend/internal/domain"
	"gorky/backend/internal/repository"
)

type querier interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

type Items struct{ db querier }

func NewItems(db *sql.DB) *Items { return &Items{db: db} }

func (r *Items) Create(ctx context.Context, item domain.Item) (domain.Item, error) {
	item.ID = uuid.NewString()
	item.CreatedAt = time.Now().UTC()
	item.UpdatedAt = item.CreatedAt
	if item.Participants == nil {
		item.Participants = []string{}
	}
	payload, err := json.Marshal(item)
	if err != nil {
		return domain.Item{}, err
	}
	var raw []byte
	err = r.db.QueryRowContext(ctx, `INSERT INTO items
		(id,user_id,type,title,source_text,due_date,due_at,period_start,period_end,start_at,end_at,
		all_day,participants,location,remind_at,status,created_at,updated_at,completed_at,deleted_at)
		SELECT id,user_id,type,title,source_text,due_date,due_at,period_start,period_end,start_at,end_at,
		all_day,participants,location,remind_at,status,created_at,updated_at,completed_at,deleted_at
		FROM jsonb_populate_record(NULL::items, $1::jsonb)
		RETURNING to_jsonb(items)`, string(payload)).Scan(&raw)
	if err != nil {
		return domain.Item{}, err
	}
	err = json.Unmarshal(raw, &item)
	return item, err
}

func (r *Items) GetByID(ctx context.Context, userID, id string) (domain.Item, error) {
	var raw []byte
	err := r.db.QueryRowContext(ctx, `SELECT to_jsonb(i) FROM items i WHERE user_id=$1 AND id=$2 AND deleted_at IS NULL`, userID, id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Item{}, repository.ErrNotFound
	}
	if err != nil {
		return domain.Item{}, err
	}
	var item domain.Item
	err = json.Unmarshal(raw, &item)
	return item, err
}

func (r *Items) List(ctx context.Context, userID string, f repository.ItemFilter) ([]domain.Item, error) {
	items, _, err := r.find(ctx, userID, f)
	return items, err
}

func (r *Items) Search(ctx context.Context, userID string, f repository.ItemFilter) ([]domain.Item, error) {
	items, _, err := r.find(ctx, userID, f)
	return items, err
}

func (r *Items) Count(ctx context.Context, userID string, f repository.ItemFilter) (int, error) {
	f.Limit = 1
	_, total, err := r.find(ctx, userID, f)
	return total, err
}

func (r *Items) find(ctx context.Context, userID string, f repository.ItemFilter) ([]domain.Item, int, error) {
	if f.Timezone == "" {
		f.Timezone = "UTC"
	}
	if f.Limit <= 0 || f.Limit > 100 {
		f.Limit = 100
	}
	types := make([]string, len(f.Types))
	for i, kind := range f.Types {
		types[i] = string(kind)
	}
	escape := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	rows, err := r.db.QueryContext(ctx, `SELECT to_jsonb(i),count(*) OVER() FROM items i
		WHERE user_id=$1 AND deleted_at IS NULL
		AND (cardinality($2::text[])=0 OR type=ANY($2::text[]))
		AND ($3::text IS NULL OR status=$3)
		AND (NOT $7::boolean OR (type='task' AND due_date IS NULL AND due_at IS NULL AND period_start IS NULL))
		AND ($4::timestamptz IS NULL OR
			(type='meeting' AND end_at > $4) OR
			(type<>'meeting' AND COALESCE(remind_at,due_at,period_end) >= $4) OR
			(type='task' AND (due_date + 1)::timestamp AT TIME ZONE $6 > $4))
		AND ($5::timestamptz IS NULL OR
			COALESCE(start_at,remind_at,due_at,period_start,due_date::timestamp AT TIME ZONE $6) < $5)
		AND ($8::text='' OR (title || ' ' || source_text) ILIKE '%' || $8 || '%')
		AND ($9::text='' OR EXISTS (SELECT 1 FROM unnest(participants) p WHERE p ILIKE '%' || $9 || '%'))
		ORDER BY COALESCE(start_at,remind_at,due_at,period_end,due_date::timestamp AT TIME ZONE $6) NULLS LAST,created_at,id
		LIMIT $10`, userID, types, f.Status, f.From, f.To, f.Timezone, f.Undated, escape.Replace(f.Query), escape.Replace(f.Participant), f.Limit)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := []domain.Item{}
	total := 0
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw, &total); err != nil {
			return nil, 0, err
		}
		var item domain.Item
		if err := json.Unmarshal(raw, &item); err != nil {
			return nil, 0, err
		}
		items = append(items, item)
	}
	return items, total, rows.Err()
}

// Update проверяет версию записи, чтобы не потерять параллельные изменения.
func (r *Items) Update(ctx context.Context, item domain.Item, version time.Time) (domain.Item, error) {
	if item.Participants == nil {
		item.Participants = []string{}
	}
	payload, err := json.Marshal(item)
	if err != nil {
		return domain.Item{}, err
	}
	var raw []byte
	err = r.db.QueryRowContext(ctx, `UPDATE items AS i SET
 title=p.title, source_text=p.source_text, due_date=p.due_date, due_at=p.due_at,
 period_start=p.period_start, period_end=p.period_end, start_at=p.start_at, end_at=p.end_at,
 all_day=p.all_day, participants=p.participants, location=p.location, remind_at=p.remind_at,
 status=p.status, completed_at=p.completed_at,
 updated_at=GREATEST(clock_timestamp(), i.updated_at + interval '1 microsecond')
 FROM jsonb_populate_record(NULL::items, $1::jsonb) AS p
 WHERE i.id=$2 AND i.user_id=$3 AND i.deleted_at IS NULL AND i.updated_at=$4
 RETURNING to_jsonb(i)`, string(payload), item.ID, item.UserID, version).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		if _, getErr := r.GetByID(ctx, item.UserID, item.ID); getErr != nil {
			return domain.Item{}, getErr
		}
		return domain.Item{}, repository.ErrConflict
	}
	if err != nil {
		return domain.Item{}, err
	}
	err = json.Unmarshal(raw, &item)
	return item, err
}

// Delete выполняет мягкое удаление с проверкой владельца.
func (r *Items) Delete(ctx context.Context, user, id string) error {
	result, err := r.db.ExecContext(ctx, `UPDATE items SET deleted_at=clock_timestamp(),
 updated_at=GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
 WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, id, user)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return repository.ErrNotFound
	}
	return nil
}
