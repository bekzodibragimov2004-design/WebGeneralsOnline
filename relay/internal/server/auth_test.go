package server

import (
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"webgeneralsonline/relay/internal/ratelimit"
)

func TestLoginCorrectPassword(t *testing.T) {
	h := newHarness(t)

	if r := h.do("GET", "/api/session", ""); r.status != http.StatusUnauthorized {
		t.Fatalf("session before login = %d, want 401", r.status)
	}
	r := h.do("POST", "/api/login", loginBody(testPassword))
	if r.status != http.StatusNoContent {
		t.Fatalf("login = %d, want 204", r.status)
	}
	if len(r.body) != 0 {
		t.Errorf("204 has a body: %q", r.body)
	}
	cookie := sessionCookieFrom(t, r.header)
	if r := h.do("GET", "/api/session", "", withCookie(cookie)); r.status != http.StatusNoContent {
		t.Fatalf("session after login = %d, want 204", r.status)
	}
}

func TestLoginWrongPasswords(t *testing.T) {
	cases := map[string]string{
		"different":       wrongPassword,
		"empty":           "",
		"prefix":          testPassword[:len(testPassword)-1],
		"extended":        testPassword + "x",
		"different case":  strings.ToUpper(testPassword),
		"trailing space":  testPassword + " ",
		"much longer":     strings.Repeat("x", 3000),
		"single byte":     "x",
		"same length":     strings.Repeat("x", len(testPassword)),
		"contains marker": "a" + testPassword + "b",
	}
	for name, candidate := range cases {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			r := h.do("POST", "/api/login", loginBody(candidate))
			if r.status != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", r.status)
			}
			if got := r.header.Values("Set-Cookie"); len(got) != 0 {
				t.Errorf("wrong password set a cookie: %v", got)
			}
		})
	}
}

func TestPasswordCheckerAcrossLengths(t *testing.T) {
	c := newPasswordChecker(testPassword)
	if !c.check(testPassword) {
		t.Error("correct password refused")
	}
	for _, candidate := range []string{"", "a", testPassword + "a", testPassword[1:], strings.Repeat("a", 1<<16)} {
		if c.check(candidate) {
			t.Errorf("accepted %d-byte wrong candidate", len(candidate))
		}
	}
	if strings.Contains(string(c.digest), testPassword) {
		t.Error("digest holds the password")
	}
}

func TestPasswordDigestDiffersPerProcess(t *testing.T) {
	a, b := newPasswordChecker(testPassword), newPasswordChecker(testPassword)
	if string(a.digest) == string(b.digest) {
		t.Fatal("digest is not keyed")
	}
}

func TestLoginBadRequests(t *testing.T) {
	h := newHarness(t)
	for name, body := range map[string]string{
		"not json":        "password=" + testPassword,
		"empty body":      "",
		"missing field":   `{}`,
		"null field":      `{"password":null}`,
		"number field":    `{"password":123}`,
		"array":           `["` + testPassword + `"]`,
		"trailing data":   `{"password":"x"} {}`,
		"truncated":       `{"password":"`,
		"plain text JSON": `"` + testPassword + `"`,
	} {
		if r := h.do("POST", "/api/login", body); r.status != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", name, r.status)
		}
	}
	oversized := `{"password":"` + strings.Repeat("x", maxLoginBody) + `"}`
	if r := h.do("POST", "/api/login", oversized); r.status != http.StatusRequestEntityTooLarge {
		t.Errorf("oversized: status = %d, want 413", r.status)
	}
	r := h.do("GET", "/api/login", "")
	if r.status != http.StatusMethodNotAllowed || r.header.Get("Allow") != "POST" {
		t.Errorf("GET: status = %d, Allow = %q", r.status, r.header.Get("Allow"))
	}
}

func TestMalformedLoginsDoNotUseTheAttemptBudget(t *testing.T) {
	h := newHarness(t)
	for range 50 {
		if r := h.do("POST", "/api/login", "not json"); r.status != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", r.status)
		}
	}
	if r := h.do("POST", "/api/login", loginBody(testPassword)); r.status != http.StatusNoContent {
		t.Fatalf("login after malformed requests = %d, want 204", r.status)
	}
}

