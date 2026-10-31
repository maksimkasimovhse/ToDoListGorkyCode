package service

import (
	"context"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"gorky/backend/internal/domain"
	"gorky/backend/internal/repository"
)

var ErrCredentials = errors.New("invalid credentials")
var ErrAuthUnavailable = errors.New("authentication storage unavailable")
var ErrLoginLimit = errors.New("too many login attempts")

type Auth struct {
	users    repository.UserRepository
	sessions repository.SessionRepository
	ttl      time.Duration
}
type LoginResult struct {
	Token     string      `json:"token"`
	User      domain.User `json:"user"`
	ExpiresAt time.Time   `json:"expires_at"`
}

func NewAuth(users repository.UserRepository, sessions repository.SessionRepository, ttl time.Duration) *Auth {
	return &Auth{users: users, sessions: sessions, ttl: ttl}
}

func SessionKey(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// Пароль проверяется по PBKDF2-HMAC-SHA256, а не сравнением открытых паролей в SELECT.
func checkPassword(password, encoded string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2-sha256" || parts[1] != "600000" {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[2])
	if err != nil || len(salt) != 16 {
		return false
	}
	expected, err := base64.RawStdEncoding.DecodeString(parts[3])
	if err != nil || len(expected) != 32 {
		return false
	}
	actual, err := pbkdf2.Key(sha256.New, password, salt, 600000, 32)
	return err == nil && subtle.ConstantTimeCompare(actual, expected) == 1
}

func (a *Auth) Login(ctx context.Context, login, password, address string) (LoginResult, error) {
	allowed, err := a.sessions.AllowLogin(ctx, address)
	if err != nil {
		return LoginResult{}, fmt.Errorf("%w: %v", ErrAuthUnavailable, err)
	}
	if !allowed {
		return LoginResult{}, ErrLoginLimit
	}
	login = strings.ToLower(strings.TrimSpace(login))
	if len(login) == 0 || len(login) > 64 || len(password) == 0 || len(password) > 1024 {
		return LoginResult{}, ErrCredentials
	}
	user, err := a.users.GetByLogin(ctx, login)
	if err != nil && !errors.Is(err, repository.ErrNotFound) {
		return LoginResult{}, fmt.Errorf("%w: %v", ErrAuthUnavailable, err)
	}
	hash := user.PasswordHash
	if errors.Is(err, repository.ErrNotFound) {
		hash = dummyPasswordHash
	}
	valid := checkPassword(password, hash)
	if !valid || err != nil || !user.Active {
		return LoginResult{}, ErrCredentials
	}
	if a.ttl <= 0 {
		return LoginResult{}, ErrAuthUnavailable
	}
	for range 3 {
		secret := make([]byte, 32)
		if _, err := rand.Read(secret); err != nil {
			return LoginResult{}, err
		}
		token := base64.RawURLEncoding.EncodeToString(secret)
		expires := time.Now().UTC().Add(a.ttl)
		created, err := a.sessions.Create(ctx, domain.AuthSession{Key: SessionKey(token), UserID: user.ID, ExpiresAt: expires})
		if err != nil {
			return LoginResult{}, fmt.Errorf("%w: %v", ErrAuthUnavailable, err)
		}
		if created {
			return LoginResult{Token: token, User: user, ExpiresAt: expires}, nil
		}
	}
	return LoginResult{}, ErrAuthUnavailable
}

func (a *Auth) Authenticate(ctx context.Context, token string) (domain.AuthSession, domain.User, error) {
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) != 32 || len(token) != 43 {
		return domain.AuthSession{}, domain.User{}, repository.ErrUnauthenticated
	}
	session, err := a.sessions.Get(ctx, SessionKey(token))
	if errors.Is(err, repository.ErrUnauthenticated) {
		return session, domain.User{}, err
	}
	if err != nil {
		return session, domain.User{}, fmt.Errorf("%w: %v", ErrAuthUnavailable, err)
	}
	user, err := a.users.GetByID(ctx, session.UserID)
	if errors.Is(err, repository.ErrNotFound) || (err == nil && !user.Active) {
		return session, user, repository.ErrUnauthenticated
	}
	if err != nil {
		return session, user, fmt.Errorf("%w: %v", ErrAuthUnavailable, err)
	}
	return session, user, nil
}
func (a *Auth) Logout(ctx context.Context, key string) error {
	if err := a.sessions.Delete(ctx, key); err != nil {
		return fmt.Errorf("%w: %v", ErrAuthUnavailable, err)
	}
	return nil
}

// Для неизвестного логина выполняется такая же по стоимости проверка пароля.
const dummyPasswordHash = "pbkdf2-sha256$600000$AXiSLo3QCX/Ed3BgICWK8w$PIkq+qMYAiM/GcmOgUmBL3U8rJuWevgH6ZL5WDhHqvI"
