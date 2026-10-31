package http

import (
	"context"
	"net"
	"net/http"
	"strings"
	"time"

	"gorky/backend/internal/domain"
	"gorky/backend/internal/repository"
	"gorky/backend/internal/service"
)

type userContextKey struct{}

func currentUserID(r *http.Request) string {
	session, _ := domain.AuthSessionFromContext(r.Context())
	return session.UserID
}

func (h *Handler) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if h.auth == nil {
			failure(w, service.ErrAuthUnavailable)
			return
		}
		fields := strings.Fields(r.Header.Get("Authorization"))
		if len(r.Header.Values("Authorization")) != 1 || len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
			failure(w, repository.ErrUnauthenticated)
			return
		}
		session, user, err := h.auth.Authenticate(r.Context(), fields[1])
		if err != nil {
			failure(w, err)
			return
		}
		ctx := domain.WithAuthSession(r.Context(), session)
		ctx = context.WithValue(ctx, userContextKey{}, user)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (h *Handler) login(w http.ResponseWriter, r *http.Request) {
	if h.auth == nil {
		failure(w, service.ErrAuthUnavailable)
		return
	}
	var body struct {
		Login    string `json:"login"`
		Password string `json:"password"`
	}
	if err := decode(w, r, &body); err != nil {
		failure(w, err)
		return
	}
	address, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		address = r.RemoteAddr
	}
	result, err := h.auth.Login(r.Context(), body.Login, body.Password, address)
	if err != nil {
		failure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
func (h *Handler) logout(w http.ResponseWriter, r *http.Request) {
	session, _ := domain.AuthSessionFromContext(r.Context())
	if err := h.auth.Logout(r.Context(), session.Key); err != nil {
		failure(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
func (h *Handler) me(w http.ResponseWriter, r *http.Request) {
	user := r.Context().Value(userContextKey{}).(domain.User)
	writeJSON(w, http.StatusOK, map[string]any{"id": user.ID, "login": user.Login, "timezone": user.Timezone, "settings": map[string]bool{"speak": false}, "now": time.Now()})
}
