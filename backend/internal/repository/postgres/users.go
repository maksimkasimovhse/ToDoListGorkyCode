package postgres

import (
	"context"
	"database/sql"
	"errors"
	"gorky/backend/internal/domain"
	"gorky/backend/internal/repository"
)

type Users struct{ db *sql.DB }

func NewUsers(db *sql.DB) *Users { return &Users{db: db} }

func scanUser(row *sql.Row) (domain.User, error) {
	var user domain.User
	err := row.Scan(&user.ID, &user.Login, &user.Timezone, &user.PasswordHash, &user.Active)
	if errors.Is(err, sql.ErrNoRows) {
		return user, repository.ErrNotFound
	}
	return user, err
}
func (r *Users) GetByLogin(ctx context.Context, login string) (domain.User, error) {
	return scanUser(r.db.QueryRowContext(ctx, `SELECT id,login,timezone,password_hash,is_active FROM users WHERE login=$1`, login))
}
func (r *Users) GetByID(ctx context.Context, id string) (domain.User, error) {
	return scanUser(r.db.QueryRowContext(ctx, `SELECT id,login,timezone,password_hash,is_active FROM users WHERE id=$1`, id))
}
