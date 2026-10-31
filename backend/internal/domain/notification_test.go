package domain

import (
	"testing"
	"time"
)

func moscow(t *testing.T) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation("Europe/Moscow")
	if err != nil {
		t.Fatal(err)
	}
	return loc
}

func TestQuietUntilAcrossMidnight(t *testing.T) {
	loc := moscow(t)
	s := NotificationSettings{QuietEnabled: true, QuietStart: "23:00", QuietEnd: "08:00"}
	cases := []struct {
		now   string
		until string
	}{
		{"2026-11-01T22:59", ""},
		{"2026-11-01T23:00", "2026-11-02T08:00"},
		{"2026-11-02T03:15", "2026-11-02T08:00"},
		{"2026-11-02T07:59", "2026-11-02T08:00"},
		{"2026-11-02T08:00", ""},
		{"2026-11-02T12:00", ""},
	}
	for _, c := range cases {
		now, _ := time.ParseInLocation("2006-01-02T15:04", c.now, loc)
		got := s.QuietUntil(now, loc)
		want := ""
		if !got.IsZero() {
			want = got.In(loc).Format("2006-01-02T15:04")
		}
		if want != c.until {
			t.Errorf("%s: got %q, want %q", c.now, want, c.until)
		}
	}
	s.QuietEnabled = false
	now, _ := time.ParseInLocation("2006-01-02T15:04", "2026-11-02T03:00", loc)
	if !s.QuietUntil(now, loc).IsZero() {
		t.Error("выключенные тихие часы не должны откладывать уведомления")
	}
}

func TestQuietUntilSameDay(t *testing.T) {
	loc := moscow(t)
	s := NotificationSettings{QuietEnabled: true, QuietStart: "13:00", QuietEnd: "15:00"}
	now, _ := time.ParseInLocation("2006-01-02T15:04", "2026-11-02T14:00", loc)
	if got := s.QuietUntil(now, loc).In(loc).Format("15:04"); got != "15:00" {
		t.Fatalf("got %s", got)
	}
	now, _ = time.ParseInLocation("2006-01-02T15:04", "2026-11-02T23:30", loc)
	if !s.QuietUntil(now, loc).IsZero() {
		t.Fatal("вне интервала")
	}
}

func TestDigestDue(t *testing.T) {
	loc := moscow(t)
	s := DefaultNotificationSettings()
	parse := func(v string) time.Time {
		v2, _ := time.ParseInLocation("2006-01-02T15:04", v, loc)
		return v2
	}
	if _, _, ok := s.DigestDue(parse("2026-11-02T07:29"), loc, nil); ok {
		t.Fatal("рано")
	}
	moment, day, ok := s.DigestDue(parse("2026-11-02T07:30"), loc, nil)
	if !ok || moment.In(loc).Format("15:04") != "07:30" || day.Format("2006-01-02") != "2026-11-02" {
		t.Fatalf("ok=%v moment=%v day=%v", ok, moment, day)
	}
	if _, _, ok := s.DigestDue(parse("2026-11-02T11:29"), loc, nil); !ok {
		t.Fatal("в пределах окна после перезапуска")
	}
	if _, _, ok := s.DigestDue(parse("2026-11-02T11:31"), loc, nil); ok {
		t.Fatal("окно прошло")
	}
	planned := time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)
	if _, _, ok := s.DigestDue(parse("2026-11-02T08:00"), loc, &planned); ok {
		t.Fatal("сводка за день уже запланирована")
	}
	yesterday := planned.AddDate(0, 0, -1)
	if _, _, ok := s.DigestDue(parse("2026-11-02T08:00"), loc, &yesterday); !ok {
		t.Fatal("вчерашняя сводка не мешает сегодняшней")
	}
	s.DigestEnabled = false
	if _, _, ok := s.DigestDue(parse("2026-11-02T08:00"), loc, nil); ok {
		t.Fatal("сводка выключена")
	}
}

func TestSettingsValidate(t *testing.T) {
	good := DefaultNotificationSettings()
	if err := good.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []NotificationSettings{
		{DigestTime: "7:30", QuietStart: "23:00", QuietEnd: "08:00"},
		{DigestTime: "24:00", QuietStart: "23:00", QuietEnd: "08:00"},
		{DigestTime: "07:30", QuietStart: "23:00", QuietEnd: "23:00"},
		{DigestTime: "07:60", QuietStart: "23:00", QuietEnd: "08:00"},
	} {
		if bad.Validate() == nil {
			t.Errorf("ожидалась ошибка для %+v", bad)
		}
	}
}
