package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const fakePassword = "fake-config-password-for-tests"

func fakeEnv(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

// dirArgs supplies the four required directories.
func dirArgs() []string {
	return []string{
		"--asset-dir", "assets",
		"--web-dir", "web",
		"--engine-dir", "engine",
		"--crash-dir", "crash",
	}
}

func devArgs(extra ...string) []string {
	return append(append(dirArgs(), "--insecure-dev"), extra...)
}

func withPassword() Sources {
	return Sources{Getenv: fakeEnv(map[string]string{passwordKey: fakePassword}), Output: &bytes.Buffer{}}
}

// fakeRepo creates a temporary repo root holding the given .env content.
func fakeRepo(t *testing.T, dotEnv string) string {
	t.Helper()
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte(dotEnv), 0o600); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestFlagsOverrideEnvironment(t *testing.T) {
	src := Sources{
		Getenv: fakeEnv(map[string]string{
			passwordKey:      fakePassword,
			"WGO_LISTEN":     "127.0.0.1:1",
			"WGO_ASSET_DIR":  "env-assets",
			"WGO_WEB_DIR":    "env-web",
			"WGO_ENGINE_DIR": "env-engine",
			"WGO_CRASH_DIR":  "env-crash",
			"WGO_TLS_CERT":   "env-cert.pem",
			"WGO_TLS_KEY":    "env-key.pem",
		}),
		Output: &bytes.Buffer{},
	}
	cfg, err := Load([]string{"--listen", "127.0.0.1:2", "--asset-dir", "flag-assets"}, src)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Listen != "127.0.0.1:2" || cfg.AssetDir != "flag-assets" {
		t.Errorf("flags did not win: %+v", cfg)
	}
	if cfg.WebDir != "env-web" || cfg.EngineDir != "env-engine" || cfg.CrashDir != "env-crash" {
		t.Errorf("environment not used: %+v", cfg)
	}
	if cfg.TLSCert != "env-cert.pem" || cfg.TLSKey != "env-key.pem" || !cfg.UsesTLS() {
		t.Errorf("TLS settings not used: %+v", cfg)
	}
}

func TestDefaultListenIsLoopback(t *testing.T) {
	cfg, err := Load(devArgs(), withPassword())
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Listen != DefaultListen || !cfg.ListenIsLoopback() {
		t.Fatalf("Listen = %q", cfg.Listen)
	}
}

func TestListenIsLoopback(t *testing.T) {
	for addr, want := range map[string]bool{
		"127.0.0.1:1":   true,
		"[::1]:1":       true,
		"localhost:1":   true,
		":1":            false,
		"0.0.0.0:1":     false,
		"192.168.1.5:1": false,
		"example.org:1": false,
	} {
		c := Config{Listen: addr}
		if got := c.ListenIsLoopback(); got != want {
			t.Errorf("ListenIsLoopback(%q) = %v, want %v", addr, got, want)
		}
	}
}

func TestRefusesPlainHTTPWithoutFlag(t *testing.T) {
	_, err := Load(dirArgs(), withPassword())
	if err == nil || !strings.Contains(err.Error(), "plain HTTP") {
		t.Fatalf("err = %v, want plain HTTP refusal", err)
	}
}

func TestInsecureDevCannotBeSetFromEnvironment(t *testing.T) {
	src := withPassword()
	src.Getenv = fakeEnv(map[string]string{
		passwordKey:        fakePassword,
		"WGO_INSECURE_DEV": "1",
		"INSECURE_DEV":     "1",
	})
	if _, err := Load(dirArgs(), src); err == nil {
		t.Fatal("plain HTTP was enabled without the explicit flag")
	}
}

func TestTLSFlagCombinations(t *testing.T) {
	cases := []struct {
		name string
		args []string
		ok   bool
	}{
		{"both", []string{"--tls-cert", "c", "--tls-key", "k"}, true},
		{"cert only", []string{"--tls-cert", "c"}, false},
		{"key only", []string{"--tls-key", "k"}, false},
		{"insecure with cert", []string{"--tls-cert", "c", "--tls-key", "k", "--insecure-dev"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Load(append(dirArgs(), tc.args...), withPassword())
			if (err == nil) != tc.ok {
				t.Fatalf("err = %v, want ok = %v", err, tc.ok)
			}
		})
	}
}

func TestMissingDirectoriesAreAllNamed(t *testing.T) {
	_, err := Load([]string{"--insecure-dev", "--web-dir", "w"}, withPassword())
	if err == nil {
		t.Fatal("want error")
	}
	for _, name := range []string{"--asset-dir", "--engine-dir", "--crash-dir"} {
		if !strings.Contains(err.Error(), name) {
			t.Errorf("error %q does not name %s", err, name)
		}
	}
	if strings.Contains(err.Error(), "--web-dir") {
		t.Errorf("error %q names a setting that was given", err)
	}
}

func TestBadListenAndPositionalArgs(t *testing.T) {
	if _, err := Load(devArgs("--listen", "no-port"), withPassword()); err == nil {
		t.Error("want error for a listen address without a port")
	}
	if _, err := Load(devArgs(fakePassword), withPassword()); err == nil {
		t.Error("want error for a positional argument")
	} else if strings.Contains(err.Error(), fakePassword) {
		t.Error("positional argument echoed in the error")
	}
}

func TestHelp(t *testing.T) {
	src := withPassword()
	var out bytes.Buffer
	src.Output = &out
	if _, err := Load([]string{"--help"}, src); !errors.Is(err, flag.ErrHelp) {
		t.Fatalf("err = %v, want flag.ErrHelp", err)
	}
	if !strings.Contains(out.String(), "--insecure-dev") && !strings.Contains(out.String(), "-insecure-dev") {
		t.Errorf("usage does not mention insecure-dev: %s", out.String())
	}
}

func TestNoFlagAcceptsThePassword(t *testing.T) {
	for _, name := range []string{"--site-password", "--password"} {
		_, err := Load(devArgs(name, fakePassword), withPassword())
		if err == nil {
			t.Errorf("%s was accepted; passwords on a command line leak", name)
		}
	}
}

func TestPasswordFromEnvironmentWins(t *testing.T) {
	root := fakeRepo(t, passwordKey+"=fake-dotenv-password\n")
	src := withPassword()
	src.WorkDir = root
	cfg, err := Load(devArgs(), src)
	if err != nil {
		t.Fatal(err)
	}
	if string(cfg.SitePassword) != fakePassword {
		t.Fatal("environment password should win over .env")
	}
}

func TestPasswordFromDotEnvWhenNotSet(t *testing.T) {
	for name, env := range map[string]map[string]string{
		"unset": {},
		"empty": {passwordKey: ""},
		"blank": {passwordKey: "   "},
	} {
		t.Run(name, func(t *testing.T) {
			root := fakeRepo(t, passwordKey+"=fake-dotenv-password\n")
			sub := filepath.Join(root, "relay", "cmd")
			if err := os.MkdirAll(sub, 0o755); err != nil {
				t.Fatal(err)
			}
			cfg, err := Load(devArgs(), Sources{Getenv: fakeEnv(env), WorkDir: sub, Output: &bytes.Buffer{}})
			if err != nil {
				t.Fatal(err)
			}
			if string(cfg.SitePassword) != "fake-dotenv-password" {
				t.Fatal("password not read from .env at the repo root")
			}
		})
	}
}

func TestDotEnvFoundFromExeDir(t *testing.T) {
	root := fakeRepo(t, passwordKey+"=fake-dotenv-password\n")
	src := Sources{Getenv: fakeEnv(nil), WorkDir: t.TempDir(), ExeDir: root, Output: &bytes.Buffer{}}
	cfg, err := Load(devArgs(), src)
	if err != nil {
		t.Fatal(err)
	}
	if string(cfg.SitePassword) != "fake-dotenv-password" {
		t.Fatal("password not found through the executable's directory")
	}
}

func TestExplicitEnvFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "custom.env")
	if err := os.WriteFile(path, []byte(passwordKey+"=fake-custom-password\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	src := Sources{Getenv: fakeEnv(nil), Output: &bytes.Buffer{}}
	cfg, err := Load(devArgs("--env-file", path), src)
	if err != nil {
		t.Fatal(err)
	}
	if string(cfg.SitePassword) != "fake-custom-password" {
		t.Fatal("explicit env file not used")
	}
	if _, err := Load(devArgs("--env-file", path+".missing"), src); err == nil {
		t.Fatal("a missing explicit env file must be an error")
	}
}

func TestRefusesEmptyPassword(t *testing.T) {
	cases := map[string]string{
		"empty value":              passwordKey + "=\n",
		"example file layout":      passwordKey + "=       # single shared password for the web app\n",
		"blank quoted":             passwordKey + `="   "` + "\n",
		"commented out":            "# " + passwordKey + "=fake-commented-password\n",
		"other keys only":          "OTHER=fake-other-value\n",
		"different key same start": passwordKey + "_X=fake-other-value\n",
	}
	for name, dotEnv := range cases {
		t.Run(name, func(t *testing.T) {
			root := fakeRepo(t, dotEnv)
			_, err := Load(devArgs(), Sources{Getenv: fakeEnv(nil), WorkDir: root, Output: &bytes.Buffer{}})
			if err == nil || !strings.Contains(err.Error(), passwordKey) {
				t.Fatalf("err = %v, want refusal", err)
			}
			if strings.Contains(err.Error(), "fake-") {
				t.Fatalf("error leaks a .env value: %v", err)
			}
		})
	}
}

func TestRefusesWhenNoEnvFileExists(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	_, err := Load(devArgs(), Sources{Getenv: fakeEnv(nil), WorkDir: root, Output: &bytes.Buffer{}})
	if err == nil || !strings.Contains(err.Error(), passwordKey) {
		t.Fatalf("err = %v, want refusal", err)
	}
}

func TestParseDotEnv(t *testing.T) {
	text := "\uFEFFFIRST=one\r\n" +
		"# a comment\r\n" +
		"\r\n" +
		"  SPACED  =  two  \n" +
		"INLINE=three # trailing comment\n" +
		"HASH=four#five\n" +
		`DOUBLE="six # seven" # comment` + "\n" +
		`SINGLE='eight=nine'` + "\n" +
		"EMPTY=\n" +
		"EMPTY_COMMENT=     # nothing here\n" +
		"not a valid line\n" +
		"REPEAT=old\n" +
		"REPEAT=new\n" +
		"BACKSLASH=C:\\some\\dir\n"
	want := map[string]string{
		"FIRST":         "one",
		"SPACED":        "two",
		"INLINE":        "three",
		"HASH":          "four#five",
		"DOUBLE":        "six # seven",
		"SINGLE":        "eight=nine",
		"EMPTY":         "",
		"EMPTY_COMMENT": "",
		"REPEAT":        "new",
		"BACKSLASH":     `C:\some\dir`,
	}
	got := parseDotEnv(text)
	if len(got) != len(want) {
		t.Errorf("parsed %d keys, want %d: %v", len(got), len(want), got)
	}
	for key, value := range want {
		if got[key] != value {
			t.Errorf("%s = %q, want %q", key, got[key], value)
		}
	}
}

func TestSecretNeverPrints(t *testing.T) {
	cfg := Config{Listen: "x", SitePassword: Secret(fakePassword)}

	var logged bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logged, nil))
	logger.Info("config", "cfg", cfg, "secret", cfg.SitePassword)

	encoded, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}

	renderings := map[string]string{
		"slog": logged.String(),
		"json": string(encoded),
	}
	for _, verb := range []string{"%v", "%+v", "%#v", "%s", "%q", "%x", "%d"} {
		renderings["struct "+verb] = fmt.Sprintf(verb, cfg)
		renderings["value "+verb] = fmt.Sprintf(verb, cfg.SitePassword)
		renderings["pointer "+verb] = fmt.Sprintf(verb, &cfg)
	}
	hexForm := fmt.Sprintf("%x", fakePassword)
	for name, text := range renderings {
		if strings.Contains(text, fakePassword) || strings.Contains(text, hexForm) {
			t.Errorf("%s leaked the secret: %s", name, text)
		}
	}
}
