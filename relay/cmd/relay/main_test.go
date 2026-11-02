package main

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"webgeneralsonline/relay/internal/config"
)

const testPassword = "fake-password-for-main-tests"

type syncBuffer struct {
	mu  sync.Mutex
	buf strings.Builder
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type running struct {
	addr   string
	logs   *syncBuffer
	cancel context.CancelFunc
	done   chan error
}

// stop cancels the server and returns what run returned.
func (r *running) stop(t *testing.T) error {
	t.Helper()
	r.cancel()
	select {
	case err := <-r.done:
		return err
	case <-time.After(30 * time.Second):
		t.Fatal("server did not stop")
		return nil
	}
}

// dirArgs builds synthetic directories and the flags naming them.
func dirArgs(t *testing.T) []string {
	t.Helper()
	base := t.TempDir()
	dirs := map[string]string{
		"--asset-dir":  filepath.Join(base, "assets"),
		"--web-dir":    filepath.Join(base, "web"),
		"--engine-dir": filepath.Join(base, "engine"),
		"--crash-dir":  filepath.Join(base, "crash"),
	}
	args := []string{"--listen", "127.0.0.1:0"}
	for flagName, dir := range dirs {
		if flagName != "--crash-dir" {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
			}
		}
		args = append(args, flagName, dir)
	}
	if err := os.WriteFile(filepath.Join(dirs["--web-dir"], "index.html"), []byte("<title>gate</title>"), 0o644); err != nil {
		t.Fatal(err)
	}
	return args
}

