package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorky/backend/internal/domain"
	"gorky/backend/internal/repository"
)

// Единый порядок блокировок для результата ML, ответа пользователя и отмены.
func lockMessage(ctx context.Context, tx *sql.Tx, user, id string) (domain.Message, domain.DialogueState, error) {
	var session string
	err := tx.QueryRowContext(ctx, `SELECT session_id FROM messages WHERE user_id=$1 AND id=$2`, user, id).Scan(&session)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Message{}, domain.DialogueState{}, repository.ErrNotFound
	}
	if err != nil {
		return domain.Message{}, domain.DialogueState{}, err
	}
	state, err := lockConversation(ctx, tx, user, session)
	if err != nil {
		return domain.Message{}, state, err
	}
	m, err := scanMessage(tx.QueryRowContext(ctx, `SELECT `+messageColumns+` FROM messages WHERE user_id=$1 AND id=$2 FOR UPDATE`, user, id))
	return m, state, err
}

func persistReply(ctx context.Context, tx *sql.Tx, m domain.Message, state domain.DialogueState, reply domain.Reply, override string) (domain.Message, error) {
	status := "completed"
	var token *string
	now := time.Now().UTC()
	var finished *time.Time = &now
	deadline := m.DeadlineAt
	switch reply.Type {
	case "error":
		status = "failed"
	case "clarify", "confirm", "choose":
		if state.Draft == nil {
			return m, errors.New("waiting response requires a draft")
		}
		status = "awaiting_input"
		if reply.Type == "confirm" {
			status = "awaiting_confirmation"
		}
		id := uuid.NewString()
		token = &id
		finished = nil
		deadline = state.Draft.ExpiresAt
	}
	if reply.Type == "info" {
		if data, ok := reply.Data.(map[string]any); ok && data["reason"] == "cancelled" {
			status = "cancelled"
		}
	}
	if override != "" {
		status = override
	}
	if finished != nil {
		state.Draft = nil
		state.Expects = nil
	}
	if err := saveState(ctx, tx, m.UserID, m.Request.SessionID, state); err != nil {
		return m, err
	}
	raw, err := json.Marshal(reply)
	if err != nil {
		return m, err
	}
	return scanMessage(tx.QueryRowContext(ctx, `UPDATE messages SET status=$2,response=$3,finished_at=$4,input_token=$5,deadline_at=$6 WHERE id=$1 RETURNING `+messageColumns,
		m.ID, status, string(raw), finished, token, deadline))
}

func appendTurns(state *domain.DialogueState, text, reply string) {
	state.History = append(state.History, domain.Turn{Role: "user", Text: text}, domain.Turn{Role: "assistant", Text: reply})
	if len(state.History) > 5 {
		state.History = state.History[len(state.History)-5:]
	}
}

func timeoutReply(m domain.Message) domain.Reply {
	if m.Status == "awaiting_input" || m.Status == "awaiting_confirmation" {
		return domain.ErrorReply("input_timeout", "Время ожидания ответа истекло. Начните запрос заново.")
	}
	return domain.ErrorReply("llm_unavailable", "Не получилось обработать запрос вовремя. Попробуйте ещё раз.")
}

func (r *Messages) Answer(ctx context.Context, user, id string, answer domain.MessageAnswer, execute repository.Executor) (domain.Message, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.Message{}, err
	}
	defer tx.Rollback()
	m, state, err := lockMessage(ctx, tx, user, id)
	if err != nil {
		return m, err
	}
	raw, err := json.Marshal(answer)
	if err != nil {
		return m, err
	}
	var same bool
	err = tx.QueryRowContext(ctx, `SELECT request=$3::jsonb FROM message_answers WHERE message_id=$1 AND input_token=$2`, id, answer.InputToken, string(raw)).Scan(&same)
	if err == nil {
		if !same {
			return m, repository.ErrIdempotencyConflict
		}
		return m, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return m, err
	}
	if m.Status != "awaiting_input" && m.Status != "awaiting_confirmation" {
		return m, repository.ErrMessageState
	}
	if !time.Now().Before(m.DeadlineAt) {
		reply := timeoutReply(m)
		appendTurns(&state, "", reply.Reply)
		m, err = persistReply(ctx, tx, m, state, reply, "")
		if err != nil {
			return m, err
		}
		return m, tx.Commit()
	}
	if m.InputToken == nil || *m.InputToken != answer.InputToken {
		return m, repository.ErrInputToken
	}
	reply, next, err := execute(ctx, &Items{db: tx}, m, state)
	if err != nil {
		return m, err
	}
	appendTurns(&next, string(raw), reply.Reply)
	m, err = persistReply(ctx, tx, m, next, reply, "")
	if err != nil {
		return m, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO message_answers (message_id,input_token,request) VALUES ($1,$2,$3)`, id, answer.InputToken, string(raw))
	if err != nil {
		return m, err
	}
	return m, tx.Commit()
}

func (r *Messages) Cancel(ctx context.Context, user, id string) (domain.Message, error) {
	return r.terminate(ctx, user, id, false)
}

func (r *Messages) terminate(ctx context.Context, user, id string, expiredOnly bool) (domain.Message, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.Message{}, err
	}
	defer tx.Rollback()
	m, state, err := lockMessage(ctx, tx, user, id)
	if err != nil {
		return m, err
	}
	if expiredOnly && (!m.Active() || time.Now().Before(m.DeadlineAt)) {
		return m, nil
	}
	if !expiredOnly && m.Status == "cancelled" {
		return m, nil
	}
	if !m.Active() {
		return m, repository.ErrMessageState
	}
	reply := domain.NewReply("info", "Хорошо, отменяю.", map[string]any{"reason": "cancelled"})
	status := "cancelled"
	if expiredOnly || !time.Now().Before(m.DeadlineAt) {
		reply = timeoutReply(m)
		status = "failed"
	}
	appendTurns(&state, "", reply.Reply)
	m, err = persistReply(ctx, tx, m, state, reply, status)
	if err != nil {
		return m, err
	}
	return m, tx.Commit()
}
