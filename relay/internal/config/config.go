// Package config resolves the server's settings from flags, the environment and
// the .env file at the repo root.
package config

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// DefaultListen keeps a server started without --listen off the network.
const DefaultListen = "127.0.0.1:8443"

const (
	passwordKey = "SITE_PASSWORD"
	redacted    = "[redacted]"
)

// Secret is a string that refuses to print itself, so a Config that reaches a
// log or an error message by accident does not carry the password with it.
type Secret string

// Format implements fmt.Formatter for every verb.
func (Secret) Format(f fmt.State, _ rune) { _, _ = io.WriteString(f, redacted) }

// LogValue implements slog.LogValuer.
func (Secret) LogValue() slog.Value { return slog.StringValue(redacted) }

// MarshalText implements encoding.TextMarshaler, which also covers JSON.
func (Secret) MarshalText() ([]byte, error) { return []byte(redacted), nil }

// Config is the validated server configuration.
type Config struct {
	Listen       string
	TLSCert      string
	TLSKey       string
	AssetDir     string
	WebDir       string
	EngineDir    string
	CrashDir     string
	InsecureDev  bool
	SitePassword Secret
}

// Sources says where Load may read from. Tests pass fakes, so they can never
// pick up a real .env file.
type Sources struct {
	Getenv func(string) string
	// WorkDir and then ExeDir are where the search for the repo root starts.
	// Either may be empty, which skips it.
	WorkDir string
	ExeDir  string
	// Output receives flag usage and flag errors.
	Output io.Writer
}

// Load parses args and the environment. Flags win over environment variables.
// It returns flag.ErrHelp when usage was requested. No error it returns contains
// the password or any line of the .env file.
func Load(args []string, src Sources) (*Config, error) {
	set := flag.NewFlagSet("relay", flag.ContinueOnError)
	set.SetOutput(src.Output)

	var cfg Config
	var envFile string
	stringFlag := func(dst *string, name, envKey, fallback, usage string) {
		value := src.Getenv(envKey)
		if value == "" {
			value = fallback
		}
		set.StringVar(dst, name, value, fmt.Sprintf("%s (env %s)", usage, envKey))
	}
	stringFlag(&cfg.Listen, "listen", "WGO_LISTEN", DefaultListen, "listen address")
	stringFlag(&cfg.TLSCert, "tls-cert", "WGO_TLS_CERT", "", "TLS certificate PEM file")
	stringFlag(&cfg.TLSKey, "tls-key", "WGO_TLS_KEY", "", "TLS private key PEM file")
	stringFlag(&cfg.AssetDir, "asset-dir", "WGO_ASSET_DIR", "", "directory holding manifest.json and game files")
	stringFlag(&cfg.WebDir, "web-dir", "WGO_WEB_DIR", "", "Vite dist directory")
	stringFlag(&cfg.EngineDir, "engine-dir", "WGO_ENGINE_DIR", "", "directory holding engine .wasm and .js files")
	stringFlag(&cfg.CrashDir, "crash-dir", "WGO_CRASH_DIR", "", "directory for crash reports, created if missing")
	stringFlag(&envFile, "env-file", "WGO_ENV_FILE", "", "file to read SITE_PASSWORD from when it is not in the environment (default: .env at the repo root)")
	set.BoolVar(&cfg.InsecureDev, "insecure-dev", false, "serve plain HTTP and drop the cookie's Secure attribute; for localhost testing only")

	if err := set.Parse(args); err != nil {
		return nil, err
	}
	if set.NArg() > 0 {
		return nil, errors.New("unexpected positional arguments: every setting is a flag")
	}
	if err := cfg.validate(); err != nil {
		return nil, err
	}

	password, err := resolvePassword(envFile, src)
	if err != nil {
		return nil, err
	}
	cfg.SitePassword = password
	return &cfg, nil
}

