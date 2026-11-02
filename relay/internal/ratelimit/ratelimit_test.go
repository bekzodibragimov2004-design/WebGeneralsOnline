package ratelimit

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type clock struct{ t time.Time }

func (c *clock) now() time.Time          { return c.t }
func (c *clock) advance(d time.Duration) { c.t = c.t.Add(d) }

func newTestLimiter(c *clock) *Limiter {
	return New(Options{
		MaxKeys:     100,
		Free:        3,
		BaseDelay:   time.Second,
		MaxDelay:    8 * time.Second,
		ForgetAfter: time.Minute,
		Now:         c.now,
	})
}

func TestBackoffDoublesUpToCap(t *testing.T) {
	c := &clock{t: time.Unix(1000, 0)}
	l := newTestLimiter(c)

	for i := range 3 {
		if ok, _ := l.Allow("a"); !ok {
			t.Fatalf("free attempt %d was refused", i+1)
		}
	}
	for _, want := range []time.Duration{1, 2, 4, 8, 8, 8} {
		want *= time.Second
		ok, wait := l.Allow("a")
		if ok {
			t.Fatalf("attempt allowed while a %v block was due", want)
		}
		if wait != want {
			t.Fatalf("wait = %v, want %v", wait, want)
		}
		c.advance(want - time.Nanosecond)
		if ok, _ := l.Allow("a"); ok {
			t.Fatalf("attempt allowed just before the %v block ended", want)
		}
		c.advance(time.Nanosecond)
		if ok, _ := l.Allow("a"); !ok {
			t.Fatalf("attempt refused after the %v block ended", want)
		}
	}
}

func TestDelayCannotOverflow(t *testing.T) {
	l := New(Options{Free: 1, BaseDelay: time.Hour, MaxDelay: 1 << 62})
	for _, attempts := range []int{1, 2, 64, 1 << 20} {
		if d := l.delay(attempts); d <= 0 || d > 1<<62 {
			t.Fatalf("delay(%d) = %v", attempts, d)
		}
	}
}

func TestKeysAreIndependent(t *testing.T) {
	c := &clock{t: time.Unix(1000, 0)}
	l := newTestLimiter(c)
	for range 3 {
		l.Allow("a")
	}
	if ok, _ := l.Allow("a"); ok {
		t.Fatal("key a should be blocked")
	}
	if ok, _ := l.Allow("b"); !ok {
		t.Fatal("key b should not be affected by key a")
	}
}

func TestResetClearsBlock(t *testing.T) {
	c := &clock{t: time.Unix(1000, 0)}
	l := newTestLimiter(c)
	for range 3 {
		l.Allow("a")
	}
	l.Reset("a")
	if ok, _ := l.Allow("a"); !ok {
		t.Fatal("reset key should be allowed")
	}
	if got := l.Len(); got != 1 {
		t.Fatalf("Len = %d, want 1", got)
	}
}

func TestHistoryIsForgottenAfterQuietPeriod(t *testing.T) {
	c := &clock{t: time.Unix(1000, 0)}
	l := newTestLimiter(c)
	for range 3 {
		l.Allow("a")
	}
	c.advance(time.Minute)
	for i := range 3 {
		if ok, _ := l.Allow("a"); !ok {
			t.Fatalf("attempt %d refused after history should have expired", i+1)
		}
	}
}

func TestExpiredKeysAreReleased(t *testing.T) {
	c := &clock{t: time.Unix(1000, 0)}
	l := newTestLimiter(c)
	for i := range 50 {
		l.Allow(fmt.Sprintf("key-%d", i))
	}
	c.advance(time.Minute)
	l.Allow("fresh")
	if got := l.Len(); got != 1 {
		t.Fatalf("Len = %d, want 1 once old keys expired", got)
	}
}

func TestMemoryIsBounded(t *testing.T) {
	c := &clock{t: time.Unix(1000, 0)}
	l := New(Options{MaxKeys: 1000, Free: 2, BaseDelay: time.Second, MaxDelay: time.Hour, ForgetAfter: time.Hour, Now: c.now})
	for i := range 100_000 {
		l.Allow(fmt.Sprintf("flood-%d", i))
		if got := l.Len(); got > 1000 {
			t.Fatalf("table grew to %d keys", got)
		}
	}
	if len(l.entries) != l.lru.Len() {
		t.Fatalf("map has %d keys, list has %d", len(l.entries), l.lru.Len())
	}
}

func TestLeastRecentlySeenIsEvictedFirst(t *testing.T) {
	c := &clock{t: time.Unix(1000, 0)}
	l := New(Options{MaxKeys: 2, Free: 1, BaseDelay: time.Hour, MaxDelay: time.Hour, ForgetAfter: time.Hour, Now: c.now})
	l.Allow("blocked")
	l.Allow("other")
	l.Allow("blocked") // refused, but keeps the key recently seen
	l.Allow("third")   // evicts "other"
	if ok, _ := l.Allow("blocked"); ok {
		t.Fatal("an active blocked key must not be evicted ahead of an idle one")
	}
}

func TestConcurrentAttemptsCannotExceedFree(t *testing.T) {
	c := &clock{t: time.Unix(1000, 0)}
	l := New(Options{MaxKeys: 10, Free: 5, BaseDelay: time.Hour, MaxDelay: time.Hour, ForgetAfter: time.Hour, Now: c.now})
	var allowed atomic.Int64
	var wg sync.WaitGroup
	for range 200 {
		wg.Go(func() {
			if ok, _ := l.Allow("a"); ok {
				allowed.Add(1)
			}
		})
	}
	wg.Wait()
	if got := allowed.Load(); got != 5 {
		t.Fatalf("allowed %d concurrent attempts, want 5", got)
	}
}
