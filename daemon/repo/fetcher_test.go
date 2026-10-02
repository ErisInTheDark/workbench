package main

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"
)

type manualFetcher struct {
	fetcher   *blobFetcher
	scheduled []func()
	calls     [][]string
	gate      chan struct{}
	failure   error
}

func newManualFetcher() *manualFetcher {
	manual := &manualFetcher{}
	manual.fetcher = newBlobFetcher(func(_ context.Context, oids []string) error {
		manual.calls = append(manual.calls, slices.Clone(oids))
		if manual.gate != nil {
			<-manual.gate
		}
		return manual.failure
	})
	manual.fetcher.afterFunc = func(_ time.Duration, run func()) { manual.scheduled = append(manual.scheduled, run) }
	return manual
}

func (manual *manualFetcher) enqueue(t *testing.T, oids ...string) *fetchWaiter {
	t.Helper()
	waiter, err := manual.fetcher.enqueue(oids)
	if err != nil {
		t.Fatal(err)
	}
	return waiter
}

func TestFetcherCoalescesConcurrentMissesIntoOneFetch(t *testing.T) {
	manual := newManualFetcher()
	waiters := []*fetchWaiter{
		manual.enqueue(t, "a", "b"), manual.enqueue(t, "b", "c"), manual.enqueue(t, "a"), manual.enqueue(t, "d"),
	}
	if len(manual.scheduled) != 1 {
		t.Fatalf("expected one scheduled flush, got %d", len(manual.scheduled))
	}
	manual.scheduled[0]()
	if len(manual.calls) != 1 || !slices.Equal(manual.calls[0], []string{"a", "b", "c", "d"}) {
		t.Fatalf("expected one fetch of unique oids, got %v", manual.calls)
	}
	for _, waiter := range waiters {
		if err := <-waiter.done; err != nil {
			t.Fatal(err)
		}
	}
}

func TestFetcherQueuesMissesArrivingDuringAFetchForTheNextBatch(t *testing.T) {
	manual := newManualFetcher()
	manual.gate = make(chan struct{})
	first := manual.enqueue(t, "a")
	finished := make(chan struct{})
	go func() { manual.scheduled[0](); close(finished) }()
	// The first fetch is now blocked on the gate; wait for it to have started.
	for {
		manual.fetcher.mu.Lock()
		running := manual.fetcher.running
		manual.fetcher.mu.Unlock()
		if running {
			break
		}
	}
	second := manual.enqueue(t, "b")
	manual.fetcher.mu.Lock()
	scheduledDuringFetch := manual.fetcher.scheduled
	manual.fetcher.mu.Unlock()
	if scheduledDuringFetch {
		t.Fatal("a second fetch was scheduled while one was running")
	}
	close(manual.gate)
	<-finished
	if err := <-first.done; err != nil {
		t.Fatal(err)
	}
	if len(manual.scheduled) != 2 {
		t.Fatalf("expected the queued miss to schedule after the fetch ended, got %d schedules", len(manual.scheduled))
	}
	manual.scheduled[1]()
	if err := <-second.done; err != nil {
		t.Fatal(err)
	}
	if len(manual.calls) != 2 || !slices.Equal(manual.calls[1], []string{"b"}) {
		t.Fatalf("unexpected fetches %v", manual.calls)
	}
}

func TestFetcherDeliversFailureToEveryWaiter(t *testing.T) {
	manual := newManualFetcher()
	manual.failure = errors.New("remote unavailable")
	first, second := manual.enqueue(t, "a"), manual.enqueue(t, "b")
	manual.scheduled[0]()
	if !errors.Is(<-first.done, manual.failure) || !errors.Is(<-second.done, manual.failure) {
		t.Fatal("every waiter in the batch should receive the fetch failure")
	}
}

func TestFetcherCloseReleasesQueuedWaiters(t *testing.T) {
	manual := newManualFetcher()
	waiter := manual.enqueue(t, "a")
	manual.fetcher.close()
	if !errors.Is(<-waiter.done, errFetcherClosed) {
		t.Fatal("queued waiters should be released when the fetcher closes")
	}
	if _, err := manual.fetcher.enqueue([]string{"b"}); !errors.Is(err, errFetcherClosed) {
		t.Fatal("a closed fetcher should refuse new work")
	}
}
