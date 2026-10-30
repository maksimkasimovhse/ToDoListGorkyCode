-- +goose Up
CREATE TABLE items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    type text NOT NULL CHECK (type IN ('task', 'reminder', 'meeting')),
    title text NOT NULL CHECK (length(btrim(title)) > 0),
    source_text text NOT NULL,
    due_date date,
    due_at timestamptz,
    period_start timestamptz,
    period_end timestamptz,
    start_at timestamptz,
    end_at timestamptz,
    all_day boolean NOT NULL DEFAULT false,
    participants text[] NOT NULL DEFAULT '{}',
    location text,
    remind_at timestamptz,
    status text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    deleted_at timestamptz,

    CONSTRAINT items_status_by_type CHECK (
        (type IN ('task', 'reminder') AND status IN ('open', 'done')) OR
        (type = 'meeting' AND status IN ('scheduled', 'cancelled'))
    ),
    CONSTRAINT items_task_deadline CHECK (
        num_nonnulls(due_date, due_at, period_start) <= 1
        AND (period_start IS NULL) = (period_end IS NULL)
        AND (period_end IS NULL OR period_end > period_start)
    ),
    CONSTRAINT items_deadline_type CHECK (
        type = 'task' OR
        (due_date IS NULL AND due_at IS NULL AND period_start IS NULL AND period_end IS NULL)
    ),
    CONSTRAINT items_meeting_time CHECK (
        (type = 'meeting' AND start_at IS NOT NULL AND end_at IS NOT NULL AND end_at > start_at)
        OR (type <> 'meeting' AND start_at IS NULL AND end_at IS NULL AND NOT all_day)
    ),
    CONSTRAINT items_reminder_time CHECK (type <> 'reminder' OR remind_at IS NOT NULL),
    CONSTRAINT items_task_no_reminder CHECK (type <> 'task' OR remind_at IS NULL),
    CONSTRAINT items_completion CHECK (
        (status = 'done' AND completed_at IS NOT NULL)
        OR (status <> 'done' AND completed_at IS NULL)
    )
);

CREATE INDEX items_user_due_date_idx ON items (user_id, due_date) WHERE deleted_at IS NULL;
CREATE INDEX items_user_due_at_idx ON items (user_id, due_at) WHERE deleted_at IS NULL;
CREATE INDEX items_user_start_at_idx ON items (user_id, start_at) WHERE deleted_at IS NULL;
CREATE INDEX items_user_remind_at_idx ON items (user_id, remind_at) WHERE deleted_at IS NULL;

-- +goose Down
DROP TABLE items;
