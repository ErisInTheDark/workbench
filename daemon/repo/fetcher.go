// No exports. Own blob fetch coalescing: concurrent misses inside one short window share one git fetch.
package main

import (
	"context"
	"errors"
	"sync"
	"time"
)

// blobFetchWindow only gathers concurrent misses (a directory listing, a parallel
// search); it is a coalescing delay, not a deadline on the fetch itself.
const blobFetchWindow = 10 * time.Millisecond

type fetchWaiter struct {
	oids []string
	done chan error
}

// blobFetcher runs at most one fetch at a time. Misses arriving while a fetch
// runs queue for the next batch, which is scheduled when the current one ends.
type blobFetcher struct {
	fetch    func(context.Context, []string) error
	afterFunc func(time.Duration, func())
	ctx      context.Context
	cancel   context.CancelFunc
	mu       sync.Mutex
	queue    []*fetchWaiter
	scheduled bool
	running  bool
	closed   bool
}

var errFetcherClosed = errors.New("repository cache is closing")

func newBlobFetcher(fetch func(context.Context, []string) error) *blobFetcher {
	ctx, cancel := context.WithCancel(context.Background())
	return &blobFetcher{
		fetch:     fetch,
		afterFunc: func(delay time.Duration, run func()) { time.AfterFunc(delay, run) },
		ctx:       ctx,
		cancel:    cancel,
	}
}

func (fetcher *blobFetcher) ensure(ctx context.Context, oids []string) error {
	waiter, err := fetcher.enqueue(oids)
	if err != nil {
		return err
	}
	select {
	case err := <-waiter.done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (fetcher *blobFetcher) enqueue(oids []string) (*fetchWaiter, error) {
	waiter := &fetchWaiter{oids: oids, done: make(chan error, 1)}
	fetcher.mu.Lock()
	defer fetcher.mu.Unlock()
	if fetcher.closed {
		return nil, errFetcherClosed
	}
	fetcher.queue = append(fetcher.queue, waiter)
	fetcher.scheduleLocked()
	return waiter, nil
}

func (fetcher *blobFetcher) scheduleLocked() {
	if fetcher.scheduled || fetcher.running || len(fetcher.queue) == 0 {
		return
	}
	fetcher.scheduled = true
	fetcher.afterFunc(blobFetchWindow, fetcher.flush)
}

func (fetcher *blobFetcher) flush() {
	fetcher.mu.Lock()
	fetcher.scheduled = false
	batch := fetcher.queue
	fetcher.queue = nil
	fetcher.running = len(batch) > 0
	fetcher.mu.Unlock()
	if len(batch) == 0 {
		return
	}
	seen := make(map[string]bool)
	var oids []string
	for _, waiter := range batch {
		for _, oid := range waiter.oids {
			if !seen[oid] {
				seen[oid] = true
				oids = append(oids, oid)
			}
		}
	}
	err := fetcher.fetch(fetcher.ctx, oids)
	fetcher.mu.Lock()
	fetcher.running = false
	fetcher.scheduleLocked()
	fetcher.mu.Unlock()
	for _, waiter := range batch {
		waiter.done <- err
	}
}

func (fetcher *blobFetcher) close() {
	fetcher.mu.Lock()
	fetcher.closed = true
	queued := fetcher.queue
	fetcher.queue = nil
	fetcher.mu.Unlock()
	fetcher.cancel()
	for _, waiter := range queued {
		waiter.done <- errFetcherClosed
	}
}
