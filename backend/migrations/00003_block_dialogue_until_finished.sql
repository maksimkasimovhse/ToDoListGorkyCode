-- +goose Up
ALTER TABLE messages DROP CONSTRAINT messages_status_check;
ALTER TABLE messages DROP CONSTRAINT messages_check;
ALTER TABLE messages ADD COLUMN input_token uuid;
ALTER TABLE messages ADD CONSTRAINT messages_status_check CHECK (
    status IN ('processing', 'awaiting_input', 'awaiting_confirmation', 'completed', 'failed', 'cancelled')
);
ALTER TABLE messages ADD CONSTRAINT messages_state_check CHECK (
    (status = 'processing' AND response IS NULL AND finished_at IS NULL AND input_token IS NULL)
    OR (status IN ('awaiting_input', 'awaiting_confirmation') AND response IS NOT NULL AND finished_at IS NULL AND input_token IS NOT NULL)
    OR (status IN ('completed', 'failed', 'cancelled') AND response IS NOT NULL AND finished_at IS NOT NULL AND input_token IS NULL)
);
DROP INDEX messages_one_processing;
CREATE UNIQUE INDEX messages_one_active ON messages (user_id, session_id)
    WHERE status IN ('processing', 'awaiting_input', 'awaiting_confirmation');
DROP INDEX messages_deadline_idx;
CREATE INDEX messages_deadline_idx ON messages (deadline_at)
    WHERE status IN ('processing', 'awaiting_input', 'awaiting_confirmation');

CREATE TABLE message_answers (
    message_id uuid NOT NULL REFERENCES messages (id),
    input_token uuid NOT NULL,
    request jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, input_token)
);

-- +goose Down
DROP TABLE message_answers;
DROP INDEX messages_one_active;
DROP INDEX messages_deadline_idx;
ALTER TABLE messages DROP CONSTRAINT messages_state_check;
ALTER TABLE messages DROP CONSTRAINT messages_status_check;
UPDATE messages SET status='failed', finished_at=now()
    WHERE status IN ('awaiting_input', 'awaiting_confirmation', 'cancelled');
ALTER TABLE messages DROP COLUMN input_token;
ALTER TABLE messages ADD CONSTRAINT messages_status_check CHECK (status IN ('processing', 'completed', 'failed'));
ALTER TABLE messages ADD CONSTRAINT messages_check CHECK (
    (status='processing' AND response IS NULL AND finished_at IS NULL)
    OR (status<>'processing' AND response IS NOT NULL AND finished_at IS NOT NULL)
);
CREATE UNIQUE INDEX messages_one_processing ON messages (user_id, session_id) WHERE status='processing';
CREATE INDEX messages_deadline_idx ON messages (deadline_at) WHERE status='processing';
