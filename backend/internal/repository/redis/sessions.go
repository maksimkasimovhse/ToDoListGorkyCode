// Пакет redis хранит сессии авторизации отдельно от потоков заданий ML.
package redis

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/redis/go-redis/v9"
	"gorky/backend/internal/domain"
	"gorky/backend/internal/repository"
	"time"
)

type Sessions struct {
	client *redis.Client
	prefix string
}

func NewSessions(client *redis.Client, prefix string) *Sessions {
	return &Sessions{client: client, prefix: prefix}
}
func OpenSessions(ctx context.Context, address string) (*Sessions, error) {
	options, err := redis.ParseURL(address)
	if err != nil {
		return nil, errors.New("invalid REDIS_URL")
	}
	options.DialTimeout = 5 * time.Second
	options.ReadTimeout = 5 * time.Second
	options.WriteTimeout = 5 * time.Second
	options.ContextTimeoutEnabled = true
	options.MaxRetries = 1
	client := redis.NewClient(options)
	if err := client.Ping(ctx).Err(); err != nil {
		client.Close()
		return nil, err
	}
	return NewSessions(client, "planner:auth:"), nil
}
func (r *Sessions) Close() error { return r.client.Close() }
func (r *Sessions) Create(ctx context.Context, session domain.AuthSession) (bool, error) {
	ttl := time.Until(session.ExpiresAt)
	if ttl <= 0 {
		return false, repository.ErrUnauthenticated
	}
	raw, err := json.Marshal(session)
	if err != nil {
		return false, err
	}
	return r.client.SetNX(ctx, r.prefix+"session:"+session.Key, string(raw), ttl).Result()
}
func (r *Sessions) Get(ctx context.Context, key string) (domain.AuthSession, error) {
	raw, err := r.client.Get(ctx, r.prefix+"session:"+key).Bytes()
	if errors.Is(err, redis.Nil) {
		return domain.AuthSession{}, repository.ErrUnauthenticated
	}
	if err != nil {
		return domain.AuthSession{}, err
	}
	var session domain.AuthSession
	if err := json.Unmarshal(raw, &session); err != nil {
		return session, err
	}
	session.Key = key
	if session.UserID == "" || !time.Now().Before(session.ExpiresAt) {
		return session, repository.ErrUnauthenticated
	}
	return session, nil
}
func (r *Sessions) Delete(ctx context.Context, key string) error {
	return r.client.Del(ctx, r.prefix+"session:"+key).Err()
}

// Ограничение попыток общее для всех экземпляров API; адрес берётся из RemoteAddr.
var loginLimit = redis.NewScript(`local count=redis.call('INCR',KEYS[1]); if count==1 then redis.call('PEXPIRE',KEYS[1],60000) end; return count`)

func (r *Sessions) AllowLogin(ctx context.Context, address string) (bool, error) {
	sum := sha256.Sum256([]byte(address))
	count, err := loginLimit.Run(ctx, r.client, []string{r.prefix + "login:" + hex.EncodeToString(sum[:])}).Int64()
	return count <= 20, err
}
