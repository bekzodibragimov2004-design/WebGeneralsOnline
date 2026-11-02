package server

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// protectedRoutes lists every route the contract guards with the cookie.
var protectedRoutes = []struct{ method, target string }{
	{"POST", "/api/logout"},
	{"POST", "/api/crash"},
	{"GET", "/assets/manifest.json"},
	{"HEAD", "/assets/manifest.json"},
	{"GET", "/assets/files/Data/test.big"},
	{"HEAD", "/assets/files/Data/test.big"},
	{"GET", "/assets"},
	{"GET", "/assets/"},
	{"GET", "/assets/other"},
	{"GET", "/engine/game.wasm"},
	{"GET", "/engine/game.js"},
	{"GET", "/engine"},
	{"GET", "/engine/"},
	{"GET", "/go-api"},
	{"GET", "/go-api/"},
	{"GET", "/go-api/anything"},
	{"POST", "/go-api/anything"},
	{"PUT", "/go-api/anything"},
	{"DELETE", "/go-api/anything"},
	{"GET", "/relay"},
	{"POST", "/relay"},
	{"GET", "/relay/sub"},
	// A wrong method must not reveal anything before the cookie is checked.
	{"DELETE", "/assets/manifest.json"},
	{"POST", "/assets/files/x"},
	{"PUT", "/engine/x"},
	{"GET", "/api/logout"},
	{"GET", "/api/crash"},
}

func TestEveryProtectedRouteAnswers401(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.SessionTTL = time.Hour })
	writeFile(t, filepath.Join(h.assetDir, "manifest.json"), `{"schema":1}`)
	writeFile(t, filepath.Join(h.assetDir, "Data", "test.big"), "synthetic")
	writeFile(t, filepath.Join(h.engineDir, "game.wasm"), "synthetic")

	expired := h.login()
	loggedOut := h.login()
	if r := h.do("POST", "/api/logout", "", withCookie(loggedOut)); r.status != http.StatusNoContent {
		t.Fatalf("logout = %d", r.status)
	}
	h.clock.Advance(time.Hour)

	credentials := map[string]*http.Cookie{
		"no cookie":      nil,
		"garbage":        {Name: sessionCookieName, Value: "not-a-real-session"},
		"empty":          {Name: sessionCookieName, Value: ""},
		"password":       {Name: sessionCookieName, Value: testPassword},
		"wrong name":     {Name: "other_session", Value: expired.Value},
		"expired":        {Name: sessionCookieName, Value: expired.Value},
		"logged out":     {Name: sessionCookieName, Value: loggedOut.Value},
		"long and false": {Name: sessionCookieName, Value: strings.Repeat("A", 43)},
	}
	for credName, cookie := range credentials {
		for _, route := range protectedRoutes {
			label := fmt.Sprintf("%s %s with %s", route.method, route.target, credName)
			r := h.do(route.method, route.target, "", withCookie(cookie))
			if r.status != http.StatusUnauthorized {
				t.Errorf("%s: status = %d, want 401", label, r.status)
			}
			if strings.Contains(string(r.body), "synthetic") {
				t.Errorf("%s: response body leaked file content", label)
			}
			requireSecurityHeaders(t, label, r.header)
		}
	}
}

func TestPublicRoutesNeedNoCookie(t *testing.T) {
	h := newHarness(t)
	writeFile(t, filepath.Join(h.webDir, "index.html"), "<title>gate</title>")
	writeFile(t, filepath.Join(h.webDir, "assets", "index-AbCd1234.js"), "// shell")
	for _, target := range []string{"/", "/shell", "/shell/", "/shell/assets/index-AbCd1234.js"} {
		if r := h.do("GET", target, ""); r.status != http.StatusOK {
			t.Errorf("GET %s = %d, want 200", target, r.status)
		}
	}
	if r := h.do("GET", "/api/session", ""); r.status != http.StatusUnauthorized {
		t.Errorf("GET /api/session = %d, want 401", r.status)
	}
	if r := h.do("POST", "/api/login", loginBody(wrongPassword)); r.status != http.StatusUnauthorized {
		t.Errorf("POST /api/login = %d, want 401", r.status)
	}
}

