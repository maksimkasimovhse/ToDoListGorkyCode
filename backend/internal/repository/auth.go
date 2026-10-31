package repository

import (
	"context"
	"errors"
	"gorky/backend/internal/domain"
)

var ErrUnauthenticated = errors.New("session is missing, revoked or expired")

type UserRepository interface {
	GetByLogin(context.Context, string) (domain.User, error)
	GetByID(context.Context, string) (domain.User, error)
}

type SessionRepository interface {
	Create(context.Context, domain.AuthSession) (bool, error)
	Get(context.Context, string) (domain.AuthSession, error)
	Delete(context.Context, string) error
	AllowLogin(context.Context, string) (bool, error)
}
