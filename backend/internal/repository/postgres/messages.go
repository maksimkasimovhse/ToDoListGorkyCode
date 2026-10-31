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

type Messages struct {
	db       *sql.DB
	sessions repository.SessionRepository
}

func NewMessages(db *sql.DB, sessions repository.SessionRepository) *Messages {
	return &Messages{db: db, sessions: sessions}
}

const messageColumns = `id,status,response,created_at,deadline_at,user_id,request,model_request,attempt_id,attempts,input_token`

func scanMessage(row interface{ Scan(...any) error }) (domain.Message, error) {
	var m domain.Message
	var response, request, model []byte
	err := row.Scan(&m.ID, &m.Status, &response, &m.CreatedAt, &m.DeadlineAt, &m.UserID, &request, &model, &m.AttemptID, &m.Attempts, &m.InputToken)
	if errors.Is(err, sql.ErrNoRows) {
		return m, repository.ErrNotFound
	}
	if err != nil {
		return m, err
	}
	if err = json.Unmarshal(request, &m.Request); err != nil {
		return m, err
	}
	if err = json.Unmarshal(model, &m.ModelRequest); err != nil {
		return m, err
	}
	if response != nil {
		err = json.Unmarshal(response, &m.Response)
	}
	return m, err
}

func (r *Messages) Submit(ctx context.Context, user string, req domain.MessageRequest, timeout time.Duration, prepare repository.Prepare) (domain.Message, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.Message{}, err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `INSERT INTO conversations (user_id,session_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, user, req.SessionID)
	if err != nil {
		return domain.Message{}, err
	}
	state, err := lockConversation(ctx, tx, user, req.SessionID)
	if err != nil {
		return domain.Message{}, err
	}
	m, err := scanMessage(tx.QueryRowContext(ctx, `SELECT `+messageColumns+` FROM messages WHERE user_id=$1 AND session_id=$2 AND client_message_id=$3`, user, req.SessionID, req.ClientMessageID))
	if err == nil {
		old, _ := json.Marshal(m.Request)
		current, _ := json.Marshal(req)
		if string(old) != string(current) {
			return m, repository.ErrIdempotencyConflict
		}
		return m, tx.Commit()
	}
	if !errors.Is(err, repository.ErrNotFound) {
		return m, err
	}
	var busy bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM messages WHERE user_id=$1 AND session_id=$2 AND status IN ('processing','awaiting_input','awaiting_confirmation'))`, user, req.SessionID).Scan(&busy); err != nil {
		return m, err
	}
	if busy {
		return m, repository.ErrBusy
	}
	model, err := prepare(ctx, &Items{db: tx}, &state)
	if err != nil {
		return m, err
	}
	now := time.Now().UTC()
	m = domain.Message{ID: uuid.NewString(), UserID: user, Request: req, ModelRequest: model, AttemptID: uuid.NewString(), Attempts: 1, Status: "processing", CreatedAt: now, DeadlineAt: now.Add(timeout)}
	requestJSON, _ := json.Marshal(req)
	modelJSON, _ := json.Marshal(model)
	_, err = tx.ExecContext(ctx, `INSERT INTO messages (id,user_id,session_id,client_message_id,request,model_request,attempt_id,created_at,deadline_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, m.ID, user, req.SessionID, req.ClientMessageID, string(requestJSON), string(modelJSON), m.AttemptID, now, m.DeadlineAt)
	if err != nil {
		return m, err
	}
	if err = r.bindMessageSession(ctx, tx, m); err != nil {
		return m, err
	}
	if err = enqueue(ctx, tx, m); err != nil {
		return m, err
	}
	if err = saveState(ctx, tx, user, req.SessionID, state); err != nil {
		return m, err
	}
	return m, tx.Commit()
}

func (r *Messages) GetMessage(ctx context.Context, user, id string) (domain.Message, error) {
	return scanMessage(r.db.QueryRowContext(ctx, `SELECT `+messageColumns+` FROM messages WHERE user_id=$1 AND id=$2`, user, id))
}

func lockConversation(ctx context.Context, tx *sql.Tx, user, session string) (domain.DialogueState, error) {
	var raw []byte
	err := tx.QueryRowContext(ctx, `SELECT state FROM conversations WHERE user_id=$1 AND session_id=$2 FOR UPDATE`, user, session).Scan(&raw)
	var state domain.DialogueState
	if err == nil {
		err = json.Unmarshal(raw, &state)
	}
	return state, err
}

func saveState(ctx context.Context, tx *sql.Tx, user, session string, state domain.DialogueState) error {
	raw, err := json.Marshal(state)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE conversations SET state=$3 WHERE user_id=$1 AND session_id=$2`, user, session, string(raw))
	return err
}

