package server

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// patterned returns n bytes in which every small slice is distinctive, so a wrong
// range shows up as a mismatch.
func patterned(n int) []byte {
	data := make([]byte, n)
	for i := range data {
		data[i] = byte(i % 251)
	}
	return data
}

// assetHarness has a synthetic game file and a signed-in cookie.
func assetHarness(t *testing.T) (h *harness, cookie *http.Cookie, content []byte) {
	t.Helper()
	h = newHarness(t)
	content = patterned(10_000)
	writeFile(t, filepath.Join(h.assetDir, "Data", "INI", "Test.big"), string(content))
	return h, h.login(), content
}

const assetPath = "/assets/files/Data/INI/Test.big"

func TestManifest(t *testing.T) {
	h := newHarness(t)
	const manifest = `{"schema":1,"version":"test","files":[]}`
	writeFile(t, filepath.Join(h.assetDir, "manifest.json"), manifest)
	r := h.do("GET", "/assets/manifest.json", "", withCookie(h.login()))
	if r.status != http.StatusOK || string(r.body) != manifest {
		t.Fatalf("status = %d, body = %q", r.status, r.body)
	}
	if got := r.header.Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q", got)
	}
	if got := r.header.Get("Cache-Control"); got != cacheManifest {
		t.Errorf("Cache-Control = %q", got)
	}
	if r.header.Get("ETag") == "" {
		t.Error("manifest has no ETag")
	}
}

func TestManifestMissingIs404(t *testing.T) {
	h := newHarness(t)
	if r := h.do("GET", "/assets/manifest.json", "", withCookie(h.login())); r.status != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", r.status)
	}
}

func TestMissingRootsAre404(t *testing.T) {
	h := newHarness(t)
	cookie := h.login()
	for _, dir := range []string{h.assetDir, h.engineDir, h.webDir} {
		if err := os.RemoveAll(dir); err != nil {
			t.Fatal(err)
		}
	}
	for _, target := range []string{"/assets/manifest.json", "/assets/files/x.big", "/engine/x.wasm", "/", "/shell/x.js"} {
		if r := h.do("GET", target, "", withCookie(cookie)); r.status != http.StatusNotFound {
			t.Errorf("GET %s = %d, want 404", target, r.status)
		}
	}
}

