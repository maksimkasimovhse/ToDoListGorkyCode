package queue

import (
	"context"

	"github.com/redis/go-redis/v9"
)

// NotifyStreamPrefix — потоки доставки уведомлений, по одному на канал: planner:notify:max.
const NotifyStreamPrefix = "planner:notify:"

// PublishNotification кладёт доставку в поток канала. Поток ограничен по длине, чтобы
// неподключённый бот не копил данные бесконечно; неподтверждённые строки бэкенд переотправит сам.
func (r *Redis) PublishNotification(ctx context.Context, channel string, payload []byte) error {
	return r.client.XAdd(ctx, &redis.XAddArgs{
		Stream: NotifyStreamPrefix + channel,
		MaxLen: 10000,
		Approx: true,
		Values: map[string]any{"payload": string(payload)},
	}).Err()
}
