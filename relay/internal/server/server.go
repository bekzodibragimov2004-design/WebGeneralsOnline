// Package server implements the routes in docs/WEB_CONTRACT.md.
package server

import (
	"bufio"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net"
	"net/http"
	"net/netip"
	"runtime/debug"
	"slices"
	"strconv"
	"strings"
	"time"

	"webgeneralsonline/relay/internal/ratelimit"
)

const (
	// defaultWriteStall bounds how long one write to a client may take. The
	// deadline rolls forward with every write, so a large file on a slow link
	// finishes while a client that stops reading is dropped.
	defaultWriteStall = 60 * time.Second

	defaultSessionTTL     = 7 * 24 * time.Hour
	defaultMaxSessions    = 4096
	defaultCrashMaxStored = 256 << 20
)

// Options configures a Server. Zero values take the documented defaults, except
// for the required password and directories.
type Options struct {
	Password    string
	InsecureDev bool // drops the cookie's Secure attribute

	AssetDir  string
	WebDir    string
	EngineDir string
	CrashDir  string

	Logger *slog.Logger

	// GoAPI and Relay handle /go-api and /relay. They only ever see requests
	// that hold a valid session, and a nil handler answers 501. The server sets
	// no write deadline or body limit on these routes, so each handler applies
	// its own, and one that reads for longer than the server's read timeout must
	// extend it. The ResponseWriter supports Hijack, Flush and
	// http.ResponseController. The request still carries the session cookie, which
	// must not be forwarded upstream.
	GoAPI http.Handler
	Relay http.Handler

	SessionTTL     time.Duration // default 7 days
	MaxSessions    int           // default 4096
	CrashMaxStored int64         // total stored crash bytes, default 256 MiB
	WriteStall     time.Duration // time allowed per write to a client, default 60s

	LoginLimit ratelimit.Options // see defaultLoginLimit
	CrashLimit ratelimit.Options // see defaultCrashLimit

	Now func() time.Time // clock for sessions and limits, default time.Now
}

// Server is the http.Handler for every route. cmd/relay builds the http.Server
// around it.
type Server struct {
	log         *slog.Logger
	insecureDev bool
	sessionTTL  time.Duration
	writeStall  time.Duration

	assetDir  string
	webDir    string
	engineDir string

	password   *passwordChecker
	sessions   *sessionStore
	loginLimit *ratelimit.Limiter
	crashLimit *ratelimit.Limiter
	crash      *crashStore

	goAPI http.Handler
	relay http.Handler
}

func defaultLoginLimit() ratelimit.Options {
	return ratelimit.Options{
		MaxKeys:     1 << 16,
		Free:        5,
		BaseDelay:   time.Second,
		MaxDelay:    15 * time.Minute,
		ForgetAfter: 24 * time.Hour,
	}
}

func defaultCrashLimit() ratelimit.Options {
	return ratelimit.Options{
		MaxKeys:     1 << 12,
		Free:        20,
		BaseDelay:   time.Minute,
		MaxDelay:    time.Hour,
		ForgetAfter: time.Hour,
	}
}

