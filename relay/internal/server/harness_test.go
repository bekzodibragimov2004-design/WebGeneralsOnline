package server

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	testPassword  = "fake-password-for-tests-only"
	wrongPassword = "fake-wrong-password-for-tests"
	secretMarker  = "OUTSIDE-THE-ROOT-MARKER"
	secretName    = "outside-secret.txt"
)

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newFakeClock() *fakeClock { return &fakeClock{t: time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)} }

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// harness runs a real Server on a loopback port over synthetic directories. A
// file containing secretMarker sits beside the roots, as a target for escapes.
type harness struct {
	t      *testing.T
	srv    *Server
	ts     *httptest.Server
	client *http.Client
	clock  *fakeClock
	logs   *syncBuffer

	base      string
	assetDir  string
	webDir    string
	engineDir string
	crashDir  string
}

func newHarness(t *testing.T, mutate ...func(*Options)) *harness {
	t.Helper()
	base := t.TempDir()
	h := &harness{
		t:         t,
		clock:     newFakeClock(),
		logs:      &syncBuffer{},
		base:      base,
		assetDir:  filepath.Join(base, "assets"),
		webDir:    filepath.Join(base, "web"),
		engineDir: filepath.Join(base, "engine"),
		crashDir:  filepath.Join(base, "crash"),
	}
	for _, dir := range []string{h.assetDir, h.webDir, h.engineDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeFile(t, filepath.Join(base, secretName), secretMarker)

	opts := Options{
		Password:    testPassword,
		InsecureDev: true,
		AssetDir:    h.assetDir,
		WebDir:      h.webDir,
		EngineDir:   h.engineDir,
		CrashDir:    h.crashDir,
		Logger:      slog.New(slog.NewJSONHandler(h.logs, nil)),
		Now:         h.clock.Now,
	}
	for _, m := range mutate {
		m(&opts)
	}
	srv, err := New(opts)
	if err != nil {
		t.Fatal(err)
	}
	h.srv = srv
	h.ts = httptest.NewServer(srv)
	t.Cleanup(h.ts.Close)

	transport := &http.Transport{DisableCompression: true}
	t.Cleanup(transport.CloseIdleConnections)
	h.client = &http.Client{
		Transport: transport,
		Timeout:   10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	return h
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

type result struct {
	status int
	header http.Header
	body   []byte
}

type reqOption func(*http.Request)

func withCookie(c *http.Cookie) reqOption {
	return func(r *http.Request) {
		if c != nil {
			r.AddCookie(c)
		}
	}
}

func withHeader(key, value string) reqOption {
	return func(r *http.Request) { r.Header.Set(key, value) }
}

func (h *harness) do(method, target, body string, opts ...reqOption) *result {
	h.t.Helper()
	req, err := http.NewRequest(method, h.ts.URL+target, strings.NewReader(body))
	if err != nil {
		h.t.Fatal(err)
	}
	for _, opt := range opts {
		opt(req)
	}
	resp, err := h.client.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		h.t.Fatal(err)
	}
	return &result{status: resp.StatusCode, header: resp.Header, body: data}
}

func loginBody(password string) string {
	encoded, err := json.Marshal(map[string]string{"password": password})
	if err != nil {
		panic(err)
	}
	return string(encoded)
}

// login signs in and returns the session cookie.
func (h *harness) login() *http.Cookie {
	h.t.Helper()
	r := h.do("POST", "/api/login", loginBody(testPassword))
	if r.status != http.StatusNoContent {
		h.t.Fatalf("login status = %d, body %s", r.status, r.body)
	}
	return sessionCookieFrom(h.t, r.header)
}

func sessionCookieFrom(t *testing.T, header http.Header) *http.Cookie {
	t.Helper()
	response := http.Response{Header: header}
	for _, c := range response.Cookies() {
		if c.Name == sessionCookieName {
			return c
		}
	}
	t.Fatalf("no %s cookie in %v", sessionCookieName, header)
	return nil
}

// serveFrom calls the handler directly with a chosen client address. The real
// network would make every request come from 127.0.0.1.
func (h *harness) serveFrom(ip, method, target, body string, opts ...reqOption) *httptest.ResponseRecorder {
	h.t.Helper()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.RemoteAddr = net.JoinHostPort(ip, "40000")
	for _, opt := range opts {
		opt(req)
	}
	rec := httptest.NewRecorder()
	h.srv.ServeHTTP(rec, req)
	return rec
}

// raw sends the request line byte for byte. An HTTP client would normalize or
// refuse many of the hostile targets the traversal tests need.
func (h *harness) raw(method, target string, cookie *http.Cookie) *result {
	h.t.Helper()
	conn, err := net.DialTimeout("tcp", h.ts.Listener.Addr().String(), 5*time.Second)
	if err != nil {
		h.t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		h.t.Fatal(err)
	}
	var request strings.Builder
	fmt.Fprintf(&request, "%s %s HTTP/1.1\r\nHost: test.invalid\r\nConnection: close\r\n", method, target)
	if cookie != nil {
		fmt.Fprintf(&request, "Cookie: %s=%s\r\n", cookie.Name, cookie.Value)
	}
	request.WriteString("\r\n")
	if _, err := io.WriteString(conn, request.String()); err != nil {
		h.t.Fatal(err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		h.t.Fatalf("reading response to %q: %v", target, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		h.t.Fatal(err)
	}
	return &result{status: resp.StatusCode, header: resp.Header, body: data}
}

func requireSecurityHeaders(t *testing.T, label string, header http.Header) {
	t.Helper()
	for name, want := range map[string]string{
		"Cross-Origin-Opener-Policy":   "same-origin",
		"Cross-Origin-Embedder-Policy": "require-corp",
		"Cross-Origin-Resource-Policy": "same-origin",
	} {
		if got := header.Get(name); got != want {
			t.Errorf("%s: %s = %q, want %q", label, name, got, want)
		}
	}
}

func crashFiles(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}
