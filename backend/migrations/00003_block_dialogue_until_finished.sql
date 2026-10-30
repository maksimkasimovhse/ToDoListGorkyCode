-- +goose Up
CREATE TABLE message_answers (
    message_id uuid NOT NULL REFERENCES messages (id),
    input_token uuid NOT NULL,
    request jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, input_token)
);

-- +goose Down
DROP TABLE message_answers;
