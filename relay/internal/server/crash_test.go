package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"webgeneralsonline/relay/internal/ratelimit"
)

const validReport = `{"buildHash":"abc1234","phase":"match","kind":"abort","message":"synthetic","stack":"","log":["a"]}`

var crashNamePattern = regexp.MustCompile(`^crash-\d{8}T\d{6}Z-[0-9a-f]{32}\.json$`)

// paddedReport builds a valid JSON object of exactly size bytes.
func paddedReport(t *testing.T, size int) string {
	t.Helper()
	const prefix, suffix = `{"message":"`, `"}`
	report := prefix + strings.Repeat("a", size-len(prefix)-len(suffix)) + suffix
	if len(report) != size || !json.Valid([]byte(report)) {
		t.Fatal("bad padded report")
	}
	return report
}

func unlimitedCrashes(o *Options) {
	o.CrashLimit = ratelimit.Options{MaxKeys: 10, Free: 1000, BaseDelay: time.Second, MaxDelay: time.Second, ForgetAfter: time.Second}
}

func TestCrashReportIsStored(t *testing.T) {
	h := newHarness(t)
	cookie := h.login()
	r := h.do("POST", "/api/crash", validReport, withCookie(cookie))
	if r.status != http.StatusNoContent {
		t.Fatalf("status = %d, body %s", r.status, r.body)
	}
	files := crashFiles(t, h.crashDir)
	if len(files) != 1 {
		t.Fatalf("files = %v, want 1", files)
	}
	if !crashNamePattern.MatchString(files[0]) {
		t.Errorf("unsafe or unexpected file name %q", files[0])
	}
	if !strings.Contains(files[0], "20261103T120000Z") {
		t.Errorf("name %q does not carry the UTC time", files[0])
	}
	stored, err := os.ReadFile(filepath.Join(h.crashDir, files[0]))
	if err != nil {
		t.Fatal(err)
	}
	if string(stored) != validReport {
		t.Errorf("stored = %q", stored)
	}
}

func TestCrashFilePermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permission bits do not apply on Windows")
	}
	h := newHarness(t)
	h.do("POST", "/api/crash", validReport, withCookie(h.login()))
	info, err := os.Stat(filepath.Join(h.crashDir, crashFiles(t, h.crashDir)[0]))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm&0o077 != 0 {
		t.Errorf("mode = %o, want no group or other access", perm)
	}
}

func TestEachReportGetsItsOwnFile(t *testing.T) {
	h := newHarness(t)
	cookie := h.login()
	for range 5 {
		if r := h.do("POST", "/api/crash", validReport, withCookie(cookie)); r.status != http.StatusNoContent {
			t.Fatalf("status = %d", r.status)
		}
	}
	files := crashFiles(t, h.crashDir)
	if len(files) != 5 {
		t.Fatalf("files = %v, want 5", files)
	}
	for _, name := range files {
		if !crashNamePattern.MatchString(name) {
			t.Errorf("leftover or unsafe file %q", name)
		}
	}
}

func TestCrashRejectsInvalidJSON(t *testing.T) {
	h := newHarness(t, unlimitedCrashes)
	cookie := h.login()
	for name, body := range map[string]string{
		"empty":         "",
		"text":          "not json",
		"truncated":     `{"message":"abc`,
		"trailing data": validReport + " extra",
		"two objects":   validReport + validReport,
		"array":         `[1,2,3]`,
		"string":        `"text"`,
		"number":        `42`,
		"null":          `null`,
		"bom":           "\xef\xbb\xbf" + validReport,
	} {
		if r := h.do("POST", "/api/crash", body, withCookie(cookie)); r.status != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", name, r.status)
		}
	}
	if files := crashFiles(t, h.crashDir); len(files) != 0 {
		t.Errorf("rejected reports were stored: %v", files)
	}
}

func TestCrashSizeLimit(t *testing.T) {
	h := newHarness(t, unlimitedCrashes)
	cookie := h.login()
	if r := h.do("POST", "/api/crash", paddedReport(t, 256*1024), withCookie(cookie)); r.status != http.StatusNoContent {
		t.Fatalf("exactly 256 KB: status = %d, want 204", r.status)
	}
	if files := crashFiles(t, h.crashDir); len(files) != 1 {
		t.Fatalf("files = %v, want 1", files)
	}
	r := h.do("POST", "/api/crash", paddedReport(t, 256*1024+1), withCookie(cookie))
	if r.status != http.StatusRequestEntityTooLarge {
		t.Fatalf("256 KB + 1: status = %d, want 413", r.status)
	}
	requireSecurityHeaders(t, "413", r.header)
	// Direct call: the server stops reading long before 2 MiB, and over a real
	// socket the client could see a reset instead of the response.
	if rec := h.serveFrom("192.0.2.63", "POST", "/api/crash", paddedReport(t, 1<<21), withCookie(cookie)); rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("2 MiB: status = %d, want 413", rec.Code)
	}
	if files := crashFiles(t, h.crashDir); len(files) != 1 {
		t.Errorf("oversized reports were stored: %v", files)
	}
}

