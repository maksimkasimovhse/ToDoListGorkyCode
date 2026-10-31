package domain

import (
	"context"
	"time"
)

type User struct {
	ID           string `json:"id"`
	Login        string `json:"login"`
	Timezone     string `json:"timezone"`
	PasswordHash string `json:"-"`
	Active       bool   `json:"-"`
}

// AuthSession не связана с session_id диалога. Key — хеш секретного Bearer-токена.
type AuthSession struct {
	Key       string    `json:"-"`
	UserID    string    `json:"user_id"`
	ExpiresAt time.Time `json:"expires_at"`
}

type authSessionKey struct{}

func WithAuthSession(ctx context.Context, session AuthSession) context.Context {
	return context.WithValue(ctx, authSessionKey{}, session)
}
func AuthSessionFromContext(ctx context.Context) (AuthSession, bool) {
	session, ok := ctx.Value(authSessionKey{}).(AuthSession)
	return session, ok
}