func TestCookieAttributes(t *testing.T) {
	for _, tc := range []struct {
		name       string
		insecure   bool
		wantSecure bool
	}{
		{"production", false, true},
		{"insecure dev", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, func(o *Options) { o.InsecureDev = tc.insecure })

			login := h.do("POST", "/api/login", loginBody(testPassword))
			checkCookieAttrs(t, login.header.Get("Set-Cookie"), tc.wantSecure)
			cookie := sessionCookieFrom(t, login.header)
			if cookie.MaxAge != int(defaultSessionTTL.Seconds()) {
				t.Errorf("MaxAge = %d", cookie.MaxAge)
			}

			logout := h.do("POST", "/api/logout", "", withCookie(cookie))
			raw := logout.header.Get("Set-Cookie")
			checkCookieAttrs(t, raw, tc.wantSecure)
			if !strings.HasPrefix(raw, sessionCookieName+"=;") || !strings.Contains(raw, "Max-Age=0") {
				t.Errorf("logout does not clear the cookie: %q", raw)
			}
		})
	}
}

func checkCookieAttrs(t *testing.T, raw string, wantSecure bool) {
	t.Helper()
	parts := strings.Split(raw, "; ")
	has := func(attr string) bool {
		for _, part := range parts {
			if strings.EqualFold(part, attr) {
				return true
			}
		}
		return false
	}
	if !strings.HasPrefix(raw, sessionCookieName+"=") {
		t.Errorf("cookie name wrong: %q", raw)
	}
	for _, attr := range []string{"HttpOnly", "SameSite=Strict", "Path=/"} {
		if !has(attr) {
			t.Errorf("cookie lacks %s: %q", attr, raw)
		}
	}
	if has("Secure") != wantSecure {
		t.Errorf("Secure present = %v, want %v: %q", has("Secure"), wantSecure, raw)
	}
}

func TestSessionTokensAreRandomAnd256Bit(t *testing.T) {
	h := newHarness(t)
	a, b := h.login(), h.login()
	if a.Value == b.Value {
		t.Fatal("two logins produced the same token")
	}
	for _, cookie := range []*http.Cookie{a, b} {
		raw, err := base64.RawURLEncoding.DecodeString(cookie.Value)
		if err != nil {
			t.Fatalf("token is not base64url: %v", err)
		}
		if len(raw) != 32 {
			t.Fatalf("token is %d bytes, want 32", len(raw))
		}
		if strings.Contains(cookie.Value, testPassword) ||
			strings.Contains(string(raw), testPassword) ||
			strings.Contains(cookie.Value, base64.RawURLEncoding.EncodeToString([]byte(testPassword))) {
			t.Fatal("cookie value contains the password")
		}
	}
}

func TestLogoutRevokesTheSession(t *testing.T) {
	h := newHarness(t)
	cookie := h.login()
	other := h.login()
	if r := h.do("POST", "/api/logout", "", withCookie(cookie)); r.status != http.StatusNoContent {
		t.Fatalf("logout = %d", r.status)
	}
	if r := h.do("GET", "/api/session", "", withCookie(cookie)); r.status != http.StatusUnauthorized {
		t.Errorf("session after logout = %d, want 401", r.status)
	}
	if r := h.do("GET", "/api/session", "", withCookie(other)); r.status != http.StatusNoContent {
		t.Errorf("other session after logout = %d, want 204", r.status)
	}
}

func TestSessionExpires(t *testing.T) {
	h := newHarness(t, func(o *Options) { o.SessionTTL = time.Hour })
	cookie := h.login()
	if cookie.MaxAge != 3600 {
		t.Errorf("MaxAge = %d, want 3600", cookie.MaxAge)
	}
	h.clock.Advance(time.Hour - time.Second)
	if r := h.do("GET", "/api/session", "", withCookie(cookie)); r.status != http.StatusNoContent {
		t.Fatalf("session before expiry = %d, want 204", r.status)
	}
	h.clock.Advance(time.Second)
	if r := h.do("GET", "/api/session", "", withCookie(cookie)); r.status != http.StatusUnauthorized {
		t.Fatalf("session at expiry = %d, want 401", r.status)
	}
	if got := h.srv.sessions.count(); got != 0 {
		t.Errorf("expired session still stored, count = %d", got)
	}
}

