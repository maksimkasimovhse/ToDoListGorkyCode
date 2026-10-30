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
    status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
    response jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    deadline_at timestamptz NOT NULL,
    finished_at timestamptz,
    UNIQUE (user_id, session_id, client_message_id),
    FOREIGN KEY (user_id, session_id) REFERENCES conversations (user_id, session_id),
    CHECK ((status = 'processing' AND response IS NULL AND finished_at IS NULL)
        OR (status <> 'processing' AND response IS NOT NULL AND finished_at IS NOT NULL))
);

CREATE UNIQUE INDEX messages_one_processing ON messages (user_id, session_id) WHERE status = 'processing';
CREATE INDEX messages_deadline_idx ON messages (deadline_at) WHERE status = 'processing';

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