func TestStubsAnswer501BehindCookie(t *testing.T) {
	h := newHarness(t)
	cookie := h.login()
	for _, tc := range []struct{ method, target string }{
		{"GET", "/go-api"},
		{"GET", "/go-api/lobbies"},
		{"POST", "/go-api/auth"},
		{"GET", "/relay"},
		{"POST", "/relay"},
	} {
		r := h.do(tc.method, tc.target, "", withCookie(cookie))
		if r.status != http.StatusNotImplemented {
			t.Errorf("%s %s = %d, want 501", tc.method, tc.target, r.status)
		}
		requireSecurityHeaders(t, tc.target, r.header)
	}
}

func TestPluginsOnlySeeAuthenticatedRequests(t *testing.T) {
	var goAPICalls, relayCalls atomic.Int64
	h := newHarness(t, func(o *Options) {
		o.GoAPI = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			goAPICalls.Add(1)
			w.WriteHeader(http.StatusTeapot)
		})
		o.Relay = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			relayCalls.Add(1)
			w.WriteHeader(http.StatusAccepted)
		})
	})
	if r := h.do("GET", "/go-api/x", ""); r.status != http.StatusUnauthorized {
		t.Errorf("go-api without cookie = %d", r.status)
	}
	if r := h.do("GET", "/relay", ""); r.status != http.StatusUnauthorized {
		t.Errorf("relay without cookie = %d", r.status)
	}
	if goAPICalls.Load() != 0 || relayCalls.Load() != 0 {
		t.Fatalf("handlers ran without a session: %d, %d", goAPICalls.Load(), relayCalls.Load())
	}
	cookie := h.login()
	if r := h.do("GET", "/go-api/x", "", withCookie(cookie)); r.status != http.StatusTeapot {
		t.Errorf("go-api with cookie = %d", r.status)
	}
	r := h.do("GET", "/relay", "", withCookie(cookie))
	if r.status != http.StatusAccepted {
		t.Errorf("relay with cookie = %d", r.status)
	}
	requireSecurityHeaders(t, "plugin response", r.header)
	if goAPICalls.Load() != 1 || relayCalls.Load() != 1 {
		t.Fatalf("handler calls = %d, %d, want 1, 1", goAPICalls.Load(), relayCalls.Load())
	}
}

// The WebSocket relay will need to take over the connection through the access
// log's wrapper. Both plug-ins manage their own deadlines: docs/NETWORK.md allows
// uploads of up to 10 minutes, which outlast the server's read timeout.
func TestPluginCanHijackAndControlDeadlines(t *testing.T) {
	deadlineErr := make(chan error, 1)
	h := newHarness(t, func(o *Options) {
		o.Relay = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			controller := http.NewResponseController(w)
			deadlineErr <- errors.Join(
				controller.SetWriteDeadline(time.Time{}),
				controller.SetReadDeadline(time.Time{}),
			)
			hijacker, ok := w.(http.Hijacker)
			if !ok {
				t.Error("ResponseWriter is not an http.Hijacker")
				return
			}
			conn, rw, err := hijacker.Hijack()
			if err != nil {
				t.Errorf("Hijack: %v", err)
				return
			}
			defer conn.Close()
			_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\n\r\nhello")
			_ = rw.Flush()
		})
	})
	cookie := h.login()

	conn, err := net.DialTimeout("tcp", h.ts.Listener.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(conn, "GET /relay HTTP/1.1\r\nHost: test.invalid\r\nCookie: %s=%s\r\n\r\n", cookie.Name, cookie.Value)
	reader := bufio.NewReader(conn)
	resp, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("status = %d, want 101", resp.StatusCode)
	}
	rest, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if string(rest) != "hello" {
		t.Fatalf("hijacked stream = %q", rest)
	}
	if err := <-deadlineErr; err != nil {
		t.Fatalf("setting deadlines through the wrapper: %v", err)
	}
}

