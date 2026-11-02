// Package safefs opens files named by URL paths without letting them leave a
// root directory.
//
// Validate rejects anything suspicious in the name itself, and os.OpenInRoot
// then refuses symlinks and junctions that resolve outside the root. The root is
// opened per call so that no handle pins a directory that may be replaced.
package safefs

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

const maxPathBytes = 1024

var (
	// ErrInvalidPath means the name failed validation and was never opened.
	ErrInvalidPath = errors.New("invalid path")
	// ErrNotRegular means the name resolved to a directory or a special file.
	ErrNotRegular = errors.New("not a regular file")
)

// Validate checks a decoded, slash-separated path relative to a root. It rejects:
//
//   - empty, ".", ".." and any other segment starting with a dot, which also
//     keeps .env and .git out of reach
//   - backslashes, and colons (drive letters and NTFS alternate data streams)
//   - control characters, including NUL, and invalid UTF-8
//   - trailing dots and spaces, which Windows strips when opening a file
//   - the other characters Windows forbids in names
//   - Windows device names, with or without an extension
func Validate(rel string) error {
	if rel == "" || len(rel) > maxPathBytes || !utf8.ValidString(rel) {
		return ErrInvalidPath
	}
	for _, c := range rel {
		if c < 0x20 || c == 0x7f || strings.ContainsRune(`\:*?"<>|`, c) {
			return ErrInvalidPath
		}
	}
	for seg := range strings.SplitSeq(rel, "/") {
		if seg == "" || seg[0] == '.' {
			return ErrInvalidPath
		}
		if last := seg[len(seg)-1]; last == '.' || last == ' ' {
			return ErrInvalidPath
		}
		if isDeviceName(seg) {
			return ErrInvalidPath
		}
	}
	if !filepath.IsLocal(filepath.FromSlash(rel)) {
		return ErrInvalidPath
	}
	return nil
}

// isDeviceName reports names that Windows maps to devices. filepath.IsLocal
// catches "NUL" but not "NUL.txt", which versions before Windows 11 also treat as
// the device. The check applies on every OS so that the same path gets the same
// answer everywhere. Game data cannot hold these names, since the game shipped
// for Windows versions where they were impossible.
func isDeviceName(segment string) bool {
	stem, _, _ := strings.Cut(segment, ".")
	stem = strings.ToUpper(strings.TrimRight(stem, " "))
	switch stem {
	case "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$":
		return true
	}
	if !strings.HasPrefix(stem, "COM") && !strings.HasPrefix(stem, "LPT") {
		return false
	}
	suffix := stem[3:]
	return utf8.RuneCountInString(suffix) == 1 && strings.ContainsAny(suffix, "0123456789¹²³")
}

// Open opens a regular file beneath root. The caller closes the file. Errors can
// contain the path, so they must not be logged as they come.
func Open(root, rel string) (*os.File, fs.FileInfo, error) {
	if err := Validate(rel); err != nil {
		return nil, nil, err
	}
	f, err := os.OpenInRoot(root, filepath.FromSlash(rel))
	if err != nil {
		return nil, nil, err
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, nil, err
	}
	if !info.Mode().IsRegular() {
		_ = f.Close()
		return nil, nil, ErrNotRegular
	}
	return f, info, nil
}
