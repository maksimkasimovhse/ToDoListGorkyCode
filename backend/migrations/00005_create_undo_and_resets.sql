-- +goose Up
CREATE TABLE undo_operations (
 token_hash text PRIMARY KEY CHECK(length(token_hash)=64),
 user_id uuid NOT NULL,
 changes jsonb NOT NULL CHECK(jsonb_typeof(changes)='array' AND jsonb_array_length(changes)>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 undone_at timestamptz,
 response jsonb,
 CHECK((undone_at IS NULL AND response IS NULL) OR (undone_at IS NOT NULL AND response IS NOT NULL))
);
CREATE INDEX undo_operations_user_idx ON undo_operations(user_id,created_at);

CREATE TABLE conversation_resets (
 user_id uuid NOT NULL,
 session_id text NOT NULL,
 reset_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,session_id),
 FOREIGN KEY(user_id,session_id) REFERENCES conversations(user_id,session_id) ON DELETE CASCADE
);

-- +goose Down
DROP TABLE conversation_resets;
DROP TABLE undo_operations;