func TestGameFileWholeAndHeaders(t *testing.T) {
	h, cookie, content := assetHarness(t)
	r := h.do("GET", assetPath, "", withCookie(cookie))
	if r.status != http.StatusOK || !bytes.Equal(r.body, content) {
		t.Fatalf("status = %d, %d bytes", r.status, len(r.body))
	}
	for name, want := range map[string]string{
		"Content-Type":   contentTypeBinary,
		"Accept-Ranges":  "bytes",
		"Cache-Control":  cacheGameFile,
		"Content-Length": strconv.Itoa(len(content)),
	} {
		if got := r.header.Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
	etag := r.header.Get("ETag")
	if etag == "" || strings.HasPrefix(etag, "W/") {
		t.Errorf("ETag = %q, want a strong validator", etag)
	}
	if r.header.Get("Last-Modified") == "" {
		t.Error("no Last-Modified")
	}
}

func TestGameFilesAreNeverCompressed(t *testing.T) {
	h, cookie, content := assetHarness(t)
	// Sidecars beside a game file must be ignored too.
	writeFile(t, filepath.Join(h.assetDir, "Data", "INI", "Test.big.gz"), "not this")
	writeFile(t, filepath.Join(h.assetDir, "Data", "INI", "Test.big.br"), "not this")
	r := h.do("GET", assetPath, "", withCookie(cookie), withHeader("Accept-Encoding", "gzip, br, deflate, *"))
	if got := r.header.Get("Content-Encoding"); got != "" {
		t.Errorf("Content-Encoding = %q", got)
	}
	if !bytes.Equal(r.body, content) {
		t.Error("body is not the exact file")
	}
}

// clientURLPath encodes a manifest path the way web/src/paths.ts does: every
// segment on its own, keeping the slashes.
func clientURLPath(manifestPath string) string {
	segments := strings.Split(manifestPath, "/")
	for i, segment := range segments {
		segments[i] = url.PathEscape(segment)
	}
	return "/assets/files/" + strings.Join(segments, "/")
}

// The manifest paths docs/WEB_CONTRACT.md allows: the Zero Hour root, base
// archives under ZH_Generals/, and those of a separate install under Generals/.
// Each one is requested with an encoding-happy client and sidecars beside it,
// since the contract says game files are never content-encoded.
func TestManifestPathLayoutsAreServedUnencoded(t *testing.T) {
	h := newHarness(t)
	cookie := h.login()
	content := patterned(4_000)
	for _, manifestPath := range []string{
		"INIZH.big",
		"500_900_CommunityPatch_CoreINI.big",
		"ZH_Generals/INI.big",
		"Generals/INI.big",
		"ZH_Generals/Sub Folder/Mixed Case.BIG",
		"Generals/Data/Audio & Speech (v1.08).big",
	} {
		t.Run(manifestPath, func(t *testing.T) {
			onDisk := filepath.Join(h.assetDir, filepath.FromSlash(manifestPath))
			writeFile(t, onDisk, string(content))
			writeFile(t, onDisk+".gz", "NOT THE GAME FILE")
			writeFile(t, onDisk+".br", "NOT THE GAME FILE")
			target := clientURLPath(manifestPath)
			acceptAll := withHeader("Accept-Encoding", "br, gzip, deflate, *")

			whole := h.do("GET", target, "", withCookie(cookie), acceptAll)
			if whole.status != http.StatusOK || !bytes.Equal(whole.body, content) {
				t.Fatalf("whole file: status = %d, %d bytes", whole.status, len(whole.body))
			}
			if got := whole.header.Get("Content-Encoding"); got != "" {
				t.Errorf("whole file: Content-Encoding = %q", got)
			}

			// The exact request the download worker sends to resume.
			part := h.do("GET", target, "", withCookie(cookie), acceptAll,
				withHeader("Range", "bytes=1000-"), withHeader("If-Range", whole.header.Get("ETag")))
			if part.status != http.StatusPartialContent || !bytes.Equal(part.body, content[1000:]) {
				t.Fatalf("resume: status = %d, %d bytes", part.status, len(part.body))
			}
			if got := part.header.Get("Content-Encoding"); got != "" {
				t.Errorf("resume: Content-Encoding = %q", got)
			}
			if got, want := part.header.Get("Content-Range"), "bytes 1000-3999/4000"; got != want {
				t.Errorf("resume: Content-Range = %q, want %q", got, want)
			}
		})
	}
}

func TestRange(t *testing.T) {
	h, cookie, content := assetHarness(t)
	size := len(content)
	for _, tc := range []struct {
		name         string
		header       string
		start, end   int // inclusive
		contentRange string
	}{
		{"first bytes", "bytes=0-9", 0, 9, fmt.Sprintf("bytes 0-9/%d", size)},
		{"middle", "bytes=100-199", 100, 199, fmt.Sprintf("bytes 100-199/%d", size)},
		{"open ended", fmt.Sprintf("bytes=%d-", size-5), size - 5, size - 1, fmt.Sprintf("bytes %d-%d/%d", size-5, size-1, size)},
		{"suffix", "bytes=-5", size - 5, size - 1, fmt.Sprintf("bytes %d-%d/%d", size-5, size-1, size)},
		{"single byte", "bytes=7-7", 7, 7, fmt.Sprintf("bytes 7-7/%d", size)},
		{"end past file", fmt.Sprintf("bytes=%d-%d", size-2, size+100), size - 2, size - 1, fmt.Sprintf("bytes %d-%d/%d", size-2, size-1, size)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := h.do("GET", assetPath, "", withCookie(cookie), withHeader("Range", tc.header))
			if r.status != http.StatusPartialContent {
				t.Fatalf("status = %d, want 206", r.status)
			}
			if got := r.header.Get("Content-Range"); got != tc.contentRange {
				t.Errorf("Content-Range = %q, want %q", got, tc.contentRange)
			}
			want := content[tc.start : tc.end+1]
			if !bytes.Equal(r.body, want) {
				t.Errorf("body has %d bytes, wrong range content", len(r.body))
			}
			if got := r.header.Get("Content-Length"); got != strconv.Itoa(len(want)) {
				t.Errorf("Content-Length = %q, want %d", got, len(want))
			}
			if r.header.Get("ETag") == "" {
				t.Error("206 lost the ETag")
			}
			requireSecurityHeaders(t, tc.name, r.header)
		})
	}
}

func TestRangeUnsatisfiable(t *testing.T) {
	h, cookie, content := assetHarness(t)
	r := h.do("GET", assetPath, "", withCookie(cookie), withHeader("Range", fmt.Sprintf("bytes=%d-", len(content))))
	if r.status != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("status = %d, want 416", r.status)
	}
	if got := r.header.Get("Content-Range"); got != fmt.Sprintf("bytes */%d", len(content)) {
		t.Errorf("Content-Range = %q", got)
	}
}

func TestRangeMultipart(t *testing.T) {
	h, cookie, content := assetHarness(t)
	r := h.do("GET", assetPath, "", withCookie(cookie), withHeader("Range", "bytes=0-1,4-5"))
	if r.status != http.StatusPartialContent {
		t.Fatalf("status = %d, want 206", r.status)
	}
	mediaType, params, err := mime.ParseMediaType(r.header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/byteranges" {
		t.Fatalf("Content-Type = %q, %v", r.header.Get("Content-Type"), err)
	}
	reader := multipart.NewReader(bytes.NewReader(r.body), params["boundary"])
	for _, want := range [][]byte{content[0:2], content[4:6]} {
		part, err := reader.NextPart()
		if err != nil {
			t.Fatal(err)
		}
		got, err := io.ReadAll(part)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, want) {
			t.Errorf("part = %v, want %v", got, want)
		}
	}
}

func TestIfRange(t *testing.T) {
	h, cookie, content := assetHarness(t)
	first := h.do("GET", assetPath, "", withCookie(cookie))
	etag := first.header.Get("ETag")
	lastModified := first.header.Get("Last-Modified")
	if etag == "" || lastModified == "" {
		t.Fatalf("validators missing: %v", first.header)
	}

	for _, tc := range []struct {
		name    string
		ifRange string
		partial bool
	}{
		{"matching etag", etag, true},
		{"matching date", lastModified, true},
		{"stale etag", `"0-stale"`, false},
		{"weak form of the etag", "W/" + etag, false},
		{"older date", time.Unix(1000, 0).UTC().Format(http.TimeFormat), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := h.do("GET", assetPath, "", withCookie(cookie),
				withHeader("Range", "bytes=10-19"), withHeader("If-Range", tc.ifRange))
			if tc.partial {
				if r.status != http.StatusPartialContent || !bytes.Equal(r.body, content[10:20]) {
					t.Fatalf("status = %d, %d bytes, want the 10-byte range", r.status, len(r.body))
				}
				return
			}
			if r.status != http.StatusOK || !bytes.Equal(r.body, content) {
				t.Fatalf("status = %d, %d bytes, want the whole file", r.status, len(r.body))
			}
			if r.header.Get("Content-Range") != "" {
				t.Error("full response has a Content-Range")
			}
		})
	}
}

