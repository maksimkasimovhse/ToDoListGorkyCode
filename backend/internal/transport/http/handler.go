package http

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"gorky/backend/internal/domain"
	"gorky/backend/internal/repository"
	"gorky/backend/internal/service"
)

type Handler struct {
	auth     *service.Auth
	messages *service.Messages
	items    *service.Items
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func decode(w http.ResponseWriter, r *http.Request, value any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return serviceError("неверный JSON запроса")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return serviceError("ожидался один JSON-объект")
	}
	return nil
}

func serviceError(message string) error { return errors.Join(service.ErrInvalid, errors.New(message)) }

func failure(w http.ResponseWriter, err error) {
	var meeting *service.MeetingConflictError
	if errors.As(err, &meeting) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": map[string]any{
			"code": "meeting_conflict", "message": meeting.Error(), "conflicts": meeting.Conflicts,
		}})
		return
	}
	status, code, message := http.StatusInternalServerError, "internal", "Не получилось выполнить запрос."
	switch {
	case errors.Is(err, service.ErrCredentials):
		status, code, message = 401, "invalid_credentials", "Неверный логин или пароль."
	case errors.Is(err, repository.ErrUnauthenticated):
		w.Header().Set("WWW-Authenticate", "Bearer")
		status, code, message = 401, "unauthorized", "Войдите в аккаунт: сессия отсутствует или истекла."
	case errors.Is(err, service.ErrAuthUnavailable):
		status, code, message = 503, "auth_unavailable", "Не удалось проверить сессию. Попробуйте позже."
	case errors.Is(err, service.ErrLoginLimit):
		w.Header().Set("Retry-After", "60")
		status, code, message = 429, "too_many_attempts", "Слишком много попыток входа. Повторите через минуту."
	case errors.Is(err, service.ErrInvalid):
		status, code, message = 400, "validation", err.Error()
	case errors.Is(err, repository.ErrUndoExpired):
		status, code, message = 410, "undo_expired", "Срок отмены действия истёк."
	case errors.Is(err, repository.ErrUndoConflict):
		status, code, message = 409, "undo_conflict", "Запись уже изменена после действия. Откат не выполнен."
	case errors.Is(err, repository.ErrConflict):
		status, code, message = 409, "item_conflict", "Запись изменилась. Обновите её и повторите запрос."
	case errors.Is(err, repository.ErrNotFound):
		status, code, message = 404, "not_found", "Запись не найдена."
	case errors.Is(err, repository.ErrBusy):
		status, code, message = 409, "conversation_busy", "Дождитесь завершения предыдущего сообщения."
	case errors.Is(err, repository.ErrIdempotencyConflict):
		status, code, message = 409, "idempotency_conflict", "Этот идентификатор уже использован для другого запроса."
	case errors.Is(err, repository.ErrMessageState):
		status, code, message = 409, "message_state", "Сценарий не ожидает такой операции. Получите актуальный статус."
	case errors.Is(err, repository.ErrInputToken):
		status, code, message = 409, "stale_input", "Окно уточнения устарело. Получите актуальный статус."
	}
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

// Владелец берётся только из проверенной сессии авторизации.
func (h *Handler) submit(w http.ResponseWriter, r *http.Request) {
	var request domain.MessageRequest
	if err := decode(w, r, &request); err != nil {
		failure(w, err)
		return
	}
	message, err := h.messages.Submit(r.Context(), currentUserID(r), request)
	if err != nil {
		failure(w, err)
		return
	}
	w.Header().Set("Location", "/api/messages/"+message.ID)
	status := http.StatusAccepted
	if message.Status != "processing" {
		status = http.StatusOK
	}
	writeJSON(w, status, message)
}

func (h *Handler) poll(w http.ResponseWriter, r *http.Request) {
	message, err := h.messages.Get(r.Context(), currentUserID(r), chi.URLParam(r, "id"))
	if err != nil {
		failure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, message)
}

func (h *Handler) answer(w http.ResponseWriter, r *http.Request) {
	var answer domain.MessageAnswer
	if err := decode(w, r, &answer); err != nil {
		failure(w, err)
		return
	}
	message, err := h.messages.Answer(r.Context(), currentUserID(r), chi.URLParam(r, "id"), answer)
	if err != nil {
		failure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, message)
}

func (h *Handler) cancel(w http.ResponseWriter, r *http.Request) {
	message, err := h.messages.Cancel(r.Context(), currentUserID(r), chi.URLParam(r, "id"))
	if err != nil {
		failure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, message)
}

func (h *Handler) history(w http.ResponseWriter, r *http.Request) {
	messages, err := h.messages.History(r.Context(), currentUserID(r), r.URL.Query().Get("session_id"))
	if err != nil {
		failure(w, err)
		return
	}
	turns := []map[string]any{}
	pending := []domain.Message{}
	for _, m := range messages {
		turns = append(turns, map[string]any{"role": "user", "text": m.ModelRequest.Text, "response": nil, "at": m.CreatedAt, "message_id": m.ID})
		if m.Response != nil {
			turns = append(turns, map[string]any{"role": "assistant", "text": m.Response.Reply, "response": m.Response, "at": m.CreatedAt, "message_id": m.ID})
		}
		if m.Active() {
			pending = append(pending, m)
		}
	}
	writeJSON(w, 200, map[string]any{"history": turns, "pending_messages": pending})
}

