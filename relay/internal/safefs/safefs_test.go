package safefs

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestValidateAccepts(t *testing.T) {
	for _, rel := range []string{
		"manifest.json",
		"INIZH.big",
		"ZH_Generals/INI.big",
		"Generals/INI.big",
		"500_900_CommunityPatch_CoreINI.big",
		"Data/INI/INIZH.big",
		"Data/Audio/Sounds/a b.wav",
		"name.with.dots.big",
		"Maps/Alpine Assault/map.ini",
		"percent%2e%2e.txt",
		"unicode-名前.txt",
		"console.big",
		"auxiliary.ini",
		"nullable.txt",
		"COM.big",
		"COM10.big",
		"LPT.txt",
		"prnt.txt",
	} {
		if err := Validate(rel); err != nil {
			t.Errorf("Validate(%q) = %v, want nil", rel, err)
		}
	}
}

func TestValidateRejects(t *testing.T) {
	cases := []string{
		"",
		".",
		"..",
		"../x",
		"a/../b",
		"a/..",
		"a/./b",
		"/abs",
		"a//b",
		"a/",
		`..\x`,
		`a\b`,
		`\\server\share\x`,
		"C:/Windows/win.ini",
		"C:",
		"file.big::$DATA",
		"file.big:stream",
		"file.big.",
		"file.big ",
		"dir./file",
		"dir /file",
		".env",
		"a/.git/config",
		"...",
		"a\x00b",
		"a\nb",
		"a\x7fb",
		"\xc0\xaf",
		"..\xc0\xafx",
		"a*b",
		"a?b",
		`a"b`,
		"a<b",
		"a>b",
		"a|b",
		strings.Repeat("a", maxPathBytes+1),
		"NUL",
		"con",
		"COM1",
		"dir/AUX",
		"NUL.txt",
		"lpt1.big",
		"nul .txt",
		"con.tar.gz",
		"COM¹",
		"lpt².txt",
		"CONIN$",
		"dir/conout$.txt",
	}
	for _, rel := range cases {
		if err := Validate(rel); !errors.Is(err, ErrInvalidPath) {
			t.Errorf("Validate(%q) = %v, want ErrInvalidPath", rel, err)
		}
	}
}

// layout builds root/inside.txt, root/sub/nested.txt and, next to the root,
// outside/secret.txt.
func layout(t *testing.T) (root, outside string) {
	t.Helper()
	base := t.TempDir()
	root = filepath.Join(base, "root")
	outside = filepath.Join(base, "outside")
	for _, dir := range []string{filepath.Join(root, "sub"), outside} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]string{
		filepath.Join(root, "inside.txt"):        "inside",
		filepath.Join(root, "sub", "nested.txt"): "nested",
		filepath.Join(outside, "secret.txt"):     "secret",
	}
	for path, content := range files {
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root, outside
}

func readAll(t *testing.T, root, rel string) string {
	t.Helper()
	f, _, err := Open(root, rel)
	if err != nil {
		t.Fatalf("Open(%q) = %v", rel, err)
	}
	defer f.Close()
	data, err := io.ReadAll(f)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestOpenRegularFiles(t *testing.T) {
	root, _ := layout(t)
	if got := readAll(t, root, "inside.txt"); got != "inside" {
		t.Errorf("inside.txt = %q", got)
	}
	if got := readAll(t, root, "sub/nested.txt"); got != "nested" {
		t.Errorf("sub/nested.txt = %q", got)
	}
}

func TestOpenRejectsDirectories(t *testing.T) {
	root, _ := layout(t)
	if _, _, err := Open(root, "sub"); !errors.Is(err, ErrNotRegular) {
		t.Fatalf("Open(dir) = %v, want ErrNotRegular", err)
	}
}

func TestOpenMissingFile(t *testing.T) {
	root, _ := layout(t)
	if _, _, err := Open(root, "missing.txt"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Open(missing) = %v, want not-exist", err)
	}
	if _, _, err := Open(filepath.Join(root, "no-such-root"), "inside.txt"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Open with missing root = %v, want not-exist", err)
	}
}

func TestOpenRefusesRelativeSymlinkThatLeavesRoot(t *testing.T) {
	root, _ := layout(t)
	symlink(t, filepath.Join("..", "outside", "secret.txt"), filepath.Join(root, "file-link"))
	symlink(t, filepath.Join("..", "outside"), filepath.Join(root, "dir-link"))
	for _, rel := range []string{"file-link", "dir-link/secret.txt"} {
		if f, _, err := Open(root, rel); err == nil {
			f.Close()
			t.Errorf("Open(%q) succeeded through a symlink leaving the root", rel)
		}
	}
}

func TestOpenRefusesAbsoluteSymlinkThatLeavesRoot(t *testing.T) {
	root, outside := layout(t)
	symlink(t, filepath.Join(outside, "secret.txt"), filepath.Join(root, "abs-link"))
	if f, _, err := Open(root, "abs-link"); err == nil {
		f.Close()
		t.Fatal("Open succeeded through an absolute symlink leaving the root")
	}
}

func TestOpenFollowsSymlinkInsideRoot(t *testing.T) {
	root, _ := layout(t)
	symlink(t, "inside.txt", filepath.Join(root, "local-link"))
	if got := readAll(t, root, "local-link"); got != "inside" {
		t.Fatalf("local-link = %q", got)
	}
}

// Junctions need no privilege on Windows, so this escape check runs even where
// the symlink tests have to skip.
func TestOpenRefusesJunctionThatLeavesRoot(t *testing.T) {
	root, outside := layout(t)
	junction(t, outside, filepath.Join(root, "junction"))
	if f, _, err := Open(root, "junction/secret.txt"); err == nil {
		f.Close()
		t.Fatal("Open succeeded through a junction leaving the root")
	}
}

func symlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("cannot create symlinks here: %v", err)
	}
}

func junction(t *testing.T, target, link string) {
	t.Helper()
	if runtime.GOOS != "windows" {
		t.Skip("junctions exist only on Windows")
	}
	out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput()
	if err != nil {
		t.Fatalf("mklink /J: %v: %s", err, out)
	}
}
