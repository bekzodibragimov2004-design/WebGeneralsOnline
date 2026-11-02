package server

import (
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path"
	"regexp"
	"strconv"
	"strings"

	"webgeneralsonline/relay/internal/safefs"
)

const (
	// Game files land in OPFS and are checked against the manifest's SHA-256, so
	// a second copy in the browser's HTTP cache would only waste gigabytes of
	// disk. no-transform stops anything in between compressing them, which would
	// break Range requests.
	cacheGameFile = "private, no-store, no-transform"
	cacheManifest = "private, no-cache"
	cacheEngine   = "private, no-cache"
	cacheHashed   = "public, max-age=31536000, immutable"
	cacheShell    = "no-cache"

	contentTypeBinary = "application/octet-stream"
)

// contentTypes is a fixed table on purpose. Go's mime package consults the
// Windows registry, which can map .js to text/plain and break module scripts.
var contentTypes = map[string]string{
	".avif":        "image/avif",
	".css":         "text/css; charset=utf-8",
	".gif":         "image/gif",
	".html":        "text/html; charset=utf-8",
	".ico":         "image/x-icon",
	".jpeg":        "image/jpeg",
	".jpg":         "image/jpeg",
	".js":          "text/javascript; charset=utf-8",
	".json":        "application/json",
	".map":         "application/json",
	".mjs":         "text/javascript; charset=utf-8",
	".png":         "image/png",
	".svg":         "image/svg+xml",
	".ttf":         "font/ttf",
	".txt":         "text/plain; charset=utf-8",
	".wasm":        "application/wasm",
	".webmanifest": "application/manifest+json",
	".webp":        "image/webp",
	".woff":        "font/woff",
	".woff2":       "font/woff2",
}

func contentTypeFor(name string) string {
	if ct, ok := contentTypes[strings.ToLower(path.Ext(name))]; ok {
		return ct
	}
	return contentTypeBinary
}

// open wraps safefs.Open. It reports refusals other than plain absence without
// the path, which came from the client.
func (s *Server) open(root, rel string) (*os.File, fs.FileInfo, bool) {
	f, info, err := safefs.Open(root, rel)
	if err == nil {
		return f, info, true
	}
	if !errors.Is(err, fs.ErrNotExist) && !errors.Is(err, safefs.ErrInvalidPath) && !errors.Is(err, safefs.ErrNotRegular) {
		s.log.Warn("file open refused, check for links leaving the root or bad permissions")
	}
	return nil, nil, false
}

// serveFile hands an open file to http.ServeContent, which implements Range,
// If-Range, If-None-Match and the other conditional headers. The ETag is strong,
// as If-Range requires, and etagSuffix keeps each encoding's bytes distinct.
func serveFile(w http.ResponseWriter, r *http.Request, f *os.File, info fs.FileInfo, contentType, cacheControl, etagSuffix string) {
	h := w.Header()
	h.Set("Content-Type", contentType)
	h.Set("Cache-Control", cacheControl)
	h.Set("ETag", fmt.Sprintf(`"%x-%x%s"`, info.Size(), info.ModTime().UnixNano(), etagSuffix))
	http.ServeContent(w, r, "", info.ModTime(), f)
}

func writeNotFound(w http.ResponseWriter) {
	writeError(w, http.StatusNotFound, "not found")
}

func (s *Server) handleManifest(w http.ResponseWriter, r *http.Request) {
	if !allowMethods(w, r, http.MethodGet, http.MethodHead) {
		return
	}
	f, info, ok := s.open(s.assetDir, "manifest.json")
	if !ok {
		writeNotFound(w)
		return
	}
	defer f.Close()
	serveFile(w, r, f, info, "application/json", cacheManifest, "")
}

// handleAssetFile never content-encodes, as the contract requires, because byte
// ranges must stay valid against the manifest's size and hash. Unlike the engine
// route, it ignores Accept-Encoding and sidecar files.
func (s *Server) handleAssetFile(w http.ResponseWriter, r *http.Request) {
	if !allowMethods(w, r, http.MethodGet, http.MethodHead) {
		return
	}
	rel, ok := strings.CutPrefix(r.URL.Path, "/assets/files/")
	if !ok {
		writeNotFound(w)
		return
	}
	f, info, ok := s.open(s.assetDir, rel)
	if !ok {
		writeNotFound(w)
		return
	}
	defer f.Close()
	serveFile(w, r, f, info, contentTypeBinary, cacheGameFile, "")
}