// start runs the real entry point. It never sees the real environment or working
// directory, so it cannot read a real .env.
func start(t *testing.T, args []string) *running {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	addrs := make(chan string, 1)
	r := &running{logs: &syncBuffer{}, cancel: cancel, done: make(chan error, 1)}
	env := environment{
		getenv: func(key string) string {
			if key == "SITE_PASSWORD" {
				return testPassword
			}
			return ""
		},
		stderr:   r.logs,
		onListen: func(addr net.Addr) { addrs <- addr.String() },
	}
	go func() { r.done <- run(ctx, args, env) }()

	select {
	case r.addr = <-addrs:
	case err := <-r.done:
		t.Fatalf("server did not start: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("server did not start in time")
	}
	return r
}

// makeCert writes a throwaway self-signed certificate for 127.0.0.1. It is trusted
// only by the client built from the returned pool.
func makeCert(t *testing.T) (certPath, keyPath string, pool *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "relay test"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1")},
		IsCA:                  true,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	certPath = filepath.Join(dir, "cert.pem")
	keyPath = filepath.Join(dir, "key.pem")
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	if err := os.WriteFile(certPath, certPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	pool = x509.NewCertPool()
	if !pool.AppendCertsFromPEM(certPEM) {
		t.Fatal("could not load the test certificate")
	}
	return certPath, keyPath, pool
}

func login(t *testing.T, client *http.Client, base string) *http.Response {
	t.Helper()
	resp, err := client.Post(base+"/api/login", "application/json", strings.NewReader(`{"password":"`+testPassword+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("login = %d", resp.StatusCode)
	}
	return resp
}

func argValue(t *testing.T, args []string, name string) string {
	t.Helper()
	for i, arg := range args {
		if arg == name && i+1 < len(args) {
			return args[i+1]
		}
	}
	t.Fatalf("%s not in %v", name, args)
	return ""
}

func TestServesHTTPSWithSecureCookie(t *testing.T) {
	certPath, keyPath, pool := makeCert(t)
	args := dirArgs(t)
	content := strings.Repeat("0123456789", 100_000)
	if err := os.WriteFile(filepath.Join(argValue(t, args, "--asset-dir"), "game.big"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	r := start(t, append(args, "--tls-cert", certPath, "--tls-key", keyPath))

	transport := &http.Transport{
		TLSClientConfig:   &tls.Config{RootCAs: pool},
		ForceAttemptHTTP2: true,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 10 * time.Second}
	base := "https://" + r.addr

	resp := login(t, client, base)
	if resp.Proto != "HTTP/2.0" {
		t.Errorf("Proto = %q, want HTTP/2.0", resp.Proto)
	}
	if resp.Header.Get("Cross-Origin-Embedder-Policy") != "require-corp" {
		t.Errorf("headers = %v", resp.Header)
	}
	setCookie := resp.Header.Get("Set-Cookie")
	for _, attr := range []string{"wgo_session=", "HttpOnly", "Secure", "SameSite=Strict", "Path=/"} {
		if !strings.Contains(setCookie, attr) {
			t.Errorf("Set-Cookie lacks %s: %q", attr, setCookie)
		}
	}

	get, err := client.Get(base + "/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(get.Body)
	get.Body.Close()
	if get.StatusCode != http.StatusOK || !strings.Contains(string(body), "gate") {
		t.Errorf("GET / = %d, %q", get.StatusCode, body)
	}

	// Production downloads run over HTTP/2, through the write deadline wrapper.
	fetch := func(rangeHeader string) (*http.Response, string) {
		t.Helper()
		req, err := http.NewRequest("GET", base+"/assets/files/game.big", nil)
		if err != nil {
			t.Fatal(err)
		}
		for _, cookie := range resp.Cookies() {
			req.AddCookie(cookie)
		}
		if rangeHeader != "" {
			req.Header.Set("Range", rangeHeader)
		}
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		data, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		return response, string(data)
	}
	whole, data := fetch("")
	if whole.StatusCode != http.StatusOK || whole.Proto != "HTTP/2.0" || data != content {
		t.Errorf("whole file: status %d, proto %s, %d bytes", whole.StatusCode, whole.Proto, len(data))
	}
	part, data := fetch("bytes=5-14")
	if part.StatusCode != http.StatusPartialContent || data != content[5:15] {
		t.Errorf("range: status %d, body %q", part.StatusCode, data)
	}

	if err := r.stop(t); err != nil {
		t.Fatalf("run returned %v", err)
	}
	logs := r.logs.String()
	if strings.Contains(logs, "INSECURE") {
		t.Error("HTTPS mode printed the insecure warning")
	}
	if strings.Contains(logs, testPassword) {
		t.Error("logs contain the password")
	}
}

func TestHTTPSRefusesOldTLS(t *testing.T) {
	certPath, keyPath, pool := makeCert(t)
	r := start(t, append(dirArgs(t), "--tls-cert", certPath, "--tls-key", keyPath))
	conn, err := tls.Dial("tcp", r.addr, &tls.Config{RootCAs: pool, MaxVersion: tls.VersionTLS11, MinVersion: tls.VersionTLS10})
	if err == nil {
		conn.Close()
		t.Fatal("a TLS 1.1 handshake succeeded")
	}
	if err := r.stop(t); err != nil {
		t.Fatalf("run returned %v", err)
	}
}

func TestPlainHTTPOnHTTPSPortIsRefused(t *testing.T) {
	certPath, keyPath, _ := makeCert(t)
	r := start(t, append(dirArgs(t), "--tls-cert", certPath, "--tls-key", keyPath))
	resp, err := http.Get("http://" + r.addr + "/")
	if err == nil {
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("plain HTTP on the TLS port = %d", resp.StatusCode)
		}
	}
	if err := r.stop(t); err != nil {
		t.Fatalf("run returned %v", err)
	}
}

func TestInsecureDevWarnsLoudlyAndDropsSecure(t *testing.T) {
	r := start(t, append(dirArgs(t), "--insecure-dev"))
	client := &http.Client{Timeout: 10 * time.Second}

	resp := login(t, client, "http://"+r.addr)
	setCookie := resp.Header.Get("Set-Cookie")
	if strings.Contains(setCookie, "Secure") {
		t.Errorf("--insecure-dev kept Secure: %q", setCookie)
	}
	for _, attr := range []string{"HttpOnly", "SameSite=Strict", "Path=/"} {
		if !strings.Contains(setCookie, attr) {
			t.Errorf("Set-Cookie lacks %s: %q", attr, setCookie)
		}
	}
	logs := r.logs.String()
	for _, want := range []string{"WARNING: --insecure-dev IS SET", "INSECURE DEV MODE"} {
		if !strings.Contains(logs, want) {
			t.Errorf("logs lack %q", want)
		}
	}
	if strings.Contains(logs, "REACHABLE FROM OTHER MACHINES") {
		t.Error("a loopback address should not get the network warning")
	}
	if err := r.stop(t); err != nil {
		t.Fatalf("run returned %v", err)
	}
}

// This calls the warning code directly: actually binding every interface could
// raise a firewall prompt on the machine running the tests.
func TestInsecureDevOnAllInterfacesWarnsAboutTheNetwork(t *testing.T) {
	var output syncBuffer
	cfg := &config.Config{Listen: ":8443", InsecureDev: true}
	warnAboutSetup(cfg, slog.New(slog.NewJSONHandler(&output, nil)), &output)
	if !strings.Contains(output.String(), "REACHABLE FROM OTHER MACHINES") {
		t.Error("no warning for plain HTTP on a non-loopback address")
	}
}

func TestRefusesToStart(t *testing.T) {
	certPath, keyPath, _ := makeCert(t)
	cases := []struct {
		name   string
		args   []string
		env    map[string]string
		errHas string
	}{
		{"no TLS and no flag", dirArgs(t), map[string]string{"SITE_PASSWORD": testPassword}, "plain HTTP"},
		{"no password", append(dirArgs(t), "--insecure-dev"), nil, "SITE_PASSWORD"},
		{"blank password", append(dirArgs(t), "--insecure-dev"), map[string]string{"SITE_PASSWORD": "  "}, "SITE_PASSWORD"},
		{"missing cert file", append(dirArgs(t), "--tls-cert", certPath+".gone", "--tls-key", keyPath), map[string]string{"SITE_PASSWORD": testPassword}, "certificate"},
		{"key does not match", append(dirArgs(t), "--tls-cert", keyPath, "--tls-key", certPath), map[string]string{"SITE_PASSWORD": testPassword}, "certificate"},
		{"address in use", nil, map[string]string{"SITE_PASSWORD": testPassword}, "listening"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			args := tc.args
			if tc.name == "address in use" {
				occupied, err := net.Listen("tcp", "127.0.0.1:0")
				if err != nil {
					t.Fatal(err)
				}
				defer occupied.Close()
				args = append(dirArgs(t), "--insecure-dev", "--listen", occupied.Addr().String())
			}
			var output syncBuffer
			err := run(context.Background(), args, environment{
				getenv: func(key string) string { return tc.env[key] },
				stderr: &output,
			})
			if err == nil || !strings.Contains(err.Error(), tc.errHas) {
				t.Fatalf("err = %v, want it to mention %q", err, tc.errHas)
			}
			if strings.Contains(err.Error(), testPassword) || strings.Contains(output.String(), testPassword) {
				t.Error("the password appeared in the failure output")
			}
		})
	}
}

func TestReadsPasswordFromDotEnvAtRepoRoot(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	const dotEnvPassword = "fake-dotenv-password-for-main-tests"
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte("SITE_PASSWORD="+dotEnvPassword+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	addrs := make(chan string, 1)
	done := make(chan error, 1)
	logs := &syncBuffer{}
	args := append(dirArgs(t), "--insecure-dev")
	go func() {
		done <- run(ctx, args, environment{
			getenv:   func(string) string { return "" },
			workDir:  root,
			stderr:   logs,
			onListen: func(addr net.Addr) { addrs <- addr.String() },
		})
	}()
	var addr string
	select {
	case addr = <-addrs:
	case err := <-done:
		t.Fatalf("did not start: %v", err)
	}
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Post("http://"+addr+"/api/login", "application/json",
		strings.NewReader(`{"password":"`+dotEnvPassword+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("login = %d", resp.StatusCode)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("run returned %v", err)
	}
	if strings.Contains(logs.String(), dotEnvPassword) {
		t.Error("logs contain the password")
	}
}

func TestHelpIsNotAnError(t *testing.T) {
	var output syncBuffer
	err := run(context.Background(), []string{"--help"}, environment{
		getenv: func(string) string { return "" },
		stderr: &output,
	})
	if !errors.Is(err, flag.ErrHelp) {
		t.Fatalf("err = %v", err)
	}
	if !strings.Contains(output.String(), "insecure-dev") {
		t.Errorf("usage = %q", output.String())
	}
}

func TestMissingDirectoriesAreWarnedNotFatal(t *testing.T) {
	base := t.TempDir()
	r := start(t, []string{
		"--listen", "127.0.0.1:0", "--insecure-dev",
		"--asset-dir", filepath.Join(base, "no-assets"),
		"--web-dir", filepath.Join(base, "no-web"),
		"--engine-dir", filepath.Join(base, "no-engine"),
		"--crash-dir", filepath.Join(base, "crash"),
	})
	logs := r.logs.String()
	for _, name := range []string{"asset-dir", "web-dir", "engine-dir"} {
		if !strings.Contains(logs, name) {
			t.Errorf("no warning for %s", name)
		}
	}
	if err := r.stop(t); err != nil {
		t.Fatalf("run returned %v", err)
	}
}

// Graceful shutdown must let a request in flight finish. Expect: 100-continue
// proves the handler is running before shutdown starts, and the request body is
// only sent once the listener has closed.
func TestGracefulShutdownFinishesInFlightRequest(t *testing.T) {
	r := start(t, append(dirArgs(t), "--insecure-dev"))

	conn, err := net.DialTimeout("tcp", r.addr, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(30 * time.Second)); err != nil {
		t.Fatal(err)
	}
	body := `{"password":"` + testPassword + `"}`
	fmt.Fprintf(conn, "POST /api/login HTTP/1.1\r\nHost: test.invalid\r\nContent-Type: application/json\r\nExpect: 100-continue\r\nContent-Length: %d\r\n\r\n", len(body))

	reader := bufio.NewReader(conn)
	line, err := reader.ReadString('\n')
	if err != nil || !strings.Contains(line, "100") {
		t.Fatalf("waiting for 100 Continue: %q, %v", line, err)
	}
	for line != "\r\n" {
		if line, err = reader.ReadString('\n'); err != nil {
			t.Fatal(err)
		}
	}

	r.cancel()
	deadline := time.Now().Add(10 * time.Second)
	for {
		probe, err := net.DialTimeout("tcp", r.addr, time.Second)
		if err != nil {
			break
		}
		probe.Close()
		if time.Now().After(deadline) {
			t.Fatal("listener stayed open after shutdown began")
		}
		time.Sleep(10 * time.Millisecond)
	}
	select {
	case err := <-r.done:
		t.Fatalf("run returned before the in-flight request finished: %v", err)
	default:
	}

	if _, err := io.WriteString(conn, body); err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("in-flight login = %d, want 204", resp.StatusCode)
	}
	conn.Close()

	select {
	case err := <-r.done:
		if err != nil {
			t.Fatalf("run returned %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("run did not return after the last request finished")
	}
}

func TestServerLimitsAreSet(t *testing.T) {
	srv := newHTTPServer(http.NewServeMux(), slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if srv.ReadHeaderTimeout <= 0 || srv.ReadTimeout <= 0 || srv.IdleTimeout <= 0 {
		t.Errorf("timeouts: header %v, read %v, idle %v", srv.ReadHeaderTimeout, srv.ReadTimeout, srv.IdleTimeout)
	}
	if srv.MaxHeaderBytes <= 0 || srv.MaxHeaderBytes > 1<<20 {
		t.Errorf("MaxHeaderBytes = %d", srv.MaxHeaderBytes)
	}
	if !srv.DisableGeneralOptionsHandler {
		t.Error("the built-in OPTIONS * handler would skip the required headers")
	}
	if srv.ErrorLog == nil {
		t.Error("the server's error log must go through the structured logger")
	}
}

// "OPTIONS *" bypasses the handler by default and would answer with none of the
// required headers.
func TestOptionsStarCarriesRequiredHeaders(t *testing.T) {
	r := start(t, append(dirArgs(t), "--insecure-dev"))
	conn, err := net.DialTimeout("tcp", r.addr, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(conn, "OPTIONS * HTTP/1.1\r\nHost: test.invalid\r\nConnection: close\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	for _, name := range []string{"Cross-Origin-Opener-Policy", "Cross-Origin-Embedder-Policy", "Cross-Origin-Resource-Policy"} {
		if resp.Header.Get(name) == "" {
			t.Errorf("OPTIONS * lacks %s", name)
		}
	}
	if err := r.stop(t); err != nil {
		t.Fatalf("run returned %v", err)
	}
}