// UsesTLS reports whether the server should serve HTTPS.
func (c *Config) UsesTLS() bool { return c.TLSCert != "" }

// ListenIsLoopback reports whether the listen address is reachable only from
// this machine.
func (c *Config) ListenIsLoopback() bool {
	host, _, err := net.SplitHostPort(c.Listen)
	if err != nil {
		return false
	}
	if host == "localhost" {
		return true
	}
	addr, err := netip.ParseAddr(host)
	return err == nil && addr.IsLoopback()
}

func (c *Config) validate() error {
	if _, _, err := net.SplitHostPort(c.Listen); err != nil {
		return fmt.Errorf("invalid --listen address: %w", err)
	}
	if (c.TLSCert == "") != (c.TLSKey == "") {
		return errors.New("--tls-cert and --tls-key must be given together")
	}
	if c.InsecureDev && c.UsesTLS() {
		return errors.New("--insecure-dev cannot be combined with --tls-cert and --tls-key")
	}
	if !c.InsecureDev && !c.UsesTLS() {
		return errors.New("refusing to serve plain HTTP: give --tls-cert and --tls-key, or --insecure-dev for localhost testing")
	}
	var missing []string
	for _, dir := range []struct{ value, name string }{
		{c.AssetDir, "--asset-dir"},
		{c.WebDir, "--web-dir"},
		{c.EngineDir, "--engine-dir"},
		{c.CrashDir, "--crash-dir"},
	} {
		if dir.value == "" {
			missing = append(missing, dir.name)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("missing required settings: %s", strings.Join(missing, ", "))
	}
	return nil
}

func resolvePassword(envFile string, src Sources) (Secret, error) {
	if value := src.Getenv(passwordKey); strings.TrimSpace(value) != "" {
		return Secret(value), nil
	}
	path := envFile
	if path == "" {
		path = findDotEnv(src)
	}
	if path != "" {
		data, err := os.ReadFile(path)
		switch {
		case err == nil:
			if value := parseDotEnv(string(data))[passwordKey]; strings.TrimSpace(value) != "" {
				return Secret(value), nil
			}
		case envFile != "" || !errors.Is(err, fs.ErrNotExist):
			return "", fmt.Errorf("reading env file: %w", err)
		}
	}
	return "", errors.New("SITE_PASSWORD is empty: set it in the environment or in .env at the repo root")
}

func findDotEnv(src Sources) string {
	for _, start := range []string{src.WorkDir, src.ExeDir} {
		if start == "" {
			continue
		}
		if root, ok := findRepoRoot(start); ok {
			return filepath.Join(root, ".env")
		}
	}
	return ""
}

func findRepoRoot(start string) (string, bool) {
	dir := filepath.Clean(start)
	for {
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			return dir, true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", false
		}
		dir = parent
	}
}

var (
	dotEnvLine    = regexp.MustCompile(`^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$`)
	dotEnvQuoted  = regexp.MustCompile(`^(?:"([^"]*)"|'([^']*)')`)
	dotEnvComment = regexp.MustCompile(`(^|\s+)#.*$`)
)

// parseDotEnv follows the same rules as parseEnvValues in tools/safety/check.mjs,
// so the password this server uses is the value the commit check protects.
func parseDotEnv(text string) map[string]string {
	values := make(map[string]string)
	text = strings.TrimPrefix(text, "\xef\xbb\xbf") // Notepad's UTF-8 byte order mark
	for _, line := range strings.Split(text, "\n") {
		match := dotEnvLine.FindStringSubmatch(strings.TrimSuffix(line, "\r"))
		if match == nil {
			continue
		}
		body := strings.TrimSpace(match[2])
		if quoted := dotEnvQuoted.FindStringSubmatch(body); quoted != nil {
			values[match[1]] = quoted[1] + quoted[2]
			continue
		}
		values[match[1]] = strings.TrimSpace(dotEnvComment.ReplaceAllString(body, ""))
	}
	return values
}