func TestIfRangeAfterFileChangesRestartsDownload(t *testing.T) {
	h, cookie, _ := assetHarness(t)
	path := filepath.Join(h.assetDir, "Data", "INI", "Test.big")
	oldETag := h.do("GET", assetPath, "", withCookie(cookie)).header.Get("ETag")

	replacement := patterned(10_000)
	replacement[0] = 0xFF
	if err := os.WriteFile(path, replacement, 0o644); err != nil {
		t.Fatal(err)
	}
	later := time.Now().Add(time.Hour)
	if err := os.Chtimes(path, later, later); err != nil {
		t.Fatal(err)
	}

	r := h.do("GET", assetPath, "", withCookie(cookie),
		withHeader("Range", "bytes=0-9"), withHeader("If-Range", oldETag))
	if r.status != http.StatusOK || !bytes.Equal(r.body, replacement) {
		t.Fatalf("status = %d, %d bytes, want the whole new file", r.status, len(r.body))
	}
	if r.header.Get("ETag") == oldETag {
		t.Error("ETag did not change with the file")
	}
}

func TestConditionalGetAndHead(t *testing.T) {
	h, cookie, content := assetHarness(t)
	etag := h.do("GET", assetPath, "", withCookie(cookie)).header.Get("ETag")

	r := h.do("GET", assetPath, "", withCookie(cookie), withHeader("If-None-Match", etag))
	if r.status != http.StatusNotModified || len(r.body) != 0 {
		t.Errorf("If-None-Match: status = %d, %d bytes", r.status, len(r.body))
	}
	r = h.do("GET", assetPath, "", withCookie(cookie), withHeader("If-Match", `"other"`))
	if r.status != http.StatusPreconditionFailed {
		t.Errorf("If-Match: status = %d, want 412", r.status)
	}
	r = h.do("HEAD", assetPath, "", withCookie(cookie))
	if r.status != http.StatusOK || len(r.body) != 0 || r.header.Get("Content-Length") != strconv.Itoa(len(content)) {
		t.Errorf("HEAD: status = %d, %d bytes, Content-Length %q", r.status, len(r.body), r.header.Get("Content-Length"))
	}
	r = h.do("POST", assetPath, "", withCookie(cookie))
	if r.status != http.StatusMethodNotAllowed {
		t.Errorf("POST: status = %d, want 405", r.status)
	}
}

func TestAssetFileEdgeCases(t *testing.T) {
	h, cookie, _ := assetHarness(t)
	writeFile(t, filepath.Join(h.assetDir, "Maps", "Alpine Assault", "map.ini"), "spaces")
	writeFile(t, filepath.Join(h.assetDir, "Data", "CaseName.BIG"), "case")
	for target, wantStatus := range map[string]int{
		"/assets/files/Maps/Alpine%20Assault/map.ini": 200,
		"/assets/files/Data/CaseName.BIG":             200,
		"/assets/files/Data%2FCaseName.BIG":           200, // one client might encode the whole path
		"/assets/files/Data":                          404, // a directory
		"/assets/files/Data/":                         404,
		"/assets/files/":                              404,
		"/assets/files":                               404,
		"/assets/":                                    404,
		"/assets":                                     404,
		"/assets/other":                               404,
		"/engine":                                     404,
		"/engine/":                                    404,
	} {
		if r := h.do("GET", target, "", withCookie(cookie)); r.status != wantStatus {
			t.Errorf("GET %s = %d, want %d", target, r.status, wantStatus)
		}
	}
}

