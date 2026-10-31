-- +goose Up
-- Серверные уведомления о встречах и напоминаниях: за 15 минут и в момент начала, утренняя сводка.
-- Строки уведомлений пересчитывает триггер на items, поэтому любой путь изменения записи
-- (ручная правка, ассистент, отмена действия) автоматически обновляет расписание.

CREATE TABLE notification_settings (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    digest_enabled boolean NOT NULL DEFAULT true,
    digest_time time NOT NULL DEFAULT '07:30',
    quiet_enabled boolean NOT NULL DEFAULT false,
    quiet_start time NOT NULL DEFAULT '23:00',
    quiet_end time NOT NULL DEFAULT '08:00',
    -- Локальная дата последней поставленной в очередь сводки: не больше одной в день
    digest_planned_on date,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT notification_settings_quiet CHECK (quiet_start <> quiet_end)
);

-- Привязка мессенджеров. session_key — хеш долгоживущего токена, выданного боту для этого пользователя
CREATE TABLE user_channels (
    channel text NOT NULL CHECK (channel IN ('max')),
    external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 64),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT true,
    session_key text CHECK (session_key IS NULL OR length(session_key) = 64),
    linked_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (channel, external_id)
);
CREATE INDEX user_channels_user_idx ON user_channels (user_id) WHERE enabled;

-- Одноразовые коды для привязки по ссылке https://max.ru/<бот>?start=<код>
CREATE TABLE channel_link_codes (
    code text PRIMARY KEY CHECK (length(code) BETWEEN 8 AND 64),
    channel text NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);

CREATE TABLE notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Без внешнего ключа на users: у items его тоже нет, триггер не должен ломать сохранение записи
    user_id uuid NOT NULL,
    item_id uuid REFERENCES items(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('soon', 'now', 'digest')),
    -- Момент события (начало встречи, время напоминания) или момент сводки
    event_at timestamptz NOT NULL,
    fire_at timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'queued', 'sent', 'cancelled', 'skipped', 'failed')),
    -- Отложено тихими часами: в тексте показываем, что событие уже было
    held boolean NOT NULL DEFAULT false,
    attempts int NOT NULL DEFAULT 0,
    queued_at timestamptz,
    sent_at timestamptz,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT notifications_item_kind CHECK ((kind = 'digest') = (item_id IS NULL))
);
CREATE UNIQUE INDEX notifications_item_event_idx ON notifications (item_id, kind, event_at) WHERE item_id IS NOT NULL;
CREATE UNIQUE INDEX notifications_digest_idx ON notifications (user_id, event_at) WHERE kind = 'digest';
CREATE INDEX notifications_due_idx ON notifications (fire_at) WHERE status = 'pending';
CREATE INDEX notifications_queued_idx ON notifications (queued_at) WHERE status = 'queued';

-- Момент, о котором уведомляем: время напоминания или начало встречи (кроме встреч на весь день).
-- Задачи не уведомляют.
-- +goose StatementBegin
CREATE FUNCTION item_notification_moment(i items) RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN i.deleted_at IS NOT NULL THEN NULL
        WHEN i.type = 'reminder' AND i.status = 'open' THEN i.remind_at
        WHEN i.type = 'meeting' AND i.status = 'scheduled' AND NOT i.all_day THEN i.start_at
    END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION sync_item_notifications() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    moment timestamptz;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        UPDATE notifications SET status = 'cancelled'
        WHERE item_id = OLD.id AND status = 'pending';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    moment := item_notification_moment(NEW);
    -- Давно прошедшие события не уведомляют: запись создали задним числом
    IF moment IS NULL OR moment < now() - interval '60 minutes' THEN
        RETURN NEW;
    END IF;
    -- «Скоро» для встречи, созданной меньше чем за 15 минут, уходит сразу («через 7 минут»), если до
    -- начала больше минуты. Напоминание, поставленное или отложенное меньше чем на 15 минут, сразу
    -- «скоро» не присылает: пользователь только что задал это время сам.
    IF (NEW.type = 'meeting' AND moment - now() > interval '1 minute')
       OR (NEW.type = 'reminder' AND moment - now() >= interval '15 minutes') THEN
        INSERT INTO notifications (user_id, item_id, kind, event_at, fire_at)
        VALUES (NEW.user_id, NEW.id, 'soon', moment, greatest(moment - interval '15 minutes', now()))
        ON CONFLICT (item_id, kind, event_at) WHERE item_id IS NOT NULL
        DO UPDATE SET status = 'pending', fire_at = EXCLUDED.fire_at, held = false
        WHERE notifications.status = 'cancelled';
    END IF;
    -- Уже отправленное уведомление о том же моменте не повторяется: конфликт оставляет строку как есть
    INSERT INTO notifications (user_id, item_id, kind, event_at, fire_at)
    VALUES (NEW.user_id, NEW.id, 'now', moment, moment)
    ON CONFLICT (item_id, kind, event_at) WHERE item_id IS NOT NULL
    DO UPDATE SET status = 'pending', fire_at = EXCLUDED.fire_at, held = false
    WHERE notifications.status = 'cancelled';
    RETURN NEW;
END
$$;
-- +goose StatementEnd

CREATE TRIGGER items_sync_notifications
AFTER INSERT OR DELETE OR UPDATE OF type, status, remind_at, start_at, all_day, deleted_at ON items
FOR EACH ROW EXECUTE FUNCTION sync_item_notifications();

-- Будущие события, созданные до появления уведомлений
INSERT INTO notifications (user_id, item_id, kind, event_at, fire_at)
SELECT i.user_id, i.id, k.kind, item_notification_moment(i),
       CASE WHEN k.kind = 'soon' THEN greatest(item_notification_moment(i) - interval '15 minutes', now()) ELSE item_notification_moment(i) END
FROM items i
CROSS JOIN (VALUES ('soon'), ('now')) AS k(kind)
WHERE item_notification_moment(i) > now() + interval '1 minute'
  AND (k.kind = 'now' OR i.type = 'meeting' OR item_notification_moment(i) - now() >= interval '15 minutes')
ON CONFLICT DO NOTHING;

-- +goose Down
DROP TRIGGER items_sync_notifications ON items;
DROP FUNCTION sync_item_notifications();
DROP FUNCTION item_notification_moment(items);
DROP TABLE notifications;
DROP TABLE channel_link_codes;
DROP TABLE user_channels;
DROP TABLE notification_settings;
