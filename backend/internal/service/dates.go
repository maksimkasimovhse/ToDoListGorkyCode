package service

import (
	"encoding/json"
	"gorky/backend/internal/domain"
	"strings"
	"time"
)

func anchors(now time.Time) map[string]any {
	day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	monday := day.AddDate(0, 0, -(int(day.Weekday())+6)%7)
	date := func(t time.Time) string { return t.Format(time.DateOnly) }
	next := map[string]string{}
	following := map[string]string{}
	for i, name := range []string{"mon", "tue", "wed", "thu", "fri", "sat", "sun"} {
		t := monday.AddDate(0, 0, i)
		following[name] = date(t.AddDate(0, 0, 7))
		if t.Before(day) {
			t = t.AddDate(0, 0, 7)
		}
		next[name] = date(t)
	}
	return map[string]any{"today": date(day), "weekday": []string{"sun", "mon", "tue", "wed", "thu", "fri", "sat"}[day.Weekday()], "tomorrow": date(day.AddDate(0, 0, 1)), "day_after_tomorrow": date(day.AddDate(0, 0, 2)), "this_week": []string{date(monday), date(monday.AddDate(0, 0, 6))}, "next_week": []string{date(monday.AddDate(0, 0, 7)), date(monday.AddDate(0, 0, 13))}, "last_week": []string{date(monday.AddDate(0, 0, -7)), date(monday.AddDate(0, 0, -1))}, "this_weekend": []string{date(monday.AddDate(0, 0, 5)), date(monday.AddDate(0, 0, 6))}, "month_end": date(time.Date(day.Year(), day.Month()+1, 0, 0, 0, 0, 0, day.Location())), "next_weekday": next, "following_week_weekday": following}
}

func normalize(intent string, p params, m domain.Message) (domain.Item, []string, error) {
	item := domain.Item{Title: p.Title, SourceText: m.ModelRequest.Text, Participants: p.Participants, Location: p.Location}
	if len(p.Recurrence) > 0 && string(p.Recurrence) != "null" {
		return item, nil, invalid("Повторы пока не поддерживаются.")
	}
	if len(p.ForMeeting) > 0 && string(p.ForMeeting) != "null" {
		return item, nil, invalid("Связанные напоминания пока не поддерживаются.")
	}
	missing := []string{}
	if p.Date == "" && p.Time != "" {
		loc, err := time.LoadLocation(m.ModelRequest.Timezone)
		if err != nil {
			return item, nil, err
		}
		p.Date = m.ModelRequest.Now.In(loc).Format(time.DateOnly)
		at, err := time.ParseInLocation("2006-01-02 15:04", p.Date+" "+p.Time, loc)
		if err != nil {
			return item, nil, invalid("Неверное время от модели.")
		}
		if at.Before(m.ModelRequest.Now) {
			p.Date = m.ModelRequest.Now.In(loc).AddDate(0, 0, 1).Format(time.DateOnly)
		}
	}
	if strings.TrimSpace(p.Title) == "" {
		missing = append(missing, "title")
	}
	if intent != "create_task" {
		if p.Date == "" {
			missing = append(missing, "date")
		}
		if p.Time == "" && !(intent == "create_meeting" && p.AllDay) {
			missing = append(missing, "time")
		}
	}
	if p.Time != "" && p.Date == "" && intent == "create_task" {
		missing = append(missing, "date")
	}
	if len(missing) > 0 {
		return item, missing, nil
	}
	loc, err := time.LoadLocation(m.ModelRequest.Timezone)
	if err != nil {
		return item, nil, err
	}
	var date time.Time
	if p.Date != "" {
		date, err = time.ParseInLocation(time.DateOnly, p.Date, loc)
		if err != nil {
			return item, nil, invalid("Неверная дата от модели.")
		}
	}
	var at time.Time
	if p.Time != "" {
		at, err = time.ParseInLocation("2006-01-02 15:04", p.Date+" "+p.Time, loc)
		if err != nil {
			return item, nil, invalid("Неверное время от модели.")
		}
	}
	switch intent {
	case "create_task":
		item.Type = domain.ItemTask
		if !at.IsZero() {
			item.DueAt = &at
		} else if p.Date != "" {
			d := domain.Date(p.Date)
			item.DueDate = &d
		}
		if len(p.Period) > 0 && string(p.Period) != "null" {
			if p.Date != "" || p.Time != "" {
				return item, nil, invalid("Нельзя одновременно указать дату и период.")
			}
			start, end, err := period(p.Period, m.ModelRequest.Now)
			if err != nil {
				return item, nil, err
			}
			item.PeriodStart = &start
			item.PeriodEnd = &end
		}
	case "create_reminder":
		item.Type = domain.ItemReminder
		item.RemindAt = &at
	case "create_meeting":
		item.Type = domain.ItemMeeting
		item.AllDay = p.AllDay
		if p.AllDay {
			at = date
		}
		end := at.Add(time.Hour)
		if p.AllDay {
			end = at.AddDate(0, 0, 1)
		} else if p.EndTime != "" {
			end, err = time.ParseInLocation("2006-01-02 15:04", p.Date+" "+p.EndTime, loc)
			if err != nil {
				return item, nil, invalid("Неверное время окончания.")
			}
		} else if p.DurationMin != nil {
			if *p.DurationMin <= 0 || *p.DurationMin > 10080 {
				return item, nil, invalid("Неверная длительность.")
			}
			end = at.Add(time.Duration(*p.DurationMin) * time.Minute)
		}
		item.StartAt = &at
		item.EndAt = &end
		if p.RemindBeforeMin != nil {
			if *p.RemindBeforeMin < 0 || *p.RemindBeforeMin > 525600 {
				return item, nil, invalid("Неверный интервал напоминания.")
			}
			remind := at.Add(-time.Duration(*p.RemindBeforeMin) * time.Minute)
			item.RemindAt = &remind
		}
	}
	return item, nil, ValidateItem(item)
}

func period(raw json.RawMessage, now time.Time) (time.Time, time.Time, error) {
	var name string
	day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	monday := day.AddDate(0, 0, -(int(day.Weekday())+6)%7)
	if json.Unmarshal(raw, &name) == nil {
		switch name {
		case "this_week":
			return now, monday.AddDate(0, 0, 7).Add(-time.Second), nil
		case "next_week":
			return monday.AddDate(0, 0, 7), monday.AddDate(0, 0, 14).Add(-time.Second), nil
		case "month":
			return now, time.Date(now.Year(), now.Month()+1, 1, 0, 0, 0, 0, now.Location()).Add(-time.Second), nil
		}
	}
	var custom struct {
		From time.Time `json:"from"`
		To   time.Time `json:"to"`
	}
	if json.Unmarshal(raw, &custom) == nil && !custom.From.IsZero() && custom.To.After(custom.From) {
		return custom.From, custom.To, nil
	}
	return time.Time{}, time.Time{}, invalid("Неверный период от модели.")
}