// New validates the options and prepares the crash directory.
func New(opts Options) (*Server, error) {
	if strings.TrimSpace(opts.Password) == "" {
		return nil, errors.New("site password is empty")
	}
	if opts.AssetDir == "" || opts.WebDir == "" || opts.EngineDir == "" || opts.CrashDir == "" {
		return nil, errors.New("asset, web, engine and crash directories are required")
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.SessionTTL <= 0 {
		opts.SessionTTL = defaultSessionTTL
	}
	if opts.MaxSessions <= 0 {
		opts.MaxSessions = defaultMaxSessions
	}
	if opts.CrashMaxStored <= 0 {
		opts.CrashMaxStored = defaultCrashMaxStored
	}
	if opts.WriteStall <= 0 {
		opts.WriteStall = defaultWriteStall
	}
	if opts.LoginLimit.MaxKeys == 0 {
		opts.LoginLimit = defaultLoginLimit()
	}
	if opts.CrashLimit.MaxKeys == 0 {
		opts.CrashLimit = defaultCrashLimit()
	}
	if opts.LoginLimit.Now == nil {
		opts.LoginLimit.Now = opts.Now
	}
	if opts.CrashLimit.Now == nil {
		opts.CrashLimit.Now = opts.Now
	}
	if opts.GoAPI == nil {
		opts.GoAPI = http.HandlerFunc(notImplemented)
	}
	if opts.Relay == nil {
		opts.Relay = http.HandlerFunc(notImplemented)
	}

	crash, err := newCrashStore(opts.CrashDir, opts.CrashMaxStored, opts.Now)
	if err != nil {
		return nil, err
	}
	return &Server{
		log:         opts.Logger,
		insecureDev: opts.InsecureDev,
		sessionTTL:  opts.SessionTTL,
		writeStall:  opts.WriteStall,
		assetDir:    opts.AssetDir,
		webDir:      opts.WebDir,
		engineDir:   opts.EngineDir,
		password:    newPasswordChecker(opts.Password),
		sessions:    newSessionStore(opts.SessionTTL, opts.MaxSessions, opts.Now),
		loginLimit:  ratelimit.New(opts.LoginLimit),
		crashLimit:  ratelimit.New(opts.CrashLimit),
		crash:       crash,
		goAPI:       opts.GoAPI,
		relay:       opts.Relay,
	}, nil
}

// route is what a request path resolves to. name is a fixed label and the only
// description of the request that reaches the access log: the path, query,
// headers and body are client-supplied and could hold a secret.
type route struct {
	name    string
	handler http.HandlerFunc
	plugin  bool // the handler manages its own deadlines
}

// match resolves a decoded path. Nothing here normalizes the path, so a path
// that needs cleaning to reach a protected route never matches it, and the file
// handlers reject any path holding a ".." segment.
func (s *Server) match(path string) route {
	switch {
	case path == "/", isUnder(path, "/shell"):
		return route{name: "shell", handler: s.handleShell}
	case path == "/api/login":
		return route{name: "login", handler: s.handleLogin}
	case path == "/api/session":
		return route{name: "session", handler: s.handleSession}
	case path == "/api/logout":
		return route{name: "logout", handler: s.protect(s.handleLogout)}
	case path == "/api/crash":
		return route{name: "crash", handler: s.protect(s.handleCrash)}
	case path == "/assets/manifest.json":
		return route{name: "assets.manifest", handler: s.protect(s.handleManifest)}
	case isUnder(path, "/assets"):
		return route{name: "assets.file", handler: s.protect(s.handleAssetFile)}
	case isUnder(path, "/engine"):
		return route{name: "engine", handler: s.protect(s.handleEngine)}
	case isUnder(path, "/go-api"):
		return route{name: "go-api", handler: s.protect(s.goAPI.ServeHTTP), plugin: true}
	case isUnder(path, "/relay"):
		return route{name: "relay", handler: s.protect(s.relay.ServeHTTP), plugin: true}
	}
	return route{name: "unknown", handler: func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "not found")
	}}
}

func isUnder(path, prefix string) bool {
	return path == prefix || strings.HasPrefix(path, prefix+"/")
}

// ServeHTTP is the single entry point. The contract's headers are set before
// anything else can run, so every path out of here carries them, including
// errors and panics.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	setSecurityHeaders(w.Header())

	rt := s.match(r.URL.Path)
	sw := newStatusWriter(w)
	if rt.plugin {
		sw.clearDeadline()
	} else {
		sw.stall = s.writeStall
		sw.refreshDeadline()
	}

	start := time.Now()
	defer func() {
		panicked := recover()
		abort := false
		if panicked != nil {
			abort = s.recoverPanic(sw, rt.name, panicked)
		}
		s.log.LogAttrs(r.Context(), slog.LevelInfo, "request",
			slog.String("route", rt.name),
			slog.String("method", logMethod(r.Method)),
			slog.Int("status", sw.statusCode()),
			slog.Int64("bytes", sw.bytes),
			slog.Int64("dur_ms", time.Since(start).Milliseconds()),
			slog.String("client", clientKey(r)),
			slog.String("proto", r.Proto),
		)
		if abort {
			panic(http.ErrAbortHandler)
		}
	}()

	rt.handler(sw, r)
}

