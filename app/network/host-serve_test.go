// No exports. Verify foreground forwarding conflict handling and independent mapping preservation.
package main

import (
	"testing"

	"tailscale.com/ipn"
)

func TestHostServePreservesOtherOwnersAndUpdatesOwnTarget(t *testing.T) {
	other := &ipn.ServeConfig{TCP: map[uint16]*ipn.TCPPortHandler{9001: {TCPForward: "127.0.0.1:9002"}}}
	config := &ipn.ServeConfig{
		TCP:        map[uint16]*ipn.TCPPortHandler{443: {HTTPS: true}},
		Foreground: map[string]*ipn.ServeConfig{"other": other},
		ETag:       "concurrency-token",
	}
	if err := configureHostServe(config, "workbench", 8080, "127.0.0.1:4200"); err != nil {
		t.Fatal(err)
	}
	if config.TCP[443] == nil || config.Foreground["other"] != other || config.ETag != "concurrency-token" {
		t.Fatal("unrelated owner or concurrency guard was replaced")
	}
	if err := configureHostServe(config, "workbench", 8080, "127.0.0.1:4300"); err != nil {
		t.Fatal(err)
	}
	if config.Foreground["workbench"].TCP[8080].TCPForward != "127.0.0.1:4300" {
		t.Fatal("static forwarding did not follow the app's current port")
	}
}

func TestHostServeRejectsConflictsWithoutMutation(t *testing.T) {
	for _, foreground := range []bool{false, true} {
		config := &ipn.ServeConfig{}
		handler := &ipn.TCPPortHandler{HTTPS: true}
		if foreground {
			config.Foreground = map[string]*ipn.ServeConfig{"other": {TCP: map[uint16]*ipn.TCPPortHandler{443: handler}}}
		} else {
			config.TCP = map[uint16]*ipn.TCPPortHandler{443: handler}
		}
		if err := configureHostServe(config, "workbench", 443, "127.0.0.1:4300"); err == nil {
			t.Fatal("an occupied host-tailnet port was overwritten")
		}
		if config.Foreground["workbench"] != nil {
			t.Fatal("rejected configuration was partially installed")
		}
	}
}

func TestHostServeKeepsIndependentAppAndDaemonMappings(t *testing.T) {
	config := &ipn.ServeConfig{}
	if err := configureHostServe(config, "workbench", 8080, "127.0.0.1:4200"); err != nil {
		t.Fatal(err)
	}
	if err := configureHostServe(config, "workbench", 52739, "127.0.0.1:32123"); err != nil {
		t.Fatal(err)
	}
	if config.Foreground["workbench"].TCP[8080] == nil {
		t.Fatal("publishing the daemon removed the app's working mapping")
	}
	config.TCP = map[uint16]*ipn.TCPPortHandler{52739: {TCPForward: "127.0.0.1:9000"}}
	if err := configureHostServe(config, "workbench", 52739, "127.0.0.1:32124"); err == nil {
		t.Fatal("daemon publication took an unrelated mapping")
	}
	if config.Foreground["workbench"].TCP[8080] == nil {
		t.Fatal("daemon conflict disabled app forwarding")
	}
}
