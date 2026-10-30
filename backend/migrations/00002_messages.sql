-- +goose Up
CREATE TABLE conversations (
    user_id uuid NOT NULL,
    session_id text NOT NULL,
    state jsonb NOT NULL DEFAULT '{}',
    PRIMARY KEY (user_id, session_id)
);

CREATE TABLE messages (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    session_id text NOT NULL,
    client_message_id text NOT NULL,
    request jsonb NOT NULL,
    model_request jsonb NOT NULL,
    attempt_id uuid NOT NULL,
    attempts integer NOT NULL DEFAULT 1,
    status text NOT NULL DEFAULT 'processing',
    input_token uuid,
    response jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    deadline_at timestamptz NOT NULL,
    finished_at timestamptz,
    UNIQUE (user_id, session_id, client_message_id),
    FOREIGN KEY (user_id, session_id) REFERENCES conversations (user_id, session_id),
    CONSTRAINT messages_status_check CHECK (
        status IN ('processing', 'awaiting_input', 'awaiting_confirmation', 'completed', 'failed', 'cancelled')
    ),
    CONSTRAINT messages_state_check CHECK (
        (status = 'processing' AND response IS NULL AND finished_at IS NULL AND input_token IS NULL)
        OR (status IN ('awaiting_input', 'awaiting_confirmation') AND response IS NOT NULL AND finished_at IS NULL AND input_token IS NOT NULL)
        OR (status IN ('completed', 'failed', 'cancelled') AND response IS NOT NULL AND finished_at IS NOT NULL AND input_token IS NULL)
    )
);

CREATE UNIQUE INDEX messages_one_active ON messages (user_id, session_id)
    WHERE status IN ('processing', 'awaiting_input', 'awaiting_confirmation');
CREATE INDEX messages_deadline_idx ON messages (deadline_at)
    WHERE status IN ('processing', 'awaiting_input', 'awaiting_confirmation');

CREATE TABLE message_outbox (
    id bigserial PRIMARY KEY,
    message_id uuid NOT NULL REFERENCES messages (id),
    attempt_id uuid NOT NULL UNIQUE,
    payload jsonb NOT NULL,
    published_at timestamptz
);
CREATE INDEX message_outbox_pending_idx ON message_outbox (id) WHERE published_at IS NULL;

-- +goose Down
DROP TABLE message_outbox;
DROP TABLE messages;
DROP TABLE conversations;