func TestSessionStoreIsBoundedAndKeepsNewest(t *testing.T) {
	clock := newFakeClock()
	store := newSessionStore(time.Hour, 3, clock.Now)
	oldest := store.create()
	clock.Advance(time.Second)
	var tokens []string
	for range 3 {
		tokens = append(tokens, store.create())
		clock.Advance(time.Second)
	}
	if got := store.count(); got != 3 {
		t.Fatalf("count = %d, want 3", got)
	}
	if store.valid(oldest) {
		t.Error("oldest session should have been evicted")
	}
	for _, token := range tokens {
		if !store.valid(token) {
			t.Error("a newer session was evicted")
		}
	}
}

func TestSessionStoreSweepsExpired(t *testing.T) {
	clock := newFakeClock()
	store := newSessionStore(time.Minute, 100, clock.Now)
	for range 10 {
		store.create()
	}
	clock.Advance(2 * time.Minute)
	store.create()
	if got := store.count(); got != 1 {
		t.Fatalf("count = %d, want 1 after sweeping expired sessions", got)
	}
}

func TestRateLimitBackoffAndRetryAfter(t *testing.T) {
	h := newHarness(t)
	limits := defaultLoginLimit()
	const ip = "192.0.2.10"

	for i := range limits.Free {
		if rec := h.serveFrom(ip, "POST", "/api/login", loginBody(wrongPassword)); rec.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d = %d, want 401", i+1, rec.Code)
		}
	}
	for _, wait := range []int{1, 2, 4, 8, 16} {
		rec := h.serveFrom(ip, "POST", "/api/login", loginBody(wrongPassword))
		if rec.Code != http.StatusTooManyRequests {
			t.Fatalf("status = %d, want 429 before the %ds wait", rec.Code, wait)
		}
		if got := rec.Header().Get("Retry-After"); got != strconv.Itoa(wait) {
			t.Fatalf("Retry-After = %q, want %d", got, wait)
		}
		requireSecurityHeaders(t, "429", rec.Header())
		h.clock.Advance(time.Duration(wait) * time.Second)
		if rec := h.serveFrom(ip, "POST", "/api/login", loginBody(wrongPassword)); rec.Code != http.StatusUnauthorized {
			t.Fatalf("status after waiting %ds = %d, want 401", wait, rec.Code)
		}
	}
}

func TestRetryAfterIsCappedAndForgotten(t *testing.T) {
	h := newHarness(t)
	limits := defaultLoginLimit()
	const ip = "192.0.2.11"
	for range 40 {
		h.serveFrom(ip, "POST", "/api/login", loginBody(wrongPassword))
		h.clock.Advance(limits.MaxDelay)
	}
	h.serveFrom(ip, "POST", "/api/login", loginBody(wrongPassword))
	rec := h.serveFrom(ip, "POST", "/api/login", loginBody(wrongPassword))
	wantCap := strconv.Itoa(int(limits.MaxDelay.Seconds()))
	if got := rec.Header().Get("Retry-After"); rec.Code != http.StatusTooManyRequests || got != wantCap {
		t.Fatalf("status = %d, Retry-After = %q, want 429 and %s", rec.Code, got, wantCap)
	}
	h.clock.Advance(limits.ForgetAfter)
	for i := range limits.Free {
		if rec := h.serveFrom(ip, "POST", "/api/login", loginBody(wrongPassword)); rec.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d after quiet period = %d, want 401", i+1, rec.Code)
		}
	}
}

func TestBlockedClientCannotLogInEvenWithCorrectPassword(t *testing.T) {
	h := newHarness(t)
	const ip = "192.0.2.12"
	for range defaultLoginLimit().Free {
		h.serveFrom(ip, "POST", "/api/login", loginBody(wrongPassword))
	}
	rec := h.serveFrom(ip, "POST", "/api/login", loginBody(testPassword))
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
	if got := rec.Header().Values("Set-Cookie"); len(got) != 0 {
		t.Fatalf("blocked login set a cookie: %v", got)
	}
}

func TestSuccessfulLoginClearsFailures(t *testing.T) {
	h := newHarness(t)
	const ip = "192.0.2.13"
	free := defaultLoginLimit().Free
	for range free - 1 {
		h.serveFrom(ip, "POST", "/api/login", loginBody(wrongPassword))
	}
	if rec := h.serveFrom(ip, "POST", "/api/login", loginBody(testPassword)); rec.Code != http.StatusNoContent {
		t.Fatalf("login = %d, want 204", rec.Code)
	}
	for i := range free {
		if rec := h.serveFrom(ip, "POST", "/api/login", loginBody(wrongPassword)); rec.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d after success = %d, want 401", i+1, rec.Code)
		}
	}
}

