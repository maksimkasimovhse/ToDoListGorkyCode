package domain

import (
	"encoding/json"
	"time"
)

const DemoUserID = "00000000-0000-0000-0000-000000000001"

type MessageRequest struct {
	ClientMessageID string  `json:"client_message_id"`
	SessionID       string  `json:"session_id"`
	Text            *string `json:"text"`
	Input           string  `json:"input"`
	Timezone        string  `json:"timezone,omitempty"`
	Choice          *Choice `json:"choice"`
	Context         struct {
		SelectedItemID *string `json:"selected_item_id"`
	} `json:"context"`
}

type Choice struct {
	OptionID string `json:"option_id"`
}
type Option struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}
type Reply struct {
	Type        string   `json:"type"`
	Reply       string   `json:"reply"`
	Speak       *string  `json:"speak"`
	Items       []Item   `json:"items"`
	Options     []Option `json:"options"`
	Data        any      `json:"data"`
	UndoToken   *string  `json:"undo_token"`
	Suggestions []string `json:"suggestions"`
}

func NewReply(kind, text string, data any) Reply {
	return Reply{Type: kind, Reply: text, Items: []Item{}, Options: []Option{}, Data: data, Suggestions: []string{}}
}

func ErrorReply(code, text string) Reply {
	return NewReply("error", text, map[string]any{"code": code, "retryable": true})
}

type Message struct {
	ID           string         `json:"message_id"`
	Status       string         `json:"status"`
	Response     *Reply         `json:"response"`
	CreatedAt    time.Time      `json:"created_at"`
	DeadlineAt   time.Time      `json:"deadline_at"`
	InputToken   *string        `json:"input_token"`
	UserID       string         `json:"-"`
	Request      MessageRequest `json:"-"`
	ModelRequest ModelRequest   `json:"-"`
	AttemptID    string         `json:"-"`
	Attempts     int            `json:"-"`
}

func (m Message) Active() bool {
	return m.Status == "processing" || m.Status == "awaiting_input" || m.Status == "awaiting_confirmation"
}

// InputToken связывает ответ с конкретным окном уточнения и защищает от повторной отправки.
type MessageAnswer struct {
	OptionID    *string `json:"option_id,omitempty"`
	Text        *string `json:"text,omitempty"`
	InputToken  string  `json:"input_token"`
	Date        *string `json:"date,omitempty"`
	Time        *string `json:"time,omitempty"`
	Title       *string `json:"title,omitempty"`
	DurationMin *int    `json:"duration_min,omitempty"`
	Confirmed   *bool   `json:"confirmed,omitempty"`
}

type Turn struct {
	Role string `json:"role"`
	Text string `json:"text"`
}

type PendingMutation struct {
	Timezone     string                     `json:"timezone"`
	Stage        string                     `json:"stage"`
	Candidates   []Item                     `json:"candidates"`
	Selected     *Item                      `json:"selected"`
	Patch        map[string]json.RawMessage `json:"patch,omitempty"`
	ConflictKeys []string                   `json:"conflict_keys,omitempty"`
}

type Draft struct {
	Mutation            *PendingMutation `json:"mutation,omitempty"`
	ConflictActionIndex int              `json:"conflict_action_index,omitempty"`
	RescheduleIndex     *int             `json:"reschedule_index,omitempty"`
	ConflictKeys        []string         `json:"conflict_keys,omitempty"`
	Action
	SourceText     string    `json:"source_text"`
	PendingActions []Action  `json:"pending_actions,omitempty"`
	Missing        []string  `json:"missing"`
	Attempt        int       `json:"attempt"`
	ExpiresAt      time.Time `json:"expires_at"`
}

type DialogueState struct {
	History    []Turn  `json:"history"`
	Draft      *Draft  `json:"draft"`
	Expects    *string `json:"expects"`
	Focus      *Item   `json:"focus"`
	Candidates []Item  `json:"candidates"`
}

type ModelRequest struct {
	Text       string         `json:"text"`
	Now        time.Time      `json:"now"`
	Timezone   string         `json:"timezone"`
	Anchors    map[string]any `json:"anchors"`
	History    []Turn         `json:"history"`
	Expects    *string        `json:"expects"`
	Draft      *Draft         `json:"draft"`
	Focus      *Item          `json:"focus"`
	Candidates []Item         `json:"candidates"`
	Choice     *Choice        `json:"choice,omitempty"`
}

type Job struct {
	Version    int          `json:"version"`
	MessageID  string       `json:"message_id"`
	AttemptID  string       `json:"attempt_id"`
	DeadlineAt time.Time    `json:"deadline_at"`
	Request    ModelRequest `json:"request"`
}

type Action struct {
	Intent string          `json:"intent"`
	Params json.RawMessage `json:"params"`
}

type ModelResult struct {
	Status     string   `json:"status"`
	Actions    []Action `json:"actions"`
	Missing    []string `json:"missing"`
	Question   string   `json:"question"`
	Options    []Option `json:"options"`
	OneAtATime bool     `json:"one_at_a_time,omitempty"`
}

type ResultEnvelope struct {
	Version   int             `json:"version"`
	MessageID string          `json:"message_id"`
	AttemptID string          `json:"attempt_id"`
	Result    json.RawMessage `json:"result"`
	Error     *string         `json:"error,omitempty"`
}
