package postgres

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"gorky/backend/internal/domain"
	"gorky/backend/internal/repository"
)

type Notifications struct{ db *sql.DB }

func NewNotifications(db *sql.DB) *Notifications { return &Notifications{db: db} }

const settingsColumns = `COALESCE(s.digest_enabled,true), to_char(COALESCE(s.digest_time,'07:30'),'HH24:MI'),
 COALESCE(s.quiet_enabled,false), to_char(COALESCE(s.quiet_start,'23:00'),'HH24:MI'), to_char(COALESCE(s.quiet_end,'08:00'),'HH24:MI')`

func scanSettings(dest *domain.NotificationSettings) []any {
	return []any{&dest.DigestEnabled, &dest.DigestTime, &dest.QuietEnabled, &dest.QuietStart, &dest.QuietEnd}
}

func (r *Notifications) Settings(ctx context.Context, userID string) (domain.NotificationSettings, error) {
	var settings domain.NotificationSettings
	err := r.db.QueryRowContext(ctx, `SELECT `+settingsColumns+` FROM (SELECT $1::uuid AS id) u
		LEFT JOIN notification_settings s ON s.user_id=u.id`, userID).Scan(scanSettings(&settings)...)
	return settings, err
}

func (r *Notifications) SaveSettings(ctx context.Context, userID string, s domain.NotificationSettings) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `INSERT INTO notification_settings(user_id,digest_enabled,digest_time,quiet_enabled,quiet_start,quiet_end)
		VALUES($1,$2,$3,$4,$5,$6)
		ON CONFLICT (user_id) DO UPDATE SET digest_enabled=EXCLUDED.digest_enabled, digest_time=EXCLUDED.digest_time,
		 quiet_enabled=EXCLUDED.quiet_enabled, quiet_start=EXCLUDED.quiet_start, quiet_end=EXCLUDED.quiet_end, updated_at=now()`,
		userID, s.DigestEnabled, string(s.DigestTime), s.QuietEnabled, string(s.QuietStart), string(s.QuietEnd)); err != nil {
		return err
	}
	// Ещё не отправленная сводка перепланируется по новым настройкам. Если сегодняшняя уже ушла,
	// второй за день не будет.
	if _, err := tx.ExecContext(ctx, `UPDATE notifications SET status='cancelled' WHERE user_id=$1 AND kind='digest' AND status='pending'`, userID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE notification_settings s SET digest_planned_on=NULL
		WHERE s.user_id=$1 AND NOT EXISTS (
		  SELECT 1 FROM notifications n JOIN users u ON u.id=n.user_id
		  WHERE n.user_id=$1 AND n.kind='digest' AND n.status IN ('queued','sent')
		    AND (n.event_at AT TIME ZONE u.timezone)::date = (now() AT TIME ZONE u.timezone)::date)`, userID); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *Notifications) CreateLinkCode(ctx context.Context, channel, userID, code string, expires time.Time) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Действует только последний код пользователя
	if _, err := tx.ExecContext(ctx, `DELETE FROM channel_link_codes WHERE (user_id=$1 AND channel=$2) OR expires_at<now()`, userID, channel); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO channel_link_codes(code,channel,user_id,expires_at) VALUES($1,$2,$3,$4)`, code, channel, userID, expires); err != nil {
		return err
	}
	return tx.Commit()
}

// ConsumeLinkCode удаляет код в любом случае; просроченный код и неактивный пользователь не принимаются.
func (r *Notifications) ConsumeLinkCode(ctx context.Context, channel, code string) (string, error) {
	var userID string
	var fresh, active bool
	err := r.db.QueryRowContext(ctx, `WITH used AS (DELETE FROM channel_link_codes WHERE code=$1 AND channel=$2 RETURNING user_id, expires_at>now() AS fresh)
		SELECT used.user_id, used.fresh, COALESCE(u.is_active,false) FROM used LEFT JOIN users u ON u.id=used.user_id`, code, channel).Scan(&userID, &fresh, &active)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && (!fresh || !active)) {
		return "", repository.ErrLinkCode
	}
	return userID, err
}

