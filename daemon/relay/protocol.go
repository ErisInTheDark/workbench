// No exports. Newline-delimited JSON messages exchanged with the daemon's sandbox relay broker.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
)

const (
	relayEnvKey     = "WB_RELAY"
	maxMessageBytes = 1 << 16
)

type relayConfig struct {
	Broker string `json:"broker"`
	Token  string `json:"token"`
}

type helloMessage struct {
	Type  string `json:"type"`
	Token string `json:"token"`
}

type portsMessage struct {
	Type  string `json:"type"`
	Ports []int  `json:"ports"`
}

type acceptMessage struct {
	Type  string `json:"type"`
	Token string `json:"token"`
	ID    string `json:"id"`
}

// brokerMessage is either hostPorts (Ports) or open (ID and Port).
type brokerMessage struct {
	Type  string
	Ports []int
	ID    string
	Port  int
}

func encodeMessage(message any) ([]byte, error) {
	line, err := json.Marshal(message)
	if err != nil {
		return nil, err
	}
	return append(line, '\n'), nil
}

func sandboxPortsMessage(ports map[int]struct{}) portsMessage {
	list := make([]int, 0, len(ports))
	for port := range ports {
		list = append(list, port)
	}
	sort.Ints(list)
	return portsMessage{Type: "sandboxPorts", Ports: list}
}

func parseBrokerMessage(line []byte) (brokerMessage, error) {
	var wire struct {
		Type  string  `json:"type"`
		Ports *[]int  `json:"ports"`
		ID    *string `json:"id"`
		Port  *int    `json:"port"`
	}
	if err := json.Unmarshal(line, &wire); err != nil {
		return brokerMessage{}, err
	}
	switch wire.Type {
	case "hostPorts":
		if wire.Ports == nil {
			return brokerMessage{}, errors.New("hostPorts message has no ports")
		}
		for _, port := range *wire.Ports {
			if !validPort(port) {
				return brokerMessage{}, fmt.Errorf("hostPorts message has invalid port %d", port)
			}
		}
		return brokerMessage{Type: wire.Type, Ports: *wire.Ports}, nil
	case "open":
		if wire.ID == nil || *wire.ID == "" || wire.Port == nil || !validPort(*wire.Port) {
			return brokerMessage{}, errors.New("open message needs an id and a valid port")
		}
		return brokerMessage{Type: wire.Type, ID: *wire.ID, Port: *wire.Port}, nil
	default:
		return brokerMessage{}, fmt.Errorf("unknown broker message type %q", wire.Type)
	}
}

func parseRelayConfig(text string) (relayConfig, error) {
	var config relayConfig
	if err := json.Unmarshal([]byte(text), &config); err != nil {
		return relayConfig{}, fmt.Errorf("%s is invalid: %w", relayEnvKey, err)
	}
	if config.Broker == "" || config.Token == "" {
		return relayConfig{}, fmt.Errorf("%s needs a broker and token", relayEnvKey)
	}
	return config, nil
}

func validPort(port int) bool {
	return port > 0 && port <= 65535
}