// recoverPanic logs a handler panic and answers 500 if it still can. It reports
// whether the connection must be aborted instead. The panic value is left out of
// the log because it may have been built from request data.
func (s *Server) recoverPanic(sw *statusWriter, routeName string, panicked any) (abort bool) {
	if err, ok := panicked.(error); ok && errors.Is(err, http.ErrAbortHandler) {
		return true
	}
	s.log.Error("handler panic",
		"route", routeName,
		"panic_type", fmt.Sprintf("%T", panicked),
		"stack", string(debug.Stack()),
	)
	if sw.status != 0 {
		return true
	}
	writeError(sw, http.StatusInternalServerError, "internal error")
	return false
}

// protect answers 401 unless the request holds a valid session. It runs before
// any other check, so a route reveals nothing to a client without a cookie.
func (s *Server) protect(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.hasValidSession(r) {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next(w, r)
	}
}

func notImplemented(w http.ResponseWriter, _ *http.Request) {
	writeError(w, http.StatusNotImplemented, "not implemented")
}

func setSecurityHeaders(h http.Header) {
	h.Set("Cross-Origin-Opener-Policy", "same-origin")
	h.Set("Cross-Origin-Embedder-Policy", "require-corp")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")
	h.Set("X-Content-Type-Options", "nosniff")
}

// writeError sends a JSON error. msg must be a constant: it is never built from
// request data.
func writeError(w http.ResponseWriter, code int, msg string) {
	h := w.Header()
	for _, name := range []string{"Content-Length", "Content-Encoding", "ETag", "Last-Modified", "Accept-Ranges"} {
		h.Del(name)
	}
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_, _ = fmt.Fprintf(w, "{\"error\":%q}\n", msg)
}

func writeRateLimited(w http.ResponseWriter, retry time.Duration) {
	seconds := max(int64(math.Ceil(retry.Seconds())), 1)
	w.Header().Set("Retry-After", strconv.FormatInt(seconds, 10))
	writeError(w, http.StatusTooManyRequests, "too many attempts")
}

func allowMethods(w http.ResponseWriter, r *http.Request, methods ...string) bool {
	if slices.Contains(methods, r.Method) {
		return true
	}
	w.Header().Set("Allow", strings.Join(methods, ", "))
	writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	return false
}

// clientKey identifies the client for rate limits and logs. It uses the socket
// address only: forwarding headers are client-controlled and would let anyone
// pick their own rate limit bucket. An IPv6 client is keyed by its /64, because
// one subscriber can usually use every address in it.
func clientKey(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return "unknown"
	}
	addr = addr.Unmap().WithZone("")
	if addr.Is6() {
		prefix, err := addr.Prefix(64)
		if err != nil {
			return "unknown"
		}
		return prefix.String()
	}
	return addr.String()
}

func logMethod(method string) string {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch,
		http.MethodDelete, http.MethodOptions, http.MethodConnect:
		return method
	}
	return "OTHER"
}

// statusWriter records the response for the access log and applies the rolling
// write deadline. It deliberately has no ReadFrom, so large files go through
// Write and keep refreshing the deadline.
type statusWriter struct {
	http.ResponseWriter
	rc     *http.ResponseController
	status int
	bytes  int64
	stall  time.Duration
}

func newStatusWriter(w http.ResponseWriter) *statusWriter {
	return &statusWriter{ResponseWriter: w, rc: http.NewResponseController(w)}
}

func (w *statusWriter) refreshDeadline() {
	if w.stall > 0 {
		_ = w.rc.SetWriteDeadline(time.Now().Add(w.stall))
	}
}

// clearDeadline removes a deadline left by an earlier request on this connection.
func (w *statusWriter) clearDeadline() {
	_ = w.rc.SetWriteDeadline(time.Time{})
}

func (w *statusWriter) statusCode() int {
	if w.status == 0 {
		return http.StatusOK
	}
	return w.status
}

func (w *statusWriter) WriteHeader(code int) {
	if w.status == 0 && code >= 200 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	w.refreshDeadline()
	n, err := w.ResponseWriter.Write(p)
	w.bytes += int64(n)
	return n, err
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// Flush implements http.Flusher for plug-in handlers.
func (w *statusWriter) Flush() {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	_ = w.rc.Flush()
}

// Hijack implements http.Hijacker for the WebSocket relay.
func (w *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, rw, err := w.rc.Hijack()
	if err == nil {
		w.status = http.StatusSwitchingProtocols
	}
	return conn, rw, err
}