func (r *Notifications) LinkChannel(ctx context.Context, c domain.Channel) (*string, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var previous sql.NullString
	err = tx.QueryRowContext(ctx, `SELECT session_key FROM user_channels WHERE channel=$1 AND external_id=$2 FOR UPDATE`, c.Channel, c.ExternalID).Scan(&previous)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO user_channels(channel,external_id,user_id,enabled,session_key) VALUES($1,$2,$3,true,$4)
		ON CONFLICT (channel,external_id) DO UPDATE SET user_id=EXCLUDED.user_id, enabled=true, session_key=EXCLUDED.session_key, linked_at=now()`,
		c.Channel, c.ExternalID, c.UserID, c.SessionKey); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	if previous.Valid {
		return &previous.String, nil
	}
	return nil, nil
}

const channelColumns = `channel,external_id,user_id,enabled,linked_at,session_key`

func scanChannel(scan func(...any) error) (domain.Channel, error) {
	var c domain.Channel
	var key sql.NullString
	err := scan(&c.Channel, &c.ExternalID, &c.UserID, &c.Enabled, &c.LinkedAt, &key)
	if key.Valid {
		c.SessionKey = &key.String
	}
	return c, err
}

func (r *Notifications) Channel(ctx context.Context, channel, externalID string) (domain.Channel, error) {
	c, err := scanChannel(r.db.QueryRowContext(ctx, `SELECT `+channelColumns+` FROM user_channels WHERE channel=$1 AND external_id=$2`, channel, externalID).Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return c, repository.ErrNotFound
	}
	return c, err
}

func (r *Notifications) UserChannels(ctx context.Context, userID string) ([]domain.Channel, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT `+channelColumns+` FROM user_channels WHERE user_id=$1 ORDER BY linked_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	channels := []domain.Channel{}
	for rows.Next() {
		c, err := scanChannel(rows.Scan)
		if err != nil {
			return nil, err
		}
		channels = append(channels, c)
	}
	return channels, rows.Err()
}

func (r *Notifications) SetChannelEnabled(ctx context.Context, channel, externalID string, enabled bool) error {
	result, err := r.db.ExecContext(ctx, `UPDATE user_channels SET enabled=$3 WHERE channel=$1 AND external_id=$2`, channel, externalID, enabled)
	return affected(result, err)
}

func (r *Notifications) UnlinkChannel(ctx context.Context, channel, externalID string) (*string, error) {
	var key sql.NullString
	err := r.db.QueryRowContext(ctx, `DELETE FROM user_channels WHERE channel=$1 AND external_id=$2 RETURNING session_key`, channel, externalID).Scan(&key)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, repository.ErrNotFound
	}
	if err != nil || !key.Valid {
		return nil, err
	}
	return &key.String, nil
}

func affected(result sql.Result, err error) error {
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return repository.ErrNotFound
	}
	return nil
}

func (r *Notifications) RequeueStale(ctx context.Context, olderThan time.Duration) (int64, error) {
	result, err := r.db.ExecContext(ctx, `UPDATE notifications SET status='pending', queued_at=NULL
		WHERE status='queued' AND queued_at < now() - make_interval(secs => $1)`, olderThan.Seconds())
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

func (r *Notifications) DigestCandidates(ctx context.Context) ([]repository.DigestCandidate, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT u.id, u.timezone, `+settingsColumns+`, s.digest_planned_on
		FROM users u LEFT JOIN notification_settings s ON s.user_id=u.id
		WHERE u.is_active AND COALESCE(s.digest_enabled,true)
		  AND EXISTS (SELECT 1 FROM user_channels c WHERE c.user_id=u.id AND c.enabled)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []repository.DigestCandidate
	for rows.Next() {
		var c repository.DigestCandidate
		var planned sql.NullTime
		if err := rows.Scan(append([]any{&c.UserID, &c.Timezone}, append(scanSettings(&c.Settings), &planned)...)...); err != nil {
			return nil, err
		}
		if planned.Valid {
			c.PlannedOn = &planned.Time
		}
		result = append(result, c)
	}
	return result, rows.Err()
}

func (r *Notifications) PlanDigest(ctx context.Context, userID string, day time.Time, moment time.Time) (bool, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	date := day.Format("2006-01-02")
	result, err := tx.ExecContext(ctx, `INSERT INTO notification_settings(user_id,digest_planned_on) VALUES($1,$2::date)
		ON CONFLICT (user_id) DO UPDATE SET digest_planned_on=EXCLUDED.digest_planned_on
		WHERE notification_settings.digest_planned_on IS NULL OR notification_settings.digest_planned_on < EXCLUDED.digest_planned_on`, userID, date)
	if err != nil {
		return false, err
	}
	if n, _ := result.RowsAffected(); n == 0 {
		return false, nil
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO notifications(user_id,kind,event_at,fire_at) VALUES($1,'digest',$2,$2)
		ON CONFLICT (user_id, event_at) WHERE kind='digest' DO UPDATE SET status='pending', fire_at=EXCLUDED.fire_at, held=false
		WHERE notifications.status='cancelled'`, userID, moment); err != nil {
		return false, err
	}
	return true, tx.Commit()
}

