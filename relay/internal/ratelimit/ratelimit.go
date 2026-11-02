// Package ratelimit is a per-key limiter with exponential backoff and a fixed
// upper bound on memory.
package ratelimit

import (
	"container/list"
	"sync"
	"time"
)

// Options configures a Limiter.
type Options struct {
	// MaxKeys bounds the table. The least recently seen key is evicted when a
	// new key would exceed it.
	MaxKeys int
	// Free is the number of attempts allowed before any delay applies.
	Free int
	// BaseDelay is the delay after attempt number Free. It doubles with every
	// further attempt, up to MaxDelay.
	BaseDelay time.Duration
	MaxDelay  time.Duration
	// ForgetAfter drops a key's history once this long has passed since its
	// last counted attempt. It is raised to MaxDelay if lower.
	ForgetAfter time.Duration
	// Now is the clock. It defaults to time.Now.
	Now func() time.Time
}

// Limiter tracks attempts per key. It is safe for concurrent use.
type Limiter struct {
	opts Options

	mu      sync.Mutex
	entries map[string]*list.Element
	lru     *list.List // front is most recently seen
}

type entry struct {
	key          string
	attempts     int
	blockedUntil time.Time
	lastAttempt  time.Time
}

// New returns a Limiter, correcting any out-of-range options.
func New(opts Options) *Limiter {
	if opts.MaxKeys < 1 {
		opts.MaxKeys = 1
	}
	if opts.Free < 1 {
		opts.Free = 1
	}
	if opts.BaseDelay <= 0 {
		opts.BaseDelay = time.Second
	}
	if opts.MaxDelay < opts.BaseDelay {
		opts.MaxDelay = opts.BaseDelay
	}
	if opts.ForgetAfter < opts.MaxDelay {
		opts.ForgetAfter = opts.MaxDelay
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Limiter{
		opts:    opts,
		entries: make(map[string]*list.Element),
		lru:     list.New(),
	}
}

// Allow atomically decides and records an attempt. When it returns false the
// attempt was not counted, and the duration says how long the key must wait.
//
// The attempt is counted before its outcome is known so that concurrent
// requests cannot all slip through before the first failure is recorded. Call
// Reset when an attempt succeeds.
func (l *Limiter) Allow(key string) (bool, time.Duration) {
	now := l.opts.Now()

	l.mu.Lock()
	defer l.mu.Unlock()

	l.pruneExpired(now)
	e := l.lookup(key, now)
	if now.Before(e.blockedUntil) {
		return false, e.blockedUntil.Sub(now)
	}

	e.attempts++
	e.lastAttempt = now
	if e.attempts >= l.opts.Free {
		e.blockedUntil = now.Add(l.delay(e.attempts))
	}
	return true, 0
}

// Reset forgets a key.
func (l *Limiter) Reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if el, ok := l.entries[key]; ok {
		l.remove(el)
	}
}

// Len reports how many keys are currently held.
func (l *Limiter) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.lru.Len()
}

func (l *Limiter) delay(attempts int) time.Duration {
	d := l.opts.BaseDelay
	for i := l.opts.Free; i < attempts && d < l.opts.MaxDelay; i++ {
		d *= 2
	}
	return min(d, l.opts.MaxDelay)
}

func (l *Limiter) lookup(key string, now time.Time) *entry {
	if el, ok := l.entries[key]; ok {
		l.lru.MoveToFront(el)
		e := el.Value.(*entry)
		if l.expired(e, now) {
			e.attempts = 0
		}
		return e
	}
	for l.lru.Len() >= l.opts.MaxKeys {
		l.remove(l.lru.Back())
	}
	e := &entry{key: key}
	l.entries[key] = l.lru.PushFront(e)
	return e
}

func (l *Limiter) expired(e *entry, now time.Time) bool {
	return !now.Before(e.blockedUntil) && now.Sub(e.lastAttempt) >= l.opts.ForgetAfter
}

func (l *Limiter) pruneExpired(now time.Time) {
	for el := l.lru.Back(); el != nil && l.expired(el.Value.(*entry), now); el = l.lru.Back() {
		l.remove(el)
	}
}

func (l *Limiter) remove(el *list.Element) {
	delete(l.entries, el.Value.(*entry).key)
	l.lru.Remove(el)
}
