package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
)

// TestLogsHoldNoSecrets pushes the password, a wrong password and a session token
// through every place a client can put them, on every route, and then searches
// everything the server logged.
func TestLogsHoldNoSecrets(t *testing.T) {
	h := newHarness(t)
	writeFile(t, filepath.Join(h.webDir, "index.html"), "<title>gate</title>")
	writeFile(t, filepath.Join(h.assetDir, "manifest.json"), `{"schema":1}`)
	writeFile(t, filepath.Join(h.assetDir, "game.big"), "synthetic")
	writeFile(t, filepath.Join(h.engineDir, "game.wasm"), "synthetic")

	cookie := h.login()
	session := cookie.Value

	secrets := []string{testPassword, wrongPassword, session}
	for _, secret := range secrets {
		for _, target := range []string{
			"/",
			"/shell/" + secret,
			"/" + secret,
			"/?password=" + secret,
			"/api/login?password=" + secret,
			"/api/session?token=" + secret,
			"/assets/manifest.json?x=" + secret,
			"/assets/files/" + secret,
			"/assets/files/game.big?x=" + secret,
			"/engine/" + secret,
			"/go-api/" + secret,
			"/relay?x=" + secret,
		} {
			// With and without a session, so both the 401 and the served path run.
			h.do("GET", target, "", withCookie(cookie))
			h.do("GET", target, "")
			h.do("GET", target, "", withCookie(&http.Cookie{Name: sessionCookieName, Value: secret}))
			h.do("GET", target, "",
				withHeader("Authorization", "Bearer "+secret),
				withHeader("X-Forwarded-For", secret),
				withHeader("Referer", "https://test.invalid/?p="+secret),
				withHeader("User-Agent", secret))
		}
		// Bodies, in valid and invalid forms.
		h.do("POST", "/api/login", loginBody(secret))
		h.do("POST", "/api/login", "not json "+secret)
		h.do("POST", "/api/login", `{"password":`+secret+`}`)
		h.do("POST", "/api/crash", `{"message":"`+secret+`"}`, withCookie(cookie))
		h.do("POST", "/api/crash", "not json "+secret, withCookie(cookie))
		h.do("POST", "/go-api/x", secret, withCookie(cookie))
	}
	// Odd methods and a raw malformed path.
	h.do("OPTIONS", "/api/login", "")
	h.do("DELETE", "/assets/manifest.json", "", withCookie(cookie))
	h.raw("GET", "/assets/files/..%2f"+testPassword, cookie)

	// The rate limiter's paths, which respond differently.
	for range defaultLoginLimit().Free + 2 {
		h.serveFrom("192.0.2.70", "POST", "/api/login", loginBody(testPassword+"-wrong"))
	}
	h.do("POST", "/api/logout", "", withCookie(cookie))

	logs := h.logs.String()
	if logs == "" {
		t.Fatal("nothing was logged, so this test proves nothing")
	}
	encoded, err := json.Marshal(testPassword)
	if err != nil {
		t.Fatal(err)
	}
	for _, needle := range []string{
		testPassword,
		wrongPassword,
		session,
		strings.Trim(string(encoded), `"`),
		fmt.Sprintf("%x", testPassword),
		sessionCookieName,
		"Set-Cookie",
		"Authorization",
		"Bearer",
	} {
		if strings.Contains(logs, needle) {
			t.Errorf("logs contain %q", needle)
		}
	}
}

// TestAccessLogRecordsOnlyFixedFields locks the log schema: adding a field that
// carries client data has to change this test.
func TestAccessLogRecordsOnlyFixedFields(t *testing.T) {
	h := newHarness(t)
	h.do("GET", "/no/such/path?query=value", "", withHeader("User-Agent", "synthetic-agent"))

	var record map[string]any
	line, _, _ := strings.Cut(h.logs.String(), "\n")
	if err := json.Unmarshal([]byte(line), &record); err != nil {
		t.Fatalf("log line is not JSON: %v: %q", err, line)
	}
	want := map[string]bool{
		"time": true, "level": true, "msg": true, "route": true, "method": true,
		"status": true, "bytes": true, "dur_ms": true, "client": true, "proto": true,
	}
	for key := range record {
		if !want[key] {
			t.Errorf("unexpected access log field %q", key)
		}
	}
	for key := range want {
		if _, ok := record[key]; !ok {
			t.Errorf("access log lacks %q", key)
		}
	}
	if record["route"] != "unknown" || record["status"] != float64(404) || record["client"] != "127.0.0.1" {
		t.Errorf("record = %v", record)
	}
}

func TestUnusualMethodsAreNotLoggedVerbatim(t *testing.T) {
	h := newHarness(t)
	h.do("FAKE-SECRET-METHOD", "/", "")
	logs := h.logs.String()
	if strings.Contains(logs, "FAKE-SECRET-METHOD") {
		t.Error("custom method reached the log")
	}
	if !strings.Contains(logs, `"method":"OTHER"`) {
		t.Errorf("logs = %s", logs)
	}
}
