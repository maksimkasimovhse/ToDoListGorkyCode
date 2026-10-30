package postgres

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"time"

	"gorky/backend/internal/domain"
	"gorky/backend/internal/repository"
)

func undoKey(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// WithUndo собирает изменения вложенных usecase в одну отменяемую операцию.
// Снимки и записи items фиксируются той же транзакцией, в том числе внутри обработки ML.
func (r *Items) WithUndo(ctx context.Context, user string, fn func(repository.ItemRepository) error) (*string, error) {
	if r.changes != nil {
		return nil, r.WithUserLock(ctx, user, fn)
	}
	var token *string
	err := r.WithUserLock(ctx, user, func(locked repository.ItemRepository) error {
		base := locked.(*Items)
		changes := []domain.ItemChange{}
		tracked := &Items{db: base.db, changes: &changes}
		if err := fn(tracked); err != nil {
			return err
		}
		if len(changes) == 0 {
			return nil
		}
		secret := make([]byte, 32)
		if _, err := rand.Read(secret); err != nil {
			return err
		}
		value := "undo_" + base64.RawURLEncoding.EncodeToString(secret)
		raw, err := json.Marshal(changes)
		if err != nil {
			return err
		}
		_, err = base.db.ExecContext(ctx, `INSERT INTO undo_operations(token_hash,user_id,changes,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')`, undoKey(value), user, string(raw))
		if err != nil {
			return err
		}
		token = &value
		return nil
	})
	return token, err
}

func (r *Items) track(before *domain.Item, after domain.Item) {
	if r.changes == nil {
		return
	}
	// Токены ответа и вычисляемые поля не являются состоянием записи.
	after.UndoToken = nil
	after.Computed = domain.ItemComputed{}
	if before != nil {
		copy := *before
		copy.UndoToken = nil
		copy.Computed = domain.ItemComputed{}
		before = &copy
	}
	for i, change := range *r.changes {
		if change.After.ID == after.ID {
			(*r.changes)[i].After = after
			return
		}
	}
	*r.changes = append(*r.changes, domain.ItemChange{Before: before, After: after})
}

func (r *Items) Undo(ctx context.Context, user, token string) (domain.Reply, error) {
	var reply domain.Reply
	err := r.WithUserLock(ctx, user, func(locked repository.ItemRepository) error {
		base := locked.(*Items)
		var raw, response []byte
		var expires time.Time
		var undone sql.NullTime
		err := base.db.QueryRowContext(ctx, `SELECT changes,expires_at,undone_at,response FROM undo_operations WHERE token_hash=$1 AND user_id=$2 FOR UPDATE`, undoKey(token), user).Scan(&raw, &expires, &undone, &response)
		if errors.Is(err, sql.ErrNoRows) {
			return repository.ErrNotFound
		}
		if err != nil {
			return err
		}
		if undone.Valid {
			return json.Unmarshal(response, &reply)
		}
		if !time.Now().Before(expires) {
			return repository.ErrUndoExpired
		}
		var changes []domain.ItemChange
		if err := json.Unmarshal(raw, &changes); err != nil {
			return err
		}
		sort.Slice(changes, func(i, j int) bool { return changes[i].After.ID < changes[j].After.ID })
		ids := make([]string, len(changes))
		desired := make([]domain.Item, len(changes))
		current := make([]domain.Item, len(changes))
		for i, change := range changes {
			var data []byte
			err := base.db.QueryRowContext(ctx, `SELECT to_jsonb(i) FROM items i WHERE user_id=$1 AND id=$2 FOR UPDATE`, user, change.After.ID).Scan(&data)
			if errors.Is(err, sql.ErrNoRows) {
				return repository.ErrUndoConflict
			}
			if err != nil {
				return err
			}
			if err := json.Unmarshal(data, &current[i]); err != nil {
				return err
			}
			if !current[i].UpdatedAt.Equal(change.After.UpdatedAt) {
				return repository.ErrUndoConflict
			}
			ids[i] = change.After.ID
			if change.Before != nil {
				desired[i] = *change.Before
			} else {
				desired[i] = current[i]
				now := time.Now().UTC()
				desired[i].DeletedAt = &now
			}
		}
		// Восстановление встречи не должно занять время, занятое после исходной операции.
		conflicts := []domain.Item{}
		seen := map[string]bool{}
		for _, item := range desired {
			if item.Type != domain.ItemMeeting || item.Status != domain.StatusScheduled || item.DeletedAt != nil {
				continue
			}
			found, err := base.MeetingConflicts(ctx, item)
			if err != nil {
				return err
			}
			for _, existing := range found {
				changed := false
				for _, id := range ids {
					if id == existing.ID {
						changed = true
					}
				}
				if !changed && !seen[existing.ID] {
					conflicts = append(conflicts, existing)
					seen[existing.ID] = true
				}
			}
		}
		if len(conflicts) > 0 {
			return &repository.UndoMeetingConflict{Conflicts: conflicts}
		}
		items := []domain.Item{}
		actions := []map[string]any{}
		for i, item := range desired {
			saved, err := base.restoreSnapshot(ctx, user, item, current[i].UpdatedAt)
			if err != nil {
				return err
			}
			kind := "updated"
			if changes[i].Before == nil {
				kind = "deleted"
			}
			items = append(items, saved)
			actions = append(actions, map[string]any{"action": kind, "item_id": saved.ID, "before": current[i], "after": saved})
		}
		reply = domain.NewReply("done", "Отменил действие.", map[string]any{"actions": actions})
		reply.Items = items
		response, err = json.Marshal(reply)
		if err != nil {
			return err
		}
		_, err = base.db.ExecContext(ctx, `UPDATE undo_operations SET undone_at=clock_timestamp(),response=$2 WHERE token_hash=$1`, undoKey(token), string(response))
		return err
	})
	return reply, err
}

func (r *Items) restoreSnapshot(ctx context.Context, user string, item domain.Item, version time.Time) (domain.Item, error) {
	item.UndoToken = nil
	payload, err := json.Marshal(item)
	if err != nil {
		return domain.Item{}, err
	}
	var raw []byte
	err = r.db.QueryRowContext(ctx, `UPDATE items i SET
 type=p.type,title=p.title,source_text=p.source_text,due_date=p.due_date,due_at=p.due_at,
 period_start=p.period_start,period_end=p.period_end,start_at=p.start_at,end_at=p.end_at,
 all_day=p.all_day,participants=p.participants,location=p.location,remind_at=p.remind_at,
 status=p.status,completed_at=p.completed_at,deleted_at=p.deleted_at,
 updated_at=GREATEST(clock_timestamp(),i.updated_at+interval '1 microsecond')
 FROM jsonb_populate_record(NULL::items,$1::jsonb) p
 WHERE i.id=$2 AND i.user_id=$3 AND i.updated_at=$4 RETURNING to_jsonb(i)`, string(payload), item.ID, user, version).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Item{}, repository.ErrUndoConflict
	}
	if err != nil {
		return domain.Item{}, err
	}
	err = json.Unmarshal(raw, &item)
	return item, err
}
