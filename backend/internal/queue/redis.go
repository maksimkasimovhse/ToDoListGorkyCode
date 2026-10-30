// Пакет queue связывает Go-бэкенд и ML-модуль через Redis Streams.
package queue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"gorky/backend/internal/domain"
	"gorky/backend/internal/repository"
)

type Redis struct {
	client   *redis.Client
	requests string
	results  string
	group    string
	consumer string
}

func Open(ctx context.Context, address, requests, results, group string) (*Redis, error) {
	options, err := redis.ParseURL(address)
	if err != nil {
		return nil, fmt.Errorf("invalid REDIS_URL")
	}
	options.DialTimeout = 5 * time.Second
	options.ReadTimeout = 5 * time.Second
	options.WriteTimeout = 5 * time.Second
	options.ContextTimeoutEnabled = true
	options.MaxRetries = 1
	client := redis.NewClient(options)
	if err = client.Ping(ctx).Err(); err != nil {
		client.Close()
		return nil, fmt.Errorf("ping redis: %w", err)
	}
	bus := &Redis{client: client, requests: requests, results: results, group: group, consumer: uuid.NewString()}
	err = client.XGroupCreateMkStream(ctx, results, group, "0").Err()
	if err != nil && !strings.HasPrefix(err.Error(), "BUSYGROUP") {
		client.Close()
		return nil, err
	}
	return bus, nil
}

func (r *Redis) Close() error { return r.client.Close() }

func (r *Redis) Publish(ctx context.Context, job domain.Job) error {
	raw, err := json.Marshal(job)
	if err != nil {
		return err
	}
	return r.client.XAdd(ctx, &redis.XAddArgs{Stream: r.requests, Values: map[string]any{"payload": string(raw)}}).Err()
}

// Start запускает публикацию outbox, обработку результатов и завершение просроченных сообщений.
// Возвращённая функция ждёт остановки всех обработчиков после отмены контекста.
func (r *Redis) Start(ctx context.Context, store repository.MessageRepository, handle func(context.Context, domain.ResultEnvelope) error, logger *slog.Logger) func() {
	var wg sync.WaitGroup
	run := func(fn func()) { wg.Add(1); go func() { defer wg.Done(); fn() }() }
	run(func() {
		r.periodic(ctx, 100*time.Millisecond, logger, "publish outbox", func(ctx context.Context) error { return store.PublishPending(ctx, r.Publish) })
	})
	run(func() { r.periodic(ctx, time.Second, logger, "expire messages", store.Expire) })
	run(func() { r.consume(ctx, handle, logger) })
	return wg.Wait
}

func (r *Redis) periodic(ctx context.Context, interval time.Duration, logger *slog.Logger, name string, fn func(context.Context) error) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			opCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err := fn(opCtx)
			cancel()
			if err != nil && ctx.Err() == nil {
				logger.Error(name, "error", err)
			}
		}
	}
}

func (r *Redis) consume(ctx context.Context, handle func(context.Context, domain.ResultEnvelope) error, logger *slog.Logger) {
	cursor := "0-0"
	for ctx.Err() == nil {
		pending, next, err := r.client.XAutoClaim(ctx, &redis.XAutoClaimArgs{Stream: r.results, Group: r.group, Consumer: r.consumer, MinIdle: 30 * time.Second, Start: cursor, Count: 20}).Result()
		if err != nil && !errors.Is(err, redis.Nil) {
			if ctx.Err() != nil {
				return
			}
			logger.Error("claim results", "error", err)
			if !pause(ctx) {
				return
			}
			continue
		}
		cursor = next
		if cursor == "" {
			cursor = "0-0"
		}
		for _, entry := range pending {
			r.process(ctx, entry, handle, logger)
		}
		streams, err := r.client.XReadGroup(ctx, &redis.XReadGroupArgs{Group: r.group, Consumer: r.consumer, Streams: []string{r.results, ">"}, Count: 20, Block: time.Second}).Result()
		if errors.Is(err, redis.Nil) {
			continue
		}
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			logger.Error("read results", "error", err)
			if !pause(ctx) {
				return
			}
			continue
		}
		for _, stream := range streams {
			for _, entry := range stream.Messages {
				r.process(ctx, entry, handle, logger)
			}
		}
	}
}

func pause(ctx context.Context) bool {
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (r *Redis) process(ctx context.Context, entry redis.XMessage, handle func(context.Context, domain.ResultEnvelope) error, logger *slog.Logger) {
	opCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	payload, ok := entry.Values["payload"].(string)
	var envelope domain.ResultEnvelope
	valid := ok && len(payload) <= 1024*1024 && json.Unmarshal([]byte(payload), &envelope) == nil
	if valid {
		_, err1 := uuid.Parse(envelope.MessageID)
		_, err2 := uuid.Parse(envelope.AttemptID)
		valid = err1 == nil && err2 == nil
	}
	if !valid {
		logger.Error("discard malformed result envelope", "stream_id", entry.ID)
	} else if err := handle(opCtx, envelope); err != nil {
		logger.Error("apply model result", "stream_id", entry.ID, "error", err)
		return
	}
	// Подтверждение отправляется только после фиксации результата в PostgreSQL.
	if err := r.client.XAck(opCtx, r.results, r.group, entry.ID).Err(); err != nil {
		logger.Error("ack result", "error", err)
		return
	}
	if err := r.client.XDel(opCtx, r.results, entry.ID).Err(); err != nil {
		logger.Error("delete acknowledged result", "error", err)
	}
}