func TestRateLimitIsPerClient(t *testing.T) {
	h := newHarness(t)
	for range defaultLoginLimit().Free + 1 {
		h.serveFrom("192.0.2.20", "POST", "/api/login", loginBody(wrongPassword))
	}
	if rec := h.serveFrom("192.0.2.20", "POST", "/api/login", loginBody(testPassword)); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("blocked client = %d, want 429", rec.Code)
	}
	if rec := h.serveFrom("192.0.2.21", "POST", "/api/login", loginBody(testPassword)); rec.Code != http.StatusNoContent {
		t.Fatalf("other client = %d, want 204", rec.Code)
	}
}

func TestForwardingHeadersCannotEscapeTheRateLimit(t *testing.T) {
	h := newHarness(t)
	const ip = "192.0.2.30"
	for range defaultLoginLimit().Free {
		h.serveFrom(ip, "POST", "/api/login", loginBody(wrongPassword))
	}
	for i, header := range []string{"X-Forwarded-For", "X-Real-IP", "Forwarded", "CF-Connecting-IP", "True-Client-IP"} {
		rec := h.serveFrom(ip, "POST", "/api/login", loginBody(wrongPassword),
			withHeader(header, "198.51.100."+strconv.Itoa(i+1)))
		if rec.Code != http.StatusTooManyRequests {
			t.Errorf("%s bypassed the limit: status %d", header, rec.Code)
		}
	}
}

func TestIPv6SubnetSharesALimit(t *testing.T) {
	h := newHarness(t)
	for i := range defaultLoginLimit().Free {
		h.serveFrom("2001:db8:1:2::"+strconv.Itoa(i+1), "POST", "/api/login", loginBody(wrongPassword))
	}
	if rec := h.serveFrom("2001:db8:1:2:ffff::1", "POST", "/api/login", loginBody(wrongPassword)); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("same /64 = %d, want 429", rec.Code)
	}
	if rec := h.serveFrom("2001:db8:1:3::1", "POST", "/api/login", loginBody(wrongPassword)); rec.Code != http.StatusUnauthorized {
		t.Fatalf("different /64 = %d, want 401", rec.Code)
	}
}

func TestClientKeyNormalizes(t *testing.T) {
	for remote, want := range map[string]string{
		"192.0.2.1:1234":          "192.0.2.1",
		"[::ffff:192.0.2.1]:1234": "192.0.2.1",
		"[2001:db8:1:2:3::]:1":    "2001:db8:1:2::/64",
		"[fe80::1%eth0]:1":        "fe80::/64",
		"garbage":                 "unknown",
		"":                        "unknown",
	} {
		r, err := http.NewRequest("GET", "http://test.invalid/", nil)
		if err != nil {
			t.Fatal(err)
		}
		r.RemoteAddr = remote
		if got := clientKey(r); got != want {
			t.Errorf("clientKey(%q) = %q, want %q", remote, got, want)
		}
	}
}

func TestConcurrentGuessesCannotOutrunTheLimit(t *testing.T) {
	h := newHarness(t)
	free := defaultLoginLimit().Free
	var refused, rejected atomic.Int64
	var wg sync.WaitGroup
	for range 100 {
		wg.Go(func() {
			rec := h.serveFrom("192.0.2.40", "POST", "/api/login", loginBody(wrongPassword))
			switch rec.Code {
			case http.StatusUnauthorized:
				rejected.Add(1)
			case http.StatusTooManyRequests:
				refused.Add(1)
			}
		})
	}
	wg.Wait()
	if rejected.Load() != int64(free) || refused.Load() != int64(100-free) {
		t.Fatalf("checked %d guesses and refused %d, want %d and %d", rejected.Load(), refused.Load(), free, 100-free)
	}
}

func TestLoginLimitMemoryIsBounded(t *testing.T) {
	h := newHarness(t, func(o *Options) {
		o.LoginLimit = ratelimit.Options{MaxKeys: 50, Free: 2, BaseDelay: time.Second, MaxDelay: time.Minute, ForgetAfter: time.Hour}
	})
	for i := range 300 {
		h.serveFrom("10.0."+strconv.Itoa(i/250)+"."+strconv.Itoa(i%250+1), "POST", "/api/login", loginBody(wrongPassword))
	}
	if got := h.srv.loginLimit.Len(); got > 50 {
		t.Fatalf("limiter holds %d keys, want at most 50", got)
	}
}
