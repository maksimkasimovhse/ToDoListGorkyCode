-- +goose Up
CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 login text NOT NULL UNIQUE CHECK (login=lower(btrim(login)) AND length(login) BETWEEN 1 AND 64),
 password_hash text NOT NULL,
 timezone text NOT NULL DEFAULT 'Europe/Moscow',
 is_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);

-- Тестовые аккаунты для локального прототипа. Первый сохраняет владельца прежних демозаписей.
INSERT INTO users(id,login,password_hash) VALUES
 ('00000000-0000-0000-0000-000000000001','demo1','pbkdf2-sha256$600000$AXiSLo3QCX/Ed3BgICWK8w$PIkq+qMYAiM/GcmOgUmBL3U8rJuWevgH6ZL5WDhHqvI'),
 ('00000000-0000-0000-0000-000000000002','demo2','pbkdf2-sha256$600000$K4W0cs1bLr6JrDmfzlBA5g$Qejznwoatt62r7OPkPeIq1hRHmsmYMSJngyRDxo4NCU');

CREATE TABLE message_sessions (
 message_id uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id),
 session_key text NOT NULL CHECK (length(session_key)=64),
 expires_at timestamptz NOT NULL
);

-- +goose Down
DROP TABLE message_sessions;
DROP TABLE users;