func (s *Server) handleEngine(w http.ResponseWriter, r *http.Request) {
	if !allowMethods(w, r, http.MethodGet, http.MethodHead) {
		return
	}
	rel, ok := strings.CutPrefix(r.URL.Path, "/engine/")
	if !ok || safefs.Validate(rel) != nil {
		writeNotFound(w)
		return
	}

	h := w.Header()
	h.Add("Vary", "Accept-Encoding")
	contentType := contentTypeFor(rel)

	for _, enc := range acceptedEncodings(r.Header.Get("Accept-Encoding")) {
		f, info, ok := s.open(s.engineDir, rel+enc.suffix)
		if !ok {
			continue
		}
		defer f.Close()
		h.Set("Content-Encoding", enc.name)
		// ServeContent leaves Content-Length off once Content-Encoding is set,
		// expecting a later layer to compress. These bytes are final, and the
		// length gives the client a real progress bar.
		h.Set("Content-Length", strconv.FormatInt(info.Size(), 10))
		serveFile(w, r, f, info, contentType, cacheEngine, "-"+enc.name)
		return
	}

	f, info, ok := s.open(s.engineDir, rel)
	if !ok {
		writeNotFound(w)
		return
	}
	defer f.Close()
	serveFile(w, r, f, info, contentType, cacheEngine, "")
}

type encoding struct{ name, suffix string }

var (
	encodingBrotli = encoding{name: "br", suffix: ".br"}
	encodingGzip   = encoding{name: "gzip", suffix: ".gz"}
)

// acceptedEncodings parses Accept-Encoding into the sidecars worth trying, most
// preferred first. A tie goes to Brotli, which is smaller. An explicit q=0
// refuses an encoding even when "*" would allow it.
func acceptedEncodings(header string) []encoding {
	const unset = -1.0
	brotli, gzip, wildcard := unset, unset, unset
	for part := range strings.SplitSeq(header, ",") {
		name, params, _ := strings.Cut(part, ";")
		quality := parseQuality(params)
		switch strings.ToLower(strings.TrimSpace(name)) {
		case "br":
			brotli = quality
		case "gzip", "x-gzip":
			gzip = quality
		case "*":
			wildcard = quality
		}
	}
	if brotli == unset {
		brotli = wildcard
	}
	if gzip == unset {
		gzip = wildcard
	}

	var accepted []encoding
	if brotli > 0 {
		accepted = append(accepted, encodingBrotli)
	}
	if gzip > 0 {
		if gzip > brotli {
			accepted = append([]encoding{encodingGzip}, accepted...)
		} else {
			accepted = append(accepted, encodingGzip)
		}
	}
	return accepted
}

// parseQuality reads the q parameter. It defaults to 1, and a malformed or
// out-of-range value counts as 0, which refuses the encoding.
func parseQuality(params string) float64 {
	for param := range strings.SplitSeq(params, ";") {
		key, value, found := strings.Cut(param, "=")
		if !found || !strings.EqualFold(strings.TrimSpace(key), "q") {
			continue
		}
		quality, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
		if err != nil || quality < 0 || quality > 1 {
			return 0
		}
		return quality
	}
	return 1
}

// viteHashedName matches Vite's default output name, such as index-BxY12a_z.js.
var viteHashedName = regexp.MustCompile(`-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$`)

// shellCacheControl gives a long life only to what Vite content-hashes, which it
// writes to assets/. Files from Vite's public directory keep their names, so they
// must revalidate like the index.
func shellCacheControl(rel string) string {
	if strings.HasPrefix(rel, "assets/") && viteHashedName.MatchString(path.Base(rel)) {
		return cacheHashed
	}
	return cacheShell
}

// handleShell serves the public Vite dist: "/" and "/shell" give the gate page,
// and /shell/<rel> gives <dist>/<rel>. The SPA fallback to the gate page applies
// only to valid paths under /shell with no file extension. A missing script or
// style sheet gets a real 404, and no other route ever falls back.
func (s *Server) handleShell(w http.ResponseWriter, r *http.Request) {
	if !allowMethods(w, r, http.MethodGet, http.MethodHead) {
		return
	}
	rel := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, "/shell"), "/")
	if rel != "" {
		if f, info, ok := s.open(s.webDir, rel); ok {
			defer f.Close()
			serveFile(w, r, f, info, contentTypeFor(rel), shellCacheControl(rel), "")
			return
		}
		if safefs.Validate(rel) != nil || path.Ext(rel) != "" {
			writeNotFound(w)
			return
		}
	}
	f, info, ok := s.open(s.webDir, "index.html")
	if !ok {
		writeNotFound(w)
		return
	}
	defer f.Close()
	serveFile(w, r, f, info, contentTypes[".html"], cacheShell, "")
}