type createItemRequest struct {
	AllowConflicts bool            `json:"allow_conflicts"`
	Type           domain.ItemType `json:"type"`
	Title          string          `json:"title"`
	SourceText     string          `json:"source_text"`
	DueDate        *domain.Date    `json:"due_date"`
	DueAt          *time.Time      `json:"due_at"`
	PeriodStart    *time.Time      `json:"period_start"`
	PeriodEnd      *time.Time      `json:"period_end"`
	StartAt        *time.Time      `json:"start_at"`
	EndAt          *time.Time      `json:"end_at"`
	AllDay         bool            `json:"all_day"`
	Participants   []string        `json:"participants"`
	Location       *string         `json:"location"`
	RemindAt       *time.Time      `json:"remind_at"`
}

func (h *Handler) createItem(w http.ResponseWriter, r *http.Request) {
	var req createItemRequest
	if err := decode(w, r, &req); err != nil {
		failure(w, err)
		return
	}
	item := domain.Item{Type: req.Type, Title: req.Title, SourceText: req.SourceText, DueDate: req.DueDate, DueAt: req.DueAt, PeriodStart: req.PeriodStart, PeriodEnd: req.PeriodEnd, StartAt: req.StartAt, EndAt: req.EndAt, AllDay: req.AllDay, Participants: req.Participants, Location: req.Location, RemindAt: req.RemindAt}
	saved, err := h.items.CreateWithOptions(r.Context(), currentUserID(r), item, service.SaveOptions{AllowConflicts: req.AllowConflicts})
	if err != nil {
		failure(w, err)
		return
	}
	w.Header().Set("Location", "/api/items/"+saved.ID)
	writeJSON(w, http.StatusCreated, saved)
}

func (h *Handler) getItem(w http.ResponseWriter, r *http.Request) {
	item, err := h.items.Get(r.Context(), currentUserID(r), chi.URLParam(r, "id"))
	if err != nil {
		failure(w, err)
		return
	}
	writeJSON(w, 200, item)
}

func (h *Handler) listItems(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	f := repository.ItemFilter{Timezone: query.Get("timezone"), Query: query.Get("q"), Limit: 100, Undated: strings.HasSuffix(r.URL.Path, "/undated")}
	if strings.HasSuffix(r.URL.Path, "/search") && strings.TrimSpace(f.Query) == "" {
		failure(w, serviceError("нужен q"))
		return
	}
	for name, target := range map[string]**time.Time{"from": &f.From, "to": &f.To} {
		if value := query.Get(name); value != "" {
			t, err := time.Parse(time.RFC3339, value)
			if err != nil {
				failure(w, serviceError("неверный "+name))
				return
			}
			*target = &t
		}
	}
	if value := query.Get("types"); value != "" {
		for _, kind := range strings.Split(value, ",") {
			f.Types = append(f.Types, domain.ItemType(kind))
		}
	}
	if value := query.Get("status"); value != "" {
		status := domain.ItemStatus(value)
		f.Status = &status
	}
	if value := query.Get("limit"); value != "" {
		limit, err := strconv.Atoi(value)
		if err != nil || limit < 1 || limit > 100 {
			failure(w, serviceError("limit должен быть от 1 до 100"))
			return
		}
		f.Limit = limit
	}
	search := strings.HasSuffix(r.URL.Path, "/search")
	semantic := false
	var items []domain.Item
	var err error
	if search {
		items, semantic, err = h.items.Search(r.Context(), currentUserID(r), f)
	} else {
		items, err = h.items.List(r.Context(), currentUserID(r), f)
	}
	if err != nil {
		failure(w, err)
		return
	}
	total := len(items)
	if !search {
		total, err = h.items.Count(r.Context(), currentUserID(r), f)
		if err != nil {
			failure(w, err)
			return
		}
	}
	writeJSON(w, 200, map[string]any{"items": items, "total": total, "overdue": []domain.Item{}, "semantic": semantic})
}
func (h *Handler) updateItem(w http.ResponseWriter, r *http.Request) {
	var patch map[string]json.RawMessage
	if err := decode(w, r, &patch); err != nil {
		failure(w, err)
		return
	}
	item, err := h.items.Update(r.Context(), currentUserID(r), chi.URLParam(r, "id"), patch)
	if err != nil {
		failure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (h *Handler) deleteItem(w http.ResponseWriter, r *http.Request) {
	token, err := h.items.DeleteWithUndo(r.Context(), currentUserID(r), chi.URLParam(r, "id"))
	if err != nil {
		failure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"undo_token": token})
}