func enqueue(ctx context.Context, tx *sql.Tx, m domain.Message) error {
	job := domain.Job{Version: 1, MessageID: m.ID, AttemptID: m.AttemptID, DeadlineAt: m.DeadlineAt, Request: m.ModelRequest}
	raw, err := json.Marshal(job)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO message_outbox (message_id,attempt_id,payload) VALUES ($1,$2,$3)`, m.ID, m.AttemptID, string(raw))
	return err
}

func (r *Messages) Apply(ctx context.Context, result domain.ResultEnvelope, retry bool, execute repository.Executor) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var user, session string
	err = tx.QueryRowContext(ctx, `SELECT user_id,session_id FROM messages WHERE id=$1`, result.MessageID).Scan(&user, &session)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	state, err := lockConversation(ctx, tx, user, session)
	if err != nil {
		return err
	}
	m, err := scanMessage(tx.QueryRowContext(ctx, `SELECT `+messageColumns+` FROM messages WHERE id=$1 FOR UPDATE`, result.MessageID))
	if err != nil {
		return err
	}
	if m.Status != "processing" || m.AttemptID != result.AttemptID {
		return nil
	}
	sessionErr := r.checkMessageSession(ctx, tx, m.ID, m.UserID)
	if sessionErr != nil && !errors.Is(sessionErr, repository.ErrUnauthenticated) {
		return sessionErr
	}
	executed := false
	var reply domain.Reply
	if errors.Is(sessionErr, repository.ErrUnauthenticated) {
		reply = domain.ErrorReply("session_expired", "Сессия истекла или завершена. Войдите снова и повторите запрос.")
	} else if !time.Now().Before(m.DeadlineAt) {
		reply = domain.ErrorReply("llm_unavailable", "Не получилось обработать запрос вовремя. Попробуйте ещё раз.")
	} else if retry && m.Attempts < 2 {
		m.AttemptID = uuid.NewString()
		_, err = tx.ExecContext(ctx, `UPDATE messages SET attempt_id=$2,attempts=attempts+1 WHERE id=$1`, m.ID, m.AttemptID)
		if err != nil {
			return err
		}
		if err = enqueue(ctx, tx, m); err != nil {
			return err
		}
		return tx.Commit()
	} else {
		if _, err = tx.ExecContext(ctx, "SAVEPOINT execute_message"); err != nil {
			return err
		}
		executed = true
		reply, state, err = execute(ctx, &Items{db: tx}, m, state)
		if err != nil {
			return err
		}
	}
	// Повторная проверка перед фиксацией: ожидание блокировки могло пережить TTL сессии.
	if err := r.checkMessageSession(ctx, tx, m.ID, m.UserID); errors.Is(err, repository.ErrUnauthenticated) {
		if executed {
			if _, err := tx.ExecContext(ctx, "ROLLBACK TO SAVEPOINT execute_message"); err != nil {
				return err
			}
			state, err = lockConversation(ctx, tx, m.UserID, m.Request.SessionID)
			if err != nil {
				return err
			}
		}
		reply = domain.ErrorReply("session_expired", "Сессия истекла или завершена. Войдите снова и повторите запрос.")
	} else if err != nil {
		return err
	}

	state.History = append(state.History, domain.Turn{Role: "user", Text: m.ModelRequest.Text}, domain.Turn{Role: "assistant", Text: reply.Reply})
	if len(state.History) > 5 {
		state.History = state.History[len(state.History)-5:]
	}
	_, err = persistReply(ctx, tx, m, state, reply, "")
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (r *Messages) PublishPending(ctx context.Context, publish func(context.Context, domain.Job) error) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var id int64
	var raw []byte
	err = tx.QueryRowContext(ctx, `SELECT o.id,o.payload FROM message_outbox o JOIN messages m ON m.id=o.message_id
		WHERE o.published_at IS NULL AND m.status='processing' AND m.deadline_at>now() AND m.attempt_id=o.attempt_id
		ORDER BY o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED`).Scan(&id, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var job domain.Job
	if err = json.Unmarshal(raw, &job); err != nil {
		return err
	}
	if err = publish(ctx, job); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE message_outbox SET published_at=now() WHERE id=$1`, id)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (r *Messages) Expire(ctx context.Context) error {
	rows, err := r.db.QueryContext(ctx, `SELECT id,user_id FROM messages WHERE status IN ('processing','awaiting_input','awaiting_confirmation') AND deadline_at<=now() LIMIT 100`)
	if err != nil {
		return err
	}
	type expired struct{ id, user string }
	var results []expired
	for rows.Next() {
		var result expired
		if err = rows.Scan(&result.id, &result.user); err != nil {
			rows.Close()
			return err
		}
		results = append(results, result)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, result := range results {
		if _, err = r.terminate(ctx, result.user, result.id, true); err != nil {
			return err
		}
	}
	return nil
}

func (r *Messages) History(ctx context.Context, user, session string) ([]domain.Message, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT `+messageColumns+` FROM (SELECT * FROM messages WHERE user_id=$1 AND session_id=$2
 AND created_at > COALESCE((SELECT reset_at FROM conversation_resets WHERE user_id=$1 AND session_id=$2),'-infinity'::timestamptz)
 ORDER BY created_at DESC,id DESC LIMIT 100) m ORDER BY created_at,id`, user, session)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []domain.Message{}
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, m)
	}
	return items, rows.Err()
}
