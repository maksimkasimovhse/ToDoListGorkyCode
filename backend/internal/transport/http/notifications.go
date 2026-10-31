package http

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"gorky/backend/internal/repository"
	"gorky/backend/internal/service"
)

// Channels подключает уведомления в мессенджеры. BotToken — общий секрет ботов для /internal/*;
// пустой отключает внутренние маршруты.
type Channels struct {
	Service  *service.Channels
	BotToken string
	// BotLinks — ссылки на ботов по каналам (https://max.ru/<имя>), для кнопки «Подключить» на сайте
	BotLinks map[string]string
}

type channelHandler struct {
	Channels
}

func (h *channelHandler) requireBot(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fields := strings.Fields(r.Header.Get("Authorization"))
		if h.BotToken == "" || len(fields) != 2 || !strings.EqualFold(fields[0], "Bot") ||
			subtle.ConstantTimeCompare([]byte(fields[1]), []byte(h.BotToken)) != 1 {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": map[string]string{"code": "unauthorized", "message": "Нужен токен бота."}})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func channelFailure(w http.ResponseWriter, err error) {
	if errors.Is(err, repository.ErrLinkCode) {
		writeJSON(w, http.StatusGone, map[string]any{"error": map[string]string{"code": "link_code", "message": "Код привязки недействителен или устарел. Получите новый на сайте."}})
		return
	}
	failure(w, err)
}

// --- Маршруты пользователя (Bearer) ---

func (h *channelHandler) settings(w http.ResponseWriter, r *http.Request) {
	settings, err := h.Service.Settings(r.Context(), currentUserID(r))
	if err != nil {
		failure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

func (h *channelHandler) updateSettings(w http.ResponseWriter, r *http.Request) {
	var patch map[string]json.RawMessage
	if err := decode(w, r, &patch); err != nil {
		failure(w, err)
		return
	}
	settings, err := h.Service.UpdateSettings(r.Context(), currentUserID(r), patch)
	if err != nil {
		failure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

func (h *channelHandler) listChannels(w http.ResponseWriter, r *http.Request) {
	channels, err := h.Service.UserChannels(r.Context(), currentUserID(r))
	if err != nil {
		failure(w, err)
		return
	}
	links := map[string]string{}
	for name, link := range h.BotLinks {
		if link != "" {
			links[name] = link
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"channels": channels, "bots": links})
}

func (h *channelHandler) linkCode(w http.ResponseWriter, r *http.Request) {
	channel := chi.URLParam(r, "channel")
	code, err := h.Service.CreateLinkCode(r.Context(), currentUserID(r), channel)
	if err != nil {
		failure(w, err)
		return
	}
	body := map[string]any{"code": code.Code, "expires_at": code.ExpiresAt}
	if link := h.BotLinks[channel]; link != "" {
		body["url"] = strings.TrimRight(link, "/") + "?start=" + code.Code
	}
	writeJSON(w, http.StatusCreated, body)
}

// --- Маршруты бота (Authorization: Bot <токен>) ---

func (h *channelHandler) link(w http.ResponseWriter, r *http.Request) {
	var req service.LinkRequest
	if err := decode(w, r, &req); err != nil {
		failure(w, err)
		return
	}
	result, err := h.Service.Link(r.Context(), chi.URLParam(r, "channel"), req)
	if err != nil {
		channelFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *channelHandler) state(w http.ResponseWriter, r *http.Request) {
	state, err := h.Service.State(r.Context(), chi.URLParam(r, "channel"), chi.URLParam(r, "external"))
	if err != nil {
		failure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, state)
}

func (h *channelHandler) setEnabled(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	if err := decode(w, r, &body); err != nil {
		failure(w, err)
		return
	}
	if body.Enabled == nil {
		failure(w, serviceError("нужен enabled"))
		return
	}
	channel, external := chi.URLParam(r, "channel"), chi.URLParam(r, "external")
	if err := h.Service.SetEnabled(r.Context(), channel, external, *body.Enabled); err != nil {
		failure(w, err)
		return
	}
	h.state(w, r)
}

func (h *channelHandler) unlink(w http.ResponseWriter, r *http.Request) {
	err := h.Service.Unlink(r.Context(), chi.URLParam(r, "channel"), chi.URLParam(r, "external"))
	if err != nil && !errors.Is(err, repository.ErrNotFound) {
		failure(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// unlinkMine — «Отвязать» на сайте: убирает привязку канала у текущего пользователя и отзывает сессию бота.
// Повторный вызов без привязки тоже отвечает 204.
func (h *channelHandler) unlinkMine(w http.ResponseWriter, r *http.Request) {
	channel := chi.URLParam(r, "channel")
	linked, err := h.Service.UserChannels(r.Context(), currentUserID(r))
	if err != nil {
		failure(w, err)
		return
	}
	for _, link := range linked {
		if link.Channel != channel {
			continue
		}
		if err := h.Service.Unlink(r.Context(), channel, link.ExternalID); err != nil && !errors.Is(err, repository.ErrNotFound) {
			failure(w, err)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *channelHandler) ack(w http.ResponseWriter, r *http.Request) {
	var req service.AckRequest
	if err := decode(w, r, &req); err != nil {
		failure(w, err)
		return
	}
	if err := h.Service.Ack(r.Context(), chi.URLParam(r, "id"), req); err != nil {
		failure(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *channelHandler) mount(router chi.Router, requireAuth func(http.Handler) http.Handler) {
	router.Group(func(user chi.Router) {
		user.Use(requireAuth)
		user.Get("/api/notification-settings", h.settings)
		user.Patch("/api/notification-settings", h.updateSettings)
		user.Get("/api/channels", h.listChannels)
		user.Post("/api/channels/{channel}/link-code", h.linkCode)
		user.Delete("/api/channels/{channel}", h.unlinkMine)
	})
	router.Group(func(bot chi.Router) {
		bot.Use(h.requireBot)
		bot.Post("/internal/channels/{channel}/link", h.link)
		bot.Get("/internal/channels/{channel}/{external}", h.state)
		bot.Patch("/internal/channels/{channel}/{external}", h.setEnabled)
		bot.Delete("/internal/channels/{channel}/{external}", h.unlink)
		bot.Post("/internal/notifications/{id}/ack", h.ack)
	})
}
