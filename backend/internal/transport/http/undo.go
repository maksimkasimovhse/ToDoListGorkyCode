package http

import "net/http"

func (h *Handler) resetSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SessionID string `json:"session_id"`
	}
	if err := decode(w, r, &body); err != nil {
		failure(w, err)
		return
	}
	if err := h.messages.Reset(r.Context(), currentUserID(r), body.SessionID); err != nil {
		failure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
func (h *Handler) undo(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token string `json:"undo_token"`
	}
	if err := decode(w, r, &body); err != nil {
		failure(w, err)
		return
	}
	reply, err := h.items.Undo(r.Context(), currentUserID(r), body.Token)
	if err != nil {
		failure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, reply)
}
