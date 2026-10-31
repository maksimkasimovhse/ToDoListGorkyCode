package domain

import (
	"fmt"
	"time"
)

// ClockTime — время суток «ЧЧ:ММ» в поясе пользователя.
type ClockTime string

// Minutes возвращает минуты от полуночи или ошибку, если формат не «ЧЧ:ММ».
func (c ClockTime) Minutes() (int, error) {
	var h, m int
	if len(c) != 5 || c[2] != ':' {
		return 0, fmt.Errorf("время должно быть в формате ЧЧ:ММ")
	}
	if _, err := fmt.Sscanf(string(c), "%02d:%02d", &h, &m); err != nil || h < 0 || h > 23 || m < 0 || m > 59 {
		return 0, fmt.Errorf("время должно быть в формате ЧЧ:ММ")
	}
	return h*60 + m, nil
}

// NotificationSettings — утренняя сводка и тихие часы. Уведомления, попавшие в тихие часы,
// не теряются: они приходят в момент окончания тихих часов.
type NotificationSettings struct {
	DigestEnabled bool      `json:"digest_enabled"`
	DigestTime    ClockTime `json:"digest_time"`
	QuietEnabled  bool      `json:"quiet_enabled"`
	QuietStart    ClockTime `json:"quiet_start"`
	QuietEnd      ClockTime `json:"quiet_end"`
}

func DefaultNotificationSettings() NotificationSettings {
	return NotificationSettings{DigestEnabled: true, DigestTime: "07:30", QuietStart: "23:00", QuietEnd: "08:00"}
}

func (s NotificationSettings) Validate() error {
	for _, value := range []ClockTime{s.DigestTime, s.QuietStart, s.QuietEnd} {
		if _, err := value.Minutes(); err != nil {
			return err
		}
	}
	if s.QuietStart == s.QuietEnd {
		return fmt.Errorf("начало и конец тихих часов должны различаться")
	}
	return nil
}

func at(day time.Time, clock ClockTime) time.Time {
	minutes, _ := clock.Minutes()
	return time.Date(day.Year(), day.Month(), day.Day(), minutes/60, minutes%60, 0, 0, day.Location())
}

// QuietUntil возвращает момент окончания тихих часов, если now попадает в них, иначе нулевое время.
// Интервал может переходить через полночь (23:00–08:00).
func (s NotificationSettings) QuietUntil(now time.Time, loc *time.Location) time.Time {
	if !s.QuietEnabled {
		return time.Time{}
	}
	local := now.In(loc)
	start, _ := s.QuietStart.Minutes()
	end, _ := s.QuietEnd.Minutes()
	current := local.Hour()*60 + local.Minute()
	inside := (start < end && current >= start && current < end) || (start > end && (current >= start || current < end))
	if !inside {
		return time.Time{}
	}
	until := at(local, s.QuietEnd)
	if !until.After(local) {
		until = at(local.AddDate(0, 0, 1), s.QuietEnd)
	}
	return until
}

// DigestWindow — сколько после времени сводки её ещё можно отправить (например, после перезапуска).
const DigestWindow = 4 * time.Hour

// DigestDue сообщает, нужна ли сводка за локальный день now: время сводки наступило не позже
// DigestWindow назад и сводка за этот день ещё не планировалась. Возвращает момент сводки и день.
func (s NotificationSettings) DigestDue(now time.Time, loc *time.Location, plannedOn *time.Time) (time.Time, time.Time, bool) {
	if !s.DigestEnabled {
		return time.Time{}, time.Time{}, false
	}
	local := now.In(loc)
	day := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)
	if plannedOn != nil && !plannedOn.Before(time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, time.UTC)) {
		return time.Time{}, time.Time{}, false
	}
	moment := at(local, s.DigestTime)
	if local.Before(moment) || local.Sub(moment) > DigestWindow {
		return time.Time{}, time.Time{}, false
	}
	return moment, day, true
}

type NotificationKind string

const (
	NotifySoon   NotificationKind = "soon"
	NotifyNow    NotificationKind = "now"
	NotifyDigest NotificationKind = "digest"
)

// Notification — строка расписания уведомлений.
type Notification struct {
	ID       string
	UserID   string
	ItemID   *string
	Kind     NotificationKind
	EventAt  time.Time
	FireAt   time.Time
	Held     bool
	Attempts int
}

// Channel — привязанный мессенджер пользователя.
type Channel struct {
	Channel    string    `json:"channel"`
	ExternalID string    `json:"external_id"`
	UserID     string    `json:"user_id"`
	Enabled    bool      `json:"enabled"`
	LinkedAt   time.Time `json:"linked_at"`
	SessionKey *string   `json:"-"`
}

// Delivery — то, что уходит боту канала через Redis Stream.
type Delivery struct {
	Version    int              `json:"version"`
	ID         string           `json:"id"`
	Kind       NotificationKind `json:"kind"`
	Channel    string           `json:"channel"`
	ExternalID string           `json:"external_id"`
	UserID     string           `json:"user_id"`
	Timezone   string           `json:"timezone"`
	EventAt    time.Time        `json:"event_at"`
	Held       bool             `json:"held"`
	Item       *Item            `json:"item,omitempty"`
	Items      []Item           `json:"items,omitempty"`
	Day        string           `json:"day,omitempty"`
}
