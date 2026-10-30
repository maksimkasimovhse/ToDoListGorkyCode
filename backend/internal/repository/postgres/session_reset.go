package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"gorky/backend/internal/domain"
)

// Reset сериализуется с приёмом сообщений, ответами пользователя и результатами ML.
// Уже созданные записи и архивные сообщения не удаляются.
func (r *Messages) Reset(ctx context.Context, user, session string) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := lockConversation(ctx, tx, user, session); errors.Is(err, sql.ErrNoRows) {
		return tx.Commit()
	} else if err != nil {
		return err
	}
	reply := domain.NewReply("info", "Диалог сброшен.", map[string]any{"reason": "cancelled"})
	raw, err := json.Marshal(reply)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE messages SET status='cancelled',response=$3,finished_at=clock_timestamp(),input_token=NULL
 WHERE user_id=$1 AND session_id=$2 AND status IN ('processing','awaiting_input','awaiting_confirmation')`, user, session, string(raw))
	if err != nil {
		return err
	}
	if err := saveState(ctx, tx, user, session, domain.DialogueState{}); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO conversation_resets(user_id,session_id,reset_at) VALUES($1,$2,clock_timestamp())
 ON CONFLICT(user_id,session_id) DO UPDATE SET reset_at=EXCLUDED.reset_at`, user, session)
	if err != nil {
		return err
	}
	return tx.Commit()
}
