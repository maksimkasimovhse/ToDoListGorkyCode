package postgres

import (
	"context"
	"database/sql"
	"errors"
	"gorky/backend/internal/domain"
	"gorky/backend/internal/repository"
	"time"
)

// Привязка к сессии хранится только в PostgreSQL: Bearer-токен не передаётся ML.
func (r *Messages) bindMessageSession(ctx context.Context, tx *sql.Tx, m domain.Message) error {
	session, ok := domain.AuthSessionFromContext(ctx)
	if !ok || session.UserID != m.UserID || !time.Now().Before(session.ExpiresAt) {
		return repository.ErrUnauthenticated
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO message_sessions(message_id,user_id,session_key,expires_at) VALUES($1,$2,$3,$4)`, m.ID, m.UserID, session.Key, session.ExpiresAt)
	return err
}
func (r *Messages) checkMessageSession(ctx context.Context, tx *sql.Tx, id, user string) error {
	var key string
	var expires time.Time
	var active bool
	err := tx.QueryRowContext(ctx, `SELECT s.session_key,s.expires_at,u.is_active FROM message_sessions s JOIN users u ON u.id=s.user_id WHERE s.message_id=$1 AND s.user_id=$2`, id, user).Scan(&key, &expires, &active)
	if errors.Is(err, sql.ErrNoRows) {
		return repository.ErrUnauthenticated
	}
	if err != nil {
		return err
	}
	if !active || !time.Now().Before(expires) {
		return repository.ErrUnauthenticated
	}
	session, err := r.sessions.Get(ctx, key)
	if err != nil {
		return err
	}
	if session.UserID != user {
		return repository.ErrUnauthenticated
	}
	return nil
}
