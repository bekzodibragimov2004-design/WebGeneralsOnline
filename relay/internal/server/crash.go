package server

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const maxCrashBody = 256 << 10

var errCrashStoreFull = errors.New("crash store is full")

// crashStore writes one file per report and enforces a cap on the bytes held in
// its directory. When full it refuses new reports rather than deleting old ones,
// so the first crashes of a failure are the ones kept.
type crashStore struct {
	dir      string
	maxBytes int64
	now      func() time.Time

	mu   sync.Mutex
	used int64
}

func newCrashStore(dir string, maxBytes int64, now func() time.Time) (*crashStore, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("creating crash directory: %w", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("reading crash directory: %w", err)
	}
	store := &crashStore{dir: dir, maxBytes: maxBytes, now: now}
	for _, entry := range entries {
		if info, err := entry.Info(); err == nil && info.Mode().IsRegular() {
			store.used += info.Size()
		}
	}
	return store, nil
}

// save stores a report and returns its generated file name. Nothing in the name
// comes from the client.
func (c *crashStore) save(report []byte) (string, error) {
	size := int64(len(report))

	c.mu.Lock()
	if c.used+size > c.maxBytes {
		c.mu.Unlock()
		return "", errCrashStoreFull
	}
	c.used += size
	c.mu.Unlock()

	name, err := c.write(report)
	if err != nil {
		c.mu.Lock()
		c.used -= size
		c.mu.Unlock()
		return "", err
	}
	return name, nil
}

func (c *crashStore) write(report []byte) (string, error) {
	var id [16]byte
	_, _ = rand.Read(id[:])
	name := fmt.Sprintf("crash-%s-%s.json", c.now().UTC().Format("20060102T150405Z"), hex.EncodeToString(id[:]))

	tmp, err := os.CreateTemp(c.dir, ".incoming-*.tmp")
	if err != nil {
		return "", err
	}
	tmpName := tmp.Name()
	_, writeErr := tmp.Write(report)
	closeErr := tmp.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		_ = os.Remove(tmpName)
		return "", err
	}
	if err := os.Rename(tmpName, filepath.Join(c.dir, name)); err != nil {
		_ = os.Remove(tmpName)
		return "", err
	}
	return name, nil
}

// isJSONObject accepts the shape docs/WEB_CONTRACT.md describes without checking
// its fields, because a report from a newer client is still worth keeping.
func isJSONObject(body []byte) bool {
	return json.Valid(body) && bytes.HasPrefix(bytes.TrimLeft(body, " \t\r\n"), []byte("{"))
}

func (s *Server) handleCrash(w http.ResponseWriter, r *http.Request) {
	if !allowMethods(w, r, http.MethodPost) {
		return
	}
	// The limit comes first, so rejected reports cost a client its budget too.
	allowed, retry := s.crashLimit.Allow(clientKey(r))
	if !allowed {
		writeRateLimited(w, retry)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxCrashBody))
	if err != nil {
		writeBodyError(w, err)
		return
	}
	if !isJSONObject(body) {
		writeError(w, http.StatusBadRequest, "report must be a JSON object")
		return
	}
	name, err := s.crash.save(body)
	switch {
	case errors.Is(err, errCrashStoreFull):
		s.log.Warn("crash store is full, report dropped", "bytes", len(body))
		writeError(w, http.StatusInsufficientStorage, "crash store full")
		return
	case err != nil:
		s.log.Error("could not store crash report", "bytes", len(body))
		writeError(w, http.StatusInternalServerError, "could not store report")
		return
	}
	s.log.Info("crash report stored", "file", name, "bytes", len(body))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}