func (r *Notifications) ClaimDue(ctx context.Context, limit int) ([]repository.DueNotification, error) {
	rows, err := r.db.QueryContext(ctx, `WITH claimed AS (
		UPDATE notifications SET status='queued', queued_at=now(), attempts=attempts+1
		WHERE id IN (SELECT id FROM notifications WHERE status='pending' AND fire_at<=now()
		             ORDER BY fire_at LIMIT $1 FOR UPDATE SKIP LOCKED)
		RETURNING id,user_id,item_id,kind,event_at,fire_at,held,attempts)
		SELECT c.id,c.user_id,c.item_id,c.kind,c.event_at,c.fire_at,c.held,c.attempts,COALESCE(u.timezone,'Europe/Moscow'),`+settingsColumns+`
		FROM claimed c LEFT JOIN users u ON u.id=c.user_id LEFT JOIN notification_settings s ON s.user_id=c.user_id
		ORDER BY c.fire_at`, limit)
	if err != nil {
		return nil, err
	}
	var due []repository.DueNotification
	for rows.Next() {
		var n repository.DueNotification
		var item sql.NullString
		if err := rows.Scan(append([]any{&n.ID, &n.UserID, &item, &n.Kind, &n.EventAt, &n.FireAt, &n.Held, &n.Attempts, &n.Timezone}, scanSettings(&n.Settings)...)...); err != nil {
			rows.Close()
			return nil, err
		}
		if item.Valid {
			n.ItemID = &item.String
		}
		due = append(due, n)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range due {
		channels, err := r.UserChannels(ctx, due[i].UserID)
		if err != nil {
			return nil, err
		}
		for _, c := range channels {
			if c.Enabled {
				due[i].Channels = append(due[i].Channels, c)
			}
		}
	}
	return due, nil
}

func (r *Notifications) setStatus(ctx context.Context, id, query string, args ...any) error {
	_, err := r.db.ExecContext(ctx, query, append([]any{id}, args...)...)
	return err
}

func (r *Notifications) Release(ctx context.Context, id string) error {
	return r.setStatus(ctx, id, `UPDATE notifications SET status='pending', queued_at=NULL WHERE id=$1 AND status='queued'`)
}
func (r *Notifications) Cancel(ctx context.Context, id string) error {
	return r.setStatus(ctx, id, `UPDATE notifications SET status='cancelled' WHERE id=$1 AND status IN ('pending','queued')`)
}
func (r *Notifications) Skip(ctx context.Context, id string) error {
	return r.setStatus(ctx, id, `UPDATE notifications SET status='skipped' WHERE id=$1 AND status='queued'`)
}
func (r *Notifications) Hold(ctx context.Context, id string, until time.Time) error {
	return r.setStatus(ctx, id, `UPDATE notifications SET status='pending', queued_at=NULL, held=true, fire_at=$2 WHERE id=$1 AND status='queued'`, until)
}

// Ack от бота. Повторное подтверждение безопасно; failed не перекрывает sent.
func (r *Notifications) Ack(ctx context.Context, id string, sent bool, reason string) error {
	var result sql.Result
	var err error
	if sent {
		result, err = r.db.ExecContext(ctx, `UPDATE notifications SET status='sent', sent_at=COALESCE(sent_at,now()), error=NULL WHERE id=$1`, id)
	} else {
		result, err = r.db.ExecContext(ctx, `UPDATE notifications SET status='failed', error=left($2,500) WHERE id=$1 AND status<>'sent'`, id, reason)
		if err == nil {
			return nil
		}
	}
	return affected(result, err)
}