func TestCrashPerClientLimit(t *testing.T) {
	h := newHarness(t, func(o *Options) {
		o.CrashLimit = ratelimit.Options{MaxKeys: 10, Free: 3, BaseDelay: time.Minute, MaxDelay: time.Hour, ForgetAfter: time.Hour}
	})
	cookie := h.login()
	const ip, otherIP = "192.0.2.60", "192.0.2.61"
	for i := range 3 {
		if rec := h.serveFrom(ip, "POST", "/api/crash", validReport, withCookie(cookie)); rec.Code != http.StatusNoContent {
			t.Fatalf("report %d = %d, want 204", i+1, rec.Code)
		}
	}
	rec := h.serveFrom(ip, "POST", "/api/crash", validReport, withCookie(cookie))
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
	if got := rec.Header().Get("Retry-After"); got != strconv.Itoa(60) {
		t.Errorf("Retry-After = %q, want 60", got)
	}
	if files := crashFiles(t, h.crashDir); len(files) != 3 {
		t.Errorf("files = %d, want 3", len(files))
	}
	if rec := h.serveFrom(otherIP, "POST", "/api/crash", validReport, withCookie(cookie)); rec.Code != http.StatusNoContent {
		t.Errorf("other client = %d, want 204", rec.Code)
	}
	h.clock.Advance(time.Minute)
	if rec := h.serveFrom(ip, "POST", "/api/crash", validReport, withCookie(cookie)); rec.Code != http.StatusNoContent {
		t.Errorf("after waiting = %d, want 204", rec.Code)
	}
}

func TestInvalidReportsUseTheBudgetToo(t *testing.T) {
	h := newHarness(t, func(o *Options) {
		o.CrashLimit = ratelimit.Options{MaxKeys: 10, Free: 2, BaseDelay: time.Minute, MaxDelay: time.Hour, ForgetAfter: time.Hour}
	})
	cookie := h.login()
	for range 2 {
		h.serveFrom("192.0.2.62", "POST", "/api/crash", "not json", withCookie(cookie))
	}
	if rec := h.serveFrom("192.0.2.62", "POST", "/api/crash", validReport, withCookie(cookie)); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
}

func TestCrashStoreCap(t *testing.T) {
	size := len(validReport)
	h := newHarness(t, unlimitedCrashes, func(o *Options) { o.CrashMaxStored = int64(size * 2) })
	cookie := h.login()
	for i := range 2 {
		if r := h.do("POST", "/api/crash", validReport, withCookie(cookie)); r.status != http.StatusNoContent {
			t.Fatalf("report %d = %d, want 204", i+1, r.status)
		}
	}
	r := h.do("POST", "/api/crash", validReport, withCookie(cookie))
	if r.status != http.StatusInsufficientStorage {
		t.Fatalf("over the cap: status = %d, want 507", r.status)
	}
	requireSecurityHeaders(t, "507", r.header)
	if files := crashFiles(t, h.crashDir); len(files) != 2 {
		t.Errorf("files = %d, want the first 2 kept", len(files))
	}
	if !strings.Contains(h.logs.String(), "crash store is full") {
		t.Error("a full store should be logged")
	}
}

func TestCrashCapCountsExistingFiles(t *testing.T) {
	crashDir := filepath.Join(t.TempDir(), "existing")
	writeFile(t, filepath.Join(crashDir, "crash-old.json"), strings.Repeat("x", 100))
	h := newHarness(t, unlimitedCrashes, func(o *Options) {
		o.CrashDir = crashDir
		o.CrashMaxStored = 100 + int64(len(validReport)) - 1
	})
	h.crashDir = crashDir
	r := h.do("POST", "/api/crash", validReport, withCookie(h.login()))
	if r.status != http.StatusInsufficientStorage {
		t.Fatalf("status = %d, want 507 since old files fill the cap", r.status)
	}
	if files := crashFiles(t, crashDir); len(files) != 1 {
		t.Errorf("files = %v", files)
	}
}

func TestCrashStoreReleasesBytesWhenWriteFails(t *testing.T) {
	dir := t.TempDir()
	store, err := newCrashStore(dir, 1000, newFakeClock().Now)
	if err != nil {
		t.Fatal(err)
	}
	store.dir = filepath.Join(dir, "removed-directory")
	if _, err := store.save([]byte(validReport)); err == nil {
		t.Fatal("want a write error")
	}
	if store.used != 0 {
		t.Fatalf("used = %d after a failed write, want 0", store.used)
	}
}

func TestCrashFileNameIgnoresClientInput(t *testing.T) {
	h := newHarness(t)
	cookie := h.login()
	hostile := `{"buildHash":"../../evil","phase":"..\\..\\evil","kind":"evil.json","message":"x"}`
	r := h.do("POST", "/api/crash", hostile, withCookie(cookie),
		withHeader("X-File-Name", "../../evil.json"),
		withHeader("Content-Disposition", `attachment; filename="../../evil.json"`))
	if r.status != http.StatusNoContent {
		t.Fatalf("status = %d", r.status)
	}
	files := crashFiles(t, h.crashDir)
	if len(files) != 1 || !crashNamePattern.MatchString(files[0]) {
		t.Fatalf("files = %v", files)
	}
	if _, err := os.Stat(filepath.Join(h.base, "evil.json")); err == nil {
		t.Fatal("a report escaped the crash directory")
	}
}

func TestCrashDirectoryIsCreated(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "deep", "er", "crash")
	h := newHarness(t, func(o *Options) { o.CrashDir = dir })
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		t.Fatalf("crash directory not created: %v", err)
	}
	if r := h.do("POST", "/api/crash", validReport, withCookie(h.login())); r.status != http.StatusNoContent {
		t.Fatalf("status = %d", r.status)
	}
}

func TestCrashMethods(t *testing.T) {
	h := newHarness(t)
	cookie := h.login()
	r := h.do("GET", "/api/crash", "", withCookie(cookie))
	if r.status != http.StatusMethodNotAllowed || r.header.Get("Allow") != "POST" {
		t.Fatalf("status = %d, Allow = %q", r.status, r.header.Get("Allow"))
	}
}