// traversalTargets returns hostile paths that aim at the marker file beside the
// roots. Several would reach it if decoded or normalized carelessly.
func traversalTargets(h *harness) []string {
	escaped := filepath.ToSlash(filepath.Join(h.base, secretName))
	return []string{
		"../" + secretName,
		"..%2f" + secretName,
		"..%2F" + secretName,
		"%2e%2e/" + secretName,
		"%2E%2E/" + secretName,
		"%2e%2e%2f" + secretName,
		"%2E%2E%2F" + secretName,
		".%2e/" + secretName,
		"%2e./" + secretName,
		`..\` + secretName,
		"..%5c" + secretName,
		"..%5C" + secretName,
		"%2e%2e%5c" + secretName,
		`\..\` + secretName,
		"%5c..%5c" + secretName,
		"sub/../../" + secretName,
		"sub/..%2f..%2f" + secretName,
		"sub%2f..%2f..%2f" + secretName,
		`sub\..\..\` + secretName,
		"./../" + secretName,
		"%252e%252e%252f" + secretName, // double encoded
		"..%252f" + secretName,
		"..%255c" + secretName,
		"..%c0%af" + secretName, // overlong UTF-8
		"..%c1%9c" + secretName,
		"%c0%ae%c0%ae/" + secretName,
		"..%00/" + secretName, // NUL
		secretName + "%00.big",
		"....//" + secretName,
		"..../" + secretName,
		"..;/" + secretName,
		"%ef%bc%8e%ef%bc%8e%ef%bc%8f" + secretName, // full-width forms
		"/" + escaped,
		escaped,
		url.PathEscape(escaped),
		url.PathEscape(filepath.Join(h.base, secretName)),
		"//" + escaped,
	}
}

func requireNoEscape(t *testing.T, label string, r *result) {
	t.Helper()
	if r.status == http.StatusOK || r.status == http.StatusPartialContent {
		t.Errorf("%s: status = %d", label, r.status)
	}
	if bytes.Contains(r.body, []byte(secretMarker)) {
		t.Errorf("%s: response contains the outside file", label)
	}
}

func TestTraversalIsBlocked(t *testing.T) {
	h := newHarness(t)
	writeFile(t, filepath.Join(h.webDir, "index.html"), "<title>gate</title>")
	cookie := h.login()
	for _, prefix := range []string{"/assets/files/", "/engine/", "/shell/"} {
		for _, target := range traversalTargets(h) {
			full := prefix + target
			r := h.raw("GET", full, cookie)
			requireNoEscape(t, full, r)
			if prefix == "/shell/" && bytes.Contains(r.body, []byte("gate")) {
				t.Errorf("%s: hostile path fell back to the gate page", full)
			}
		}
	}
}

func TestTraversalSurvivesHTTPClientToo(t *testing.T) {
	h := newHarness(t)
	cookie := h.login()
	for _, prefix := range []string{"/assets/files/", "/engine/", "/shell/"} {
		for _, target := range []string{"..%2f" + secretName, "%2e%2e%2f" + secretName, "..%5c" + secretName} {
			full := prefix + target
			requireNoEscape(t, full, h.do("GET", full, "", withCookie(cookie)))
		}
	}
}

func TestTraversalCannotReachProtectedRoutesWithoutCookie(t *testing.T) {
	h := newHarness(t)
	writeFile(t, filepath.Join(h.webDir, "index.html"), "<title>gate</title>")
	const content = "PROTECTED-MANIFEST-CONTENT"
	writeFile(t, filepath.Join(h.assetDir, "manifest.json"), content)
	writeFile(t, filepath.Join(h.engineDir, "game.wasm"), content)
	for _, target := range []string{
		"/shell/../assets/manifest.json",
		"/shell/..%2fassets%2fmanifest.json",
		"/shell/%2e%2e/assets/manifest.json",
		"/shell/..%5cassets%5cmanifest.json",
		"/x/../assets/manifest.json",
		"//assets/manifest.json",
		"/./assets/manifest.json",
		"/ASSETS/manifest.json",
		"/assets/files/../manifest.json",
		"/assets%2fmanifest.json",
		"/%61ssets/manifest.json",
		"/shell/../engine/game.wasm",
		"/engine/../engine/game.wasm",
	} {
		r := h.raw("GET", target, nil)
		if r.status == http.StatusOK {
			t.Errorf("%s: status 200 without a cookie", target)
		}
		if bytes.Contains(r.body, []byte(content)) {
			t.Errorf("%s: protected content served without a cookie", target)
		}
		requireSecurityHeaders(t, target, r.header)
	}
}

func TestDotfilesAndWindowsNamesAreRefused(t *testing.T) {
	h := newHarness(t)
	writeFile(t, filepath.Join(h.webDir, "index.html"), "<title>gate</title>")
	roots := map[string]string{"/assets/files/": h.assetDir, "/engine/": h.engineDir, "/shell/": h.webDir}
	for _, root := range roots {
		writeFile(t, filepath.Join(root, ".env"), "FAKE_DOTENV_CONTENT")
		writeFile(t, filepath.Join(root, ".git", "config"), "FAKE_DOTENV_CONTENT")
		writeFile(t, filepath.Join(root, "real.big"), "FAKE_DOTENV_CONTENT")
	}
	cookie := h.login()
	for prefix := range roots {
		for _, target := range []string{
			".env", ".git/config", "%2eenv", "real.big.", "real.big%20",
			"real.big::$DATA", "real.big:stream", "real.big%3a%3a$DATA",
			"NUL", "con", "COM1", "aux.txt", "CON/real.big",
		} {
			full := prefix + target
			r := h.raw("GET", full, cookie)
			if bytes.Contains(r.body, []byte("FAKE_DOTENV_CONTENT")) {
				t.Errorf("%s: served content", full)
			}
			if prefix != "/shell/" && r.status != http.StatusNotFound {
				t.Errorf("%s: status = %d, want 404", full, r.status)
			}
		}
	}
}

// linkHarness has a directory of synthetic files outside every root.
func linkHarness(t *testing.T) (*harness, *http.Cookie, string) {
	t.Helper()
	h := newHarness(t)
	outside := filepath.Join(h.base, "outside")
	writeFile(t, filepath.Join(outside, "linked.big"), secretMarker)
	return h, h.login(), outside
}

func TestSymlinksLeavingTheRootAreRefused(t *testing.T) {
	h, cookie, outside := linkHarness(t)
	roots := map[string]string{"/assets/files/": h.assetDir, "/engine/": h.engineDir, "/shell/": h.webDir}
	for prefix, root := range roots {
		for name, target := range map[string]string{
			"abs-file": filepath.Join(outside, "linked.big"),
			"abs-dir":  outside,
			"rel-file": filepath.Join("..", "outside", "linked.big"),
			"rel-dir":  filepath.Join("..", "outside"),
		} {
			if err := os.Symlink(target, filepath.Join(root, name)); err != nil {
				t.Skipf("cannot create symlinks here: %v", err)
			}
		}
		for _, target := range []string{"abs-file", "abs-dir/linked.big", "rel-file", "rel-dir/linked.big"} {
			full := prefix + target
			requireNoEscape(t, full, h.raw("GET", full, cookie))
		}
	}
}

func TestSymlinkInsideTheRootIsServed(t *testing.T) {
	h, cookie, _ := linkHarness(t)
	writeFile(t, filepath.Join(h.assetDir, "real.big"), "inside the root")
	if err := os.Symlink("real.big", filepath.Join(h.assetDir, "alias.big")); err != nil {
		t.Skipf("cannot create symlinks here: %v", err)
	}
	r := h.do("GET", "/assets/files/alias.big", "", withCookie(cookie))
	if r.status != http.StatusOK || string(r.body) != "inside the root" {
		t.Fatalf("status = %d, body = %q", r.status, r.body)
	}
}

// Junctions behave like directory symlinks on Windows and need no privilege, so
// this covers escapes even where the symlink tests have to skip.
func TestJunctionsLeavingTheRootAreRefused(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("junctions exist only on Windows")
	}
	h, cookie, outside := linkHarness(t)
	for prefix, root := range map[string]string{"/assets/files/": h.assetDir, "/engine/": h.engineDir, "/shell/": h.webDir} {
		link := filepath.Join(root, "junction")
		if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, outside).CombinedOutput(); err != nil {
			t.Fatalf("mklink /J: %v: %s", err, out)
		}
		// Prove the junction works, so the refusal below means something.
		if data, err := os.ReadFile(filepath.Join(link, "linked.big")); err != nil || string(data) != secretMarker {
			t.Fatalf("junction not usable through the OS: %q, %v", data, err)
		}
		full := prefix + "junction/linked.big"
		requireNoEscape(t, full, h.raw("GET", full, cookie))
	}
	if !strings.Contains(h.logs.String(), "file open refused") {
		t.Error("the refused link should leave a log line for the operator")
	}
}

// engineHarness has a plain file and both sidecars, each with distinct bytes.
func engineHarness(t *testing.T) (*harness, *http.Cookie) {
	t.Helper()
	h := newHarness(t)
	writeFile(t, filepath.Join(h.engineDir, "game.wasm"), "PLAIN-WASM-BYTES")
	writeFile(t, filepath.Join(h.engineDir, "game.wasm.br"), "BROTLI-BYTES")
	writeFile(t, filepath.Join(h.engineDir, "game.wasm.gz"), "GZIP-SIDECAR")
	return h, h.login()
}

func TestPrecompressedNegotiation(t *testing.T) {
	h, cookie := engineHarness(t)
	for _, tc := range []struct {
		accept   string
		encoding string
		body     string
	}{
		{"", "", "PLAIN-WASM-BYTES"},
		{"identity", "", "PLAIN-WASM-BYTES"},
		{"br", "br", "BROTLI-BYTES"},
		{"gzip", "gzip", "GZIP-SIDECAR"},
		{"x-gzip", "gzip", "GZIP-SIDECAR"},
		{"gzip, deflate, br", "br", "BROTLI-BYTES"},
		{"GZIP, BR", "br", "BROTLI-BYTES"},
		{"br;q=0, gzip", "gzip", "GZIP-SIDECAR"},
		{"br;q=0.0, gzip;q=0.0", "", "PLAIN-WASM-BYTES"},
		{"gzip;q=1.0, br;q=0.5", "gzip", "GZIP-SIDECAR"},
		{"gzip;q=0.5, br;q=0.5", "br", "BROTLI-BYTES"},
		{"*", "br", "BROTLI-BYTES"},
		{"*;q=0", "", "PLAIN-WASM-BYTES"},
		{"br;q=0, *", "gzip", "GZIP-SIDECAR"},
		{"gzip;q=nonsense", "", "PLAIN-WASM-BYTES"},
		{"deflate, zstd", "", "PLAIN-WASM-BYTES"},
	} {
		t.Run("accept "+tc.accept, func(t *testing.T) {
			var opts []reqOption
			opts = append(opts, withCookie(cookie))
			if tc.accept != "" {
				opts = append(opts, withHeader("Accept-Encoding", tc.accept))
			}
			r := h.do("GET", "/engine/game.wasm", "", opts...)
			if r.status != http.StatusOK || string(r.body) != tc.body {
				t.Fatalf("status = %d, body = %q, want %q", r.status, r.body, tc.body)
			}
			if got := r.header.Get("Content-Encoding"); got != tc.encoding {
				t.Errorf("Content-Encoding = %q, want %q", got, tc.encoding)
			}
			if got := r.header.Get("Content-Type"); got != "application/wasm" {
				t.Errorf("Content-Type = %q", got)
			}
			if got := r.header.Get("Vary"); got != "Accept-Encoding" {
				t.Errorf("Vary = %q", got)
			}
			if got := r.header.Get("Content-Length"); got != strconv.Itoa(len(tc.body)) {
				t.Errorf("Content-Length = %q, want %d", got, len(tc.body))
			}
			requireSecurityHeaders(t, tc.accept, r.header)
		})
	}
}

func TestFallsBackWhenSidecarsAreAbsent(t *testing.T) {
	h := newHarness(t)
	writeFile(t, filepath.Join(h.engineDir, "plain.js"), "PLAIN-JS")
	writeFile(t, filepath.Join(h.engineDir, "gz-only.js"), "PLAIN-JS-2")
	writeFile(t, filepath.Join(h.engineDir, "gz-only.js.gz"), "GZIP-JS-2")
	writeFile(t, filepath.Join(h.engineDir, "compressed-only.wasm.br"), "BROTLI-ONLY")
	cookie := h.login()

	r := h.do("GET", "/engine/plain.js", "", withCookie(cookie), withHeader("Accept-Encoding", "br, gzip"))
	if string(r.body) != "PLAIN-JS" || r.header.Get("Content-Encoding") != "" || r.header.Get("Vary") != "Accept-Encoding" {
		t.Errorf("plain: body %q, headers %v", r.body, r.header)
	}
	if got := r.header.Get("Content-Type"); got != "text/javascript; charset=utf-8" {
		t.Errorf("Content-Type = %q", got)
	}
	r = h.do("GET", "/engine/gz-only.js", "", withCookie(cookie), withHeader("Accept-Encoding", "br, gzip"))
	if string(r.body) != "GZIP-JS-2" || r.header.Get("Content-Encoding") != "gzip" {
		t.Errorf("gz-only: body %q, Content-Encoding %q", r.body, r.header.Get("Content-Encoding"))
	}
	r = h.do("GET", "/engine/compressed-only.wasm", "", withCookie(cookie), withHeader("Accept-Encoding", "br"))
	if string(r.body) != "BROTLI-ONLY" {
		t.Errorf("compressed-only with br: body %q", r.body)
	}
	r = h.do("GET", "/engine/compressed-only.wasm", "", withCookie(cookie))
	if r.status != http.StatusNotFound {
		t.Errorf("compressed-only without br: status = %d, want 404", r.status)
	}
	r = h.do("GET", "/engine/missing.wasm", "", withCookie(cookie), withHeader("Accept-Encoding", "br, gzip"))
	if r.status != http.StatusNotFound || r.header.Get("Content-Encoding") != "" {
		t.Errorf("missing: status = %d, Content-Encoding %q", r.status, r.header.Get("Content-Encoding"))
	}
}

func TestEachEncodingHasItsOwnETag(t *testing.T) {
	h, cookie := engineHarness(t)
	etags := map[string]bool{}
	for _, accept := range []string{"identity", "br", "gzip"} {
		r := h.do("GET", "/engine/game.wasm", "", withCookie(cookie), withHeader("Accept-Encoding", accept))
		etag := r.header.Get("ETag")
		if etag == "" || etags[etag] {
			t.Errorf("%s: ETag %q is empty or reused", accept, etag)
		}
		etags[etag] = true

		again := h.do("GET", "/engine/game.wasm", "", withCookie(cookie),
			withHeader("Accept-Encoding", accept), withHeader("If-None-Match", etag))
		if again.status != http.StatusNotModified {
			t.Errorf("%s: revalidation = %d, want 304", accept, again.status)
		}
		if got := again.header.Get("Vary"); got != "Accept-Encoding" {
			t.Errorf("%s: 304 has Vary = %q", accept, got)
		}
	}
}

func TestPrecompressedRangeUsesEncodedBytes(t *testing.T) {
	h, cookie := engineHarness(t)
	r := h.do("GET", "/engine/game.wasm", "", withCookie(cookie),
		withHeader("Accept-Encoding", "br"), withHeader("Range", "bytes=0-5"))
	if r.status != http.StatusPartialContent || string(r.body) != "BROTLI" {
		t.Fatalf("status = %d, body = %q", r.status, r.body)
	}
	if got := r.header.Get("Content-Encoding"); got != "br" {
		t.Errorf("Content-Encoding = %q", got)
	}
	if got := r.header.Get("Content-Range"); got != "bytes 0-5/12" {
		t.Errorf("Content-Range = %q", got)
	}
}

func TestPrecompressedHeadAnd416(t *testing.T) {
	h, cookie := engineHarness(t)
	r := h.do("HEAD", "/engine/game.wasm", "", withCookie(cookie), withHeader("Accept-Encoding", "br"))
	if r.status != http.StatusOK || r.header.Get("Content-Encoding") != "br" || r.header.Get("Content-Length") != "12" {
		t.Errorf("HEAD: status = %d, headers %v", r.status, r.header)
	}
	r = h.do("GET", "/engine/game.wasm", "", withCookie(cookie),
		withHeader("Accept-Encoding", "br"), withHeader("Range", "bytes=999-"))
	if r.status != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("status = %d, want 416", r.status)
	}
	if got := r.header.Get("Content-Encoding"); got != "" {
		t.Errorf("error response keeps Content-Encoding %q", got)
	}
}

// With the default transport, Go decompresses gzip itself, so this checks the
// bytes survive a real client's decoding.
func TestRealGzipSidecarDecodes(t *testing.T) {
	h := newHarness(t)
	const original = "the original engine bytes"
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write([]byte(original)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(h.engineDir, "real.js"), "unused")
	writeFile(t, filepath.Join(h.engineDir, "real.js.gz"), compressed.String())
	cookie := h.login()

	transport := &http.Transport{}
	defer transport.CloseIdleConnections()
	req, err := http.NewRequest("GET", h.ts.URL+"/engine/real.js", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(cookie)
	resp, err := (&http.Client{Transport: transport}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !resp.Uncompressed || string(body) != original {
		t.Fatalf("Uncompressed = %v, body = %q", resp.Uncompressed, body)
	}
}

func TestContentTypes(t *testing.T) {
	for name, want := range map[string]string{
		"a.wasm":        "application/wasm",
		"a.WASM":        "application/wasm",
		"a.js":          "text/javascript; charset=utf-8",
		"a.mjs":         "text/javascript; charset=utf-8",
		"a.css":         "text/css; charset=utf-8",
		"a.html":        "text/html; charset=utf-8",
		"a.json":        "application/json",
		"a.svg":         "image/svg+xml",
		"a.woff2":       "font/woff2",
		"a.big":         contentTypeBinary,
		"no-extension":  contentTypeBinary,
		"dir.js/a.data": contentTypeBinary,
	} {
		if got := contentTypeFor(name); got != want {
			t.Errorf("contentTypeFor(%q) = %q, want %q", name, got, want)
		}
	}
}

// shellHarness mimics a Vite build with base "/shell/".
func shellHarness(t *testing.T) *harness {
	t.Helper()
	h := newHarness(t)
	writeFile(t, filepath.Join(h.webDir, "index.html"), "<title>gate page</title>")
	writeFile(t, filepath.Join(h.webDir, "favicon.svg"), "<svg/>")
	writeFile(t, filepath.Join(h.webDir, "assets", "index-AbCd12_-.js"), "// hashed script")
	writeFile(t, filepath.Join(h.webDir, "assets", "index-XyZ98765.css"), "/* hashed style */")
	writeFile(t, filepath.Join(h.webDir, "assets", "plain.js"), "// unhashed")
	return h
}

func TestShellServesFilesWithCacheHeaders(t *testing.T) {
	h := shellHarness(t)
	for _, tc := range []struct {
		target, body, contentType, cache string
	}{
		{"/", "<title>gate page</title>", "text/html; charset=utf-8", cacheShell},
		{"/shell", "<title>gate page</title>", "text/html; charset=utf-8", cacheShell},
		{"/shell/", "<title>gate page</title>", "text/html; charset=utf-8", cacheShell},
		{"/shell/index.html", "<title>gate page</title>", "text/html; charset=utf-8", cacheShell},
		{"/shell/favicon.svg", "<svg/>", "image/svg+xml", cacheShell},
		{"/shell/assets/index-AbCd12_-.js", "// hashed script", "text/javascript; charset=utf-8", cacheHashed},
		{"/shell/assets/index-XyZ98765.css", "/* hashed style */", "text/css; charset=utf-8", cacheHashed},
		{"/shell/assets/plain.js", "// unhashed", "text/javascript; charset=utf-8", cacheShell},
	} {
		r := h.do("GET", tc.target, "")
		if r.status != http.StatusOK || string(r.body) != tc.body {
			t.Errorf("GET %s: status = %d, body = %q", tc.target, r.status, r.body)
		}
		if got := r.header.Get("Content-Type"); got != tc.contentType {
			t.Errorf("GET %s: Content-Type = %q, want %q", tc.target, got, tc.contentType)
		}
		if got := r.header.Get("Cache-Control"); got != tc.cache {
			t.Errorf("GET %s: Cache-Control = %q, want %q", tc.target, got, tc.cache)
		}
		requireSecurityHeaders(t, tc.target, r.header)
	}
}

// Browsers act on these exact strings, so they are spelled out here rather than
// compared with the constants the code uses.
func TestCacheControlValues(t *testing.T) {
	h := shellHarness(t)
	writeFile(t, filepath.Join(h.assetDir, "manifest.json"), `{"schema":1}`)
	writeFile(t, filepath.Join(h.assetDir, "game.big"), "synthetic")
	writeFile(t, filepath.Join(h.engineDir, "game.wasm"), "synthetic")
	cookie := h.login()
	for target, want := range map[string]string{
		"/":                               "no-cache",
		"/shell/":                         "no-cache",
		"/shell/some/client/route":        "no-cache",
		"/shell/favicon.svg":              "no-cache",
		"/shell/assets/index-AbCd12_-.js": "public, max-age=31536000, immutable",
		"/assets/manifest.json":           "private, no-cache",
		"/assets/files/game.big":          "private, no-store, no-transform",
		"/engine/game.wasm":               "private, no-cache",
		"/api/session":                    "no-store",
	} {
		r := h.do("GET", target, "", withCookie(cookie))
		if got := r.header.Get("Cache-Control"); got != want {
			t.Errorf("GET %s: Cache-Control = %q, want %q", target, got, want)
		}
	}
}

func TestShellCacheControlRule(t *testing.T) {
	for rel, want := range map[string]string{
		"assets/index-CZWzRLjr.js":  cacheHashed, // the forms the real web build emits
		"assets/index-CJ54uAhe.css": cacheHashed,
		"assets/worker-CQqGfVzZ.js": cacheHashed,
		"assets/index-AbCd1234.js":  cacheHashed,
		"assets/chunk-abc_DEF-9.js": cacheHashed,
		"assets/deep/x-AbCd1234.js": cacheHashed,
		"assets/short-abc.js":       cacheShell,
		"assets/nohash.js":          cacheShell,
		"index-AbCd1234.js":         cacheShell, // outside Vite's assets directory
		"index.html":                cacheShell,
	} {
		if got := shellCacheControl(rel); got != want {
			t.Errorf("shellCacheControl(%q) = %q, want %q", rel, got, want)
		}
	}
}

func TestSPAFallbackOnlyForGatePage(t *testing.T) {
	h := shellHarness(t)
	for target, wantGate := range map[string]bool{
		"/shell/some/client/route": true,
		"/shell/login":             true,
		"/shell/assets":            true, // a directory, no listing
		"/shell/missing.js":        false,
		"/shell/assets/gone-1.css": false,
		"/shell/.env":              false,
		"/shell/a/../b":            false,
		"/other":                   false,
		"/other/route":             false,
		"/index.html":              false,
		"/shellfish":               false,
		"/api/nope":                false,
		"/favicon.ico":             false,
	} {
		r := h.raw("GET", target, nil)
		isGate := r.status == http.StatusOK && bytes.Contains(r.body, []byte("gate page"))
		if isGate != wantGate {
			t.Errorf("GET %s: status = %d, served gate page = %v, want %v", target, r.status, isGate, wantGate)
		}
		if !wantGate && r.status != http.StatusNotFound {
			t.Errorf("GET %s: status = %d, want 404", target, r.status)
		}
	}
}

func TestProtectedRoutesNeverFallBackToGatePage(t *testing.T) {
	h := shellHarness(t)
	cookie := h.login()
	for _, target := range []string{
		"/assets/files/missing", "/assets/other", "/assets/", "/engine/missing", "/engine/",
	} {
		for _, c := range []*http.Cookie{nil, cookie} {
			r := h.do("GET", target, "", withCookie(c))
			if bytes.Contains(r.body, []byte("gate page")) {
				t.Errorf("GET %s fell back to the gate page", target)
			}
		}
	}
}

func TestShellMethods(t *testing.T) {
	h := shellHarness(t)
	if r := h.do("HEAD", "/", ""); r.status != http.StatusOK || len(r.body) != 0 {
		t.Errorf("HEAD /: status = %d, %d bytes", r.status, len(r.body))
	}
	r := h.do("POST", "/shell/", "")
	if r.status != http.StatusMethodNotAllowed || r.header.Get("Allow") != "GET, HEAD" {
		t.Errorf("POST: status = %d, Allow = %q", r.status, r.header.Get("Allow"))
	}
}

// sparseAsset makes a large game file instantly, using no real disk space.
func sparseAsset(t *testing.T, h *harness, name string, size int64) {
	t.Helper()
	f, err := os.Create(filepath.Join(h.assetDir, name))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := f.Truncate(size); err != nil {
		t.Fatal(err)
	}
}

// A download may run far longer than the stall limit, as long as it keeps moving.
// A fixed deadline would cut this one off around the 500ms mark.
func TestSlowDownloadOutlivesTheStallLimit(t *testing.T) {
	const size = 32 << 20
	h := newHarness(t, func(o *Options) { o.WriteStall = 500 * time.Millisecond })
	sparseAsset(t, h, "large.big", size)
	cookie := h.login()

	req, err := http.NewRequest("GET", h.ts.URL+"/assets/files/large.big", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(cookie)
	client := &http.Client{Transport: h.client.Transport} // no overall client timeout
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	start := time.Now()
	var total int64
	for {
		n, err := io.CopyN(io.Discard, resp.Body, 2<<20)
		total += n
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("download failed after %d bytes and %v: %v", total, time.Since(start), err)
		}
		time.Sleep(100 * time.Millisecond)
	}
	if total != size {
		t.Fatalf("read %d bytes, want %d", total, size)
	}
	if elapsed := time.Since(start); elapsed < time.Second {
		t.Fatalf("download took only %v, so this test proved nothing", elapsed)
	}
}

// A client that stops reading must not hold its handler forever.
func TestStalledClientIsDropped(t *testing.T) {
	const size = 256 << 20
	h := newHarness(t, func(o *Options) { o.WriteStall = 300 * time.Millisecond })
	sparseAsset(t, h, "large.big", size)
	cookie := h.login()

	conn, err := net.DialTimeout("tcp", h.ts.Listener.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if tcp, ok := conn.(*net.TCPConn); ok {
		if err := tcp.SetReadBuffer(4096); err != nil {
			t.Fatal(err)
		}
	}
	fmt.Fprintf(conn, "GET /assets/files/large.big HTTP/1.1\r\nHost: test.invalid\r\nCookie: %s=%s\r\n\r\n", cookie.Name, cookie.Value)

	// Read nothing, then wait for the handler to give up and log its request.
	deadline := time.Now().Add(30 * time.Second)
	for {
		for line := range strings.SplitSeq(h.logs.String(), "\n") {
			if !strings.Contains(line, `"route":"assets.file"`) {
				continue
			}
			var record struct {
				Bytes int64 `json:"bytes"`
			}
			if err := json.Unmarshal([]byte(line), &record); err != nil {
				t.Fatal(err)
			}
			if record.Bytes >= size {
				t.Fatalf("the handler wrote all %d bytes to a client that read nothing", record.Bytes)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the handler is still blocked on a client that stopped reading")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestIndexRevalidates(t *testing.T) {
	h := shellHarness(t)
	etag := h.do("GET", "/", "").header.Get("ETag")
	if etag == "" {
		t.Fatal("index has no ETag")
	}
	if r := h.do("GET", "/", "", withHeader("If-None-Match", etag)); r.status != http.StatusNotModified {
		t.Fatalf("status = %d, want 304", r.status)
	}
}