func TestSecurityHeadersOnEveryKindOfResponse(t *testing.T) {
	h := newHarness(t, func(o *Options) {
		o.Relay = http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			panic("synthetic panic for the test")
		})
	})
	writeFile(t, filepath.Join(h.webDir, "index.html"), "<title>gate</title>")
	writeFile(t, filepath.Join(h.assetDir, "manifest.json"), `{"schema":1}`)
	writeFile(t, filepath.Join(h.assetDir, "game.big"), "0123456789")
	writeFile(t, filepath.Join(h.engineDir, "game.wasm"), "wasm")
	cookie := h.login()

	file := h.do("GET", "/assets/files/game.big", "", withCookie(cookie))
	etag := file.header.Get("ETag")

	for _, tc := range []struct {
		name   string
		method string
		target string
		body   string
		want   int
		opts   []reqOption
	}{
		{"200 shell", "GET", "/", "", 200, nil},
		{"200 asset", "GET", "/assets/files/game.big", "", 200, []reqOption{withCookie(cookie)}},
		{"200 engine", "GET", "/engine/game.wasm", "", 200, []reqOption{withCookie(cookie)}},
		{"204 session", "GET", "/api/session", "", 204, []reqOption{withCookie(cookie)}},
		{"206 range", "GET", "/assets/files/game.big", "", 206, []reqOption{withCookie(cookie), withHeader("Range", "bytes=0-1")}},
		{"304 not modified", "GET", "/assets/files/game.big", "", 304, []reqOption{withCookie(cookie), withHeader("If-None-Match", etag)}},
		{"400 bad login", "POST", "/api/login", "nope", 400, nil},
		{"401 no cookie", "GET", "/assets/manifest.json", "", 401, nil},
		{"401 wrong password", "POST", "/api/login", loginBody(wrongPassword), 401, nil},
		{"404 asset", "GET", "/assets/files/missing.big", "", 404, []reqOption{withCookie(cookie)}},
		{"404 unknown route", "GET", "/no/such/route", "", 404, nil},
		{"404 unknown api", "GET", "/api/nope", "", 404, nil},
		{"405 method", "DELETE", "/", "", 405, nil},
		{"413 login", "POST", "/api/login", strings.Repeat("x", maxLoginBody+1), 413, nil},
		{"413 crash", "POST", "/api/crash", strings.Repeat("x", maxCrashBody+1), 413, []reqOption{withCookie(cookie)}},
		{"416 range", "GET", "/assets/files/game.big", "", 416, []reqOption{withCookie(cookie), withHeader("Range", "bytes=1000-")}},
		{"500 panic", "GET", "/relay", "", 500, []reqOption{withCookie(cookie)}},
		{"501 stub", "GET", "/go-api/x", "", 501, []reqOption{withCookie(cookie)}},
	} {
		r := h.do(tc.method, tc.target, tc.body, tc.opts...)
		if r.status != tc.want {
			t.Errorf("%s: status = %d, want %d", tc.name, r.status, tc.want)
		}
		requireSecurityHeaders(t, tc.name, r.header)
	}

	// 429 needs its own client address so it cannot disturb the cases above.
	for range defaultLoginLimit().Free {
		h.serveFrom("192.0.2.50", "POST", "/api/login", loginBody(wrongPassword))
	}
	rec := h.serveFrom("192.0.2.50", "POST", "/api/login", loginBody(wrongPassword))
	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("status = %d, want 429", rec.Code)
	}
	requireSecurityHeaders(t, "429", rec.Header())
}

func TestPanicIsLoggedWithoutItsValue(t *testing.T) {
	h := newHarness(t, func(o *Options) {
		o.Relay = http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			panic("panic value built from request data: " + testPassword)
		})
	})
	cookie := h.login()
	if r := h.do("GET", "/relay", "", withCookie(cookie)); r.status != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", r.status)
	}
	logs := h.logs.String()
	if !strings.Contains(logs, "handler panic") {
		t.Errorf("panic not logged: %s", logs)
	}
	if strings.Contains(logs, testPassword) {
		t.Error("panic value reached the log")
	}
}

func TestPanicAfterHeadersAbortsTheConnection(t *testing.T) {
	h := newHarness(t, func(o *Options) {
		o.Relay = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Length", "100")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("partial"))
			w.(http.Flusher).Flush()
			panic("synthetic late panic")
		})
	})
	cookie := h.login()
	req, err := http.NewRequest("GET", h.ts.URL+"/relay", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(cookie)
	resp, err := h.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if _, err := io.ReadAll(resp.Body); err == nil {
		t.Fatal("a truncated body should surface as a read error")
	}
}
