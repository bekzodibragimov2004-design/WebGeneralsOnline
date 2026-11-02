// Command relay serves the WebGeneralsOnline web app and game assets behind a
// shared password.
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"webgeneralsonline/relay/internal/config"
	"webgeneralsonline/relay/internal/server"
)

const (
	readHeaderTimeout = 10 * time.Second
	readTimeout       = 60 * time.Second // whole request, including its body
	idleTimeout       = 120 * time.Second
	maxHeaderBytes    = 64 << 10
	shutdownTimeout   = 20 * time.Second
)

const insecureBanner = `
################################################################
##  WARNING: --insecure-dev IS SET. SERVING PLAIN HTTP.       ##
##  The password and session cookie travel unencrypted, and   ##
##  the cookie has no Secure attribute. Localhost testing     ##
##  only. Never use this mode for real players.               ##
################################################################
`

// environment holds what run takes from the process, so tests can replace it and
// never touch a real .env file.
type environment struct {
	getenv   func(string) string
	workDir  string
	exeDir   string
	stderr   io.Writer
	onListen func(net.Addr) // called once the socket is open; may be nil
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	env := environment{getenv: os.Getenv, stderr: os.Stderr}
	if dir, err := os.Getwd(); err == nil {
		env.workDir = dir
	}
	if exe, err := os.Executable(); err == nil {
		env.exeDir = filepath.Dir(exe)
	}

	err := run(ctx, os.Args[1:], env)
	switch {
	case err == nil:
	case errors.Is(err, flag.ErrHelp):
	default:
		fmt.Fprintln(os.Stderr, "relay:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, env environment) error {
	cfg, err := config.Load(args, config.Sources{
		Getenv:  env.getenv,
		WorkDir: env.workDir,
		ExeDir:  env.exeDir,
		Output:  env.stderr,
	})
	if err != nil {
		return err
	}

	log := slog.New(slog.NewJSONHandler(env.stderr, nil))

	handler, err := server.New(server.Options{
		Password:    string(cfg.SitePassword),
		InsecureDev: cfg.InsecureDev,
		AssetDir:    cfg.AssetDir,
		WebDir:      cfg.WebDir,
		EngineDir:   cfg.EngineDir,
		CrashDir:    cfg.CrashDir,
		Logger:      log,
	})
	if err != nil {
		return err
	}

	httpServer := newHTTPServer(handler, log)
	if cfg.UsesTLS() {
		cert, err := tls.LoadX509KeyPair(cfg.TLSCert, cfg.TLSKey)
		if err != nil {
			return fmt.Errorf("loading TLS certificate: %w", err)
		}
		httpServer.TLSConfig = &tls.Config{
			Certificates: []tls.Certificate{cert},
			MinVersion:   tls.VersionTLS12,
		}
	}

	listener, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		return fmt.Errorf("listening: %w", err)
	}
	defer listener.Close()

	warnAboutSetup(cfg, log, env.stderr)
	log.Info("listening", "addr", listener.Addr().String(), "tls", cfg.UsesTLS())
	if env.onListen != nil {
		env.onListen(listener.Addr())
	}

	serveErr := make(chan error, 1)
	go func() {
		if cfg.UsesTLS() {
			serveErr <- httpServer.ServeTLS(listener, "", "")
			return
		}
		serveErr <- httpServer.Serve(listener)
	}()

	select {
	case err := <-serveErr:
		return fmt.Errorf("serving: %w", err)
	case <-ctx.Done():
	}

	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		_ = httpServer.Close()
		return fmt.Errorf("graceful shutdown: %w", err)
	}
	<-serveErr
	log.Info("stopped")
	return nil
}

// newHTTPServer sets the connection-level limits. There is no WriteTimeout here,
// since it would cut off a large download: the handler applies a rolling write
// deadline instead.
func newHTTPServer(handler http.Handler, log *slog.Logger) *http.Server {
	return &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    maxHeaderBytes,
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelWarn),
		// The built-in "OPTIONS *" handler would answer without the required
		// cross-origin headers.
		DisableGeneralOptionsHandler: true,
	}
}

func warnAboutSetup(cfg *config.Config, log *slog.Logger, stderr io.Writer) {
	if cfg.InsecureDev {
		_, _ = io.WriteString(stderr, insecureBanner)
		log.Warn("INSECURE DEV MODE: serving plain HTTP, the session cookie is not Secure")
		if !cfg.ListenIsLoopback() {
			log.Warn("INSECURE DEV MODE IS REACHABLE FROM OTHER MACHINES: the password can be read on the network", "addr", cfg.Listen)
		}
	}
	// Other tools build these directories, and they are looked up per request,
	// so a missing one takes effect as soon as it appears.
	for _, dir := range []struct{ name, path string }{
		{"asset-dir", cfg.AssetDir},
		{"web-dir", cfg.WebDir},
		{"engine-dir", cfg.EngineDir},
	} {
		if info, err := os.Stat(dir.path); err != nil || !info.IsDir() {
			log.Warn("directory is not available yet, its routes will answer 404", "setting", dir.name, "path", dir.path)
		}
	}
}
