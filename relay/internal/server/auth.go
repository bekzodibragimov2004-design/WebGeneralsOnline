package server

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"
)

const (
	sessionCookieName = "wgo_session"
	maxLoginBody      = 4 << 10
	sessionTokenBytes = 32
	sessionSweepEvery = time.Minute
)

// passwordChecker holds a keyed digest of the password rather than the password.
// Both sides are hashed to a fixed length before comparing, so neither the
// comparison time nor an early exit depends on the candidate's length or
// content. The per-process key makes the digest useless if it ever leaks.
type passwordChecker struct {
	key    [sha256.Size]byte
	digest []byte
}

func newPasswordChecker(password string) *passwordChecker {
	c := &passwordChecker{}
	_, _ = rand.Read(c.key[:])
	c.digest = c.mac(password)
	return c
}

func (c *passwordChecker) mac(value string) []byte {
	h := hmac.New(sha256.New, c.key[:])
	_, _ = io.WriteString(h, value)
	return h.Sum(nil)
}

func (c *passwordChecker) check(candidate string) bool {
	return subtle.ConstantTimeCompare(c.mac(candidate), c.digest) == 1
}

// sessionStore keeps sessions in memory with an absolute expiry, so a restart
// signs everyone out. It indexes by a hash of the token, so lookups do not branch
// on token bytes and a memory dump does not expose usable cookies.
type sessionStore struct {
	ttl time.Duration
	max int
	now func() time.Time

	mu        sync.Mutex
	expiry    map[[sha256.Size]byte]time.Time
	nextSweep time.Time
}

func newSessionStore(ttl time.Duration, maxSessions int, now func() time.Time) *sessionStore {
	return &sessionStore{
		ttl:    ttl,
		max:    maxSessions,
		now:    now,
		expiry: make(map[[sha256.Size]byte]time.Time),
	}
}

func (s *sessionStore) create() string {
	var raw [sessionTokenBytes]byte
	_, _ = rand.Read(raw[:])
	token := base64.RawURLEncoding.EncodeToString(raw[:])

	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if !now.Before(s.nextSweep) || len(s.expiry) >= s.max {
		s.sweepLocked(now)
		s.nextSweep = now.Add(sessionSweepEvery)
	}
	for len(s.expiry) >= s.max {
		s.evictOldestLocked()
	}
	s.expiry[sha256.Sum256([]byte(token))] = now.Add(s.ttl)
	return token
}

func (s *sessionStore) valid(token string) bool {
	id := sha256.Sum256([]byte(token))
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	expiry, ok := s.expiry[id]
	if !ok {
		return false
	}
	if !now.Before(expiry) {
		delete(s.expiry, id)
		return false
	}
	return true
}

func (s *sessionStore) revoke(token string) {
	id := sha256.Sum256([]byte(token))
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.expiry, id)
}

func (s *sessionStore) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.expiry)
}

func (s *sessionStore) sweepLocked(now time.Time) {
	for id, expiry := range s.expiry {
		if !now.Before(expiry) {
			delete(s.expiry, id)
		}
	}
}

func (s *sessionStore) evictOldestLocked() {
	var oldest [sha256.Size]byte
	var oldestExpiry time.Time
	for id, expiry := range s.expiry {
		if oldestExpiry.IsZero() || expiry.Before(oldestExpiry) {
			oldest, oldestExpiry = id, expiry
		}
	}
	delete(s.expiry, oldest)
}

func (s *Server) hasValidSession(r *http.Request) bool {
	cookie, err := r.Cookie(sessionCookieName)
	return err == nil && s.sessions.valid(cookie.Value)
}

func (s *Server) sessionCookie(value string, maxAge int) *http.Cookie {
	return &http.Cookie{
		Name:     sessionCookieName,
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   !s.insecureDev,
		SameSite: http.SameSiteStrictMode,
	}
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if !allowMethods(w, r, http.MethodPost) {
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxLoginBody))
	if err != nil {
		writeBodyError(w, err)
		return
	}
	var request struct {
		Password *string `json:"password"`
	}
	if err := json.Unmarshal(body, &request); err != nil || request.Password == nil {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}

	// A malformed request tests no password, so only a real attempt is counted.
	// The attempt is counted before the check, which also means a blocked client
	// gets 429 even with the right password.
	client := clientKey(r)
	allowed, retry := s.loginLimit.Allow(client)
	if !allowed {
		writeRateLimited(w, retry)
		return
	}
	if !s.password.check(*request.Password) {
		writeError(w, http.StatusUnauthorized, "wrong password")
		return
	}
	s.loginLimit.Reset(client)

	http.SetCookie(w, s.sessionCookie(s.sessions.create(), int(s.sessionTTL.Seconds())))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	if !allowMethods(w, r, http.MethodGet, http.MethodHead) {
		return
	}
	if !s.hasValidSession(r) {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if !allowMethods(w, r, http.MethodPost) {
		return
	}
	if cookie, err := r.Cookie(sessionCookieName); err == nil {
		s.sessions.revoke(cookie.Value)
	}
	http.SetCookie(w, s.sessionCookie("", -1))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func writeBodyError(w http.ResponseWriter, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		writeError(w, http.StatusRequestEntityTooLarge, "request too large")
		return
	}
	writeError(w, http.StatusBadRequest, "could not read request")
}
