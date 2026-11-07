// No exports. Protect offline directory answers, pre-join name ownership, address families, negative responses, and
// reading the tailnet's private nameservers with their reachability.
package main

import (
	"context"
	"errors"
	"net/netip"
	"reflect"
	"testing"

	"github.com/miekg/dns"
	"tailscale.com/tailcfg"
	"tailscale.com/types/dnstype"
	"tailscale.com/types/netmap"
)

func TestPrivateDNSRoute(t *testing.T) {
	node := func(address string, online *bool) tailcfg.NodeView {
		return (&tailcfg.Node{Addresses: []netip.Prefix{netip.MustParsePrefix(address + "/32")}, Online: online}).View()
	}
	yes, no := true, false
	network := &netmap.NetworkMap{
		SelfNode: node("100.64.0.1", nil),
		Peers: []tailcfg.NodeView{node("100.64.0.2", &no), node("100.64.0.3", &yes), node("100.64.0.4", nil)},
		DNS: tailcfg.DNSConfig{Routes: map[string][]*dnstype.Resolver{
			"ts.net.": {{Addr: "199.247.155.53"}},
			"wb.inthedark.boo.": {{Addr: "100.64.0.2"}, {Addr: "100.64.0.3:53"}, {Addr: "https://100.64.0.1/dns-query"}, {Addr: "100.64.0.4"}, {Addr: "100.64.0.9"}, {Addr: "100.64.0.2"}, nil},
		}},
	}
	got := privateDNSRoute(network)
	want := &tailnetDNS{Nameservers: []tailnetNameserver{
		{Address: "100.64.0.1", Online: &yes}, {Address: "100.64.0.2", Online: &no}, {Address: "100.64.0.3", Online: &yes},
		{Address: "100.64.0.4", Online: &no}, {Address: "100.64.0.9", Online: nil},
	}}
	if !reflect.DeepEqual(got, want) { t.Fatalf("route = %+v, want %+v", got, want) }
	if got := privateDNSRoute(&netmap.NetworkMap{DNS: tailcfg.DNSConfig{Routes: map[string][]*dnstype.Resolver{"WB.INTHEDARK.BOO": {{Addr: "[fd7a::1]:53"}}}}}); len(got.Nameservers) != 1 || got.Nameservers[0].Address != "fd7a::1" || got.Nameservers[0].Online != nil {
		t.Fatalf("undotted route = %+v", got)
	}
	if got := privateDNSRoute(&netmap.NetworkMap{}); got == nil || len(got.Nameservers) != 0 { t.Fatalf("missing route = %+v", got) }
	if privateDNSRoute(nil) != nil { t.Fatal("no netmap must report nothing") }
}

func TestDirectoryDNS(t *testing.T) {
	members := []networkMember{
		{NodeID: "nas", Label: "nas", Addresses: []string{"100.64.0.9"}},
		{NodeID: "desktop", Label: "desktop", Addresses: []string{"100.64.0.8"}},
	}
	forwards := 0
	resolver := directoryDNS{
		members: func() []networkMember { return members },
		exchange: func(_ context.Context, query *dns.Msg, tcp bool) (*dns.Msg, error) {
			forwards++
			if query.Question[0].Name == "failed.wb.inthedark.boo." { return nil, errors.New("upstream failed") }
			answer := new(dns.Msg).SetReply(query)
			answer.Truncated = !tcp
			return answer, nil
		},
	}
	for _, name := range []string{"NAS.wb.inthedark.boo.", "desktop.wb.inthedark.boo.", "verify.desktop.wb.inthedark.boo."} {
		answer, err := resolver.answer(context.Background(), new(dns.Msg).SetQuestion(name, dns.TypeA), false)
		if err != nil || !answer.Authoritative || len(answer.Answer) != 1 { t.Fatalf("directory answer failed: %v %v", answer, err) }
	}
	if forwards != 0 { t.Fatal("known app leaked to public DNS") }
	hidden := false
	members[0].Published = &hidden
	answer, err := resolver.answer(context.Background(), new(dns.Msg).SetQuestion("nas.wb.inthedark.boo.", dns.TypeA), false)
	if err != nil || answer.Authoritative || forwards != 2 { t.Fatal("explicitly removed address remained in private DNS") }
	members[0].Published = nil
	forwards = 0
	for _, name := range []string{"wb.inthedark.boo.", "docs.wb.inthedark.boo.", "child.desktop.wb.inthedark.boo."} {
		answer, err := resolver.answer(context.Background(), new(dns.Msg).SetQuestion(name, dns.TypeA), false)
		if err != nil || answer.Truncated || answer.Authoritative { t.Fatalf("public fallback failed: %v %v", answer, err) }
	}
	if forwards != 6 { t.Fatal("truncated public responses must retry using TCP") }
	answer, err = resolver.answer(context.Background(), new(dns.Msg).SetQuestion("failed.wb.inthedark.boo.", dns.TypeA), false)
	if err == nil || answer.Rcode != dns.RcodeServerFailure { t.Fatal("upstream failure must not become a negative answer") }
	answer, err = resolver.answer(context.Background(), new(dns.Msg).SetQuestion("example.com.", dns.TypeA), false)
	if err != nil || answer.Rcode != dns.RcodeRefused { t.Fatal("private DNS must not become an unrestricted resolver") }
}

func TestEveryMemberAnswersTheSavedDirectoryWithoutItsOwner(t *testing.T) {
	directory := directoryFixture()
	for _, responder := range directory.Members {
		presentation := &privatePresentation{hostname: responder.Label+".wb.inthedark.boo"}
		for _, member := range directory.Members {
			for _, tcp := range []bool{false, true} {
				query := new(dns.Msg).SetQuestion(member.Label+".wb.inthedark.boo.", dns.TypeA)
				answer, err := answerPrivateDNS(context.Background(), presentation, nil, &directory, query, tcp)
				if err != nil || answer.Rcode != dns.RcodeSuccess || !answer.Authoritative || len(answer.Answer) != 1 {
					t.Fatalf("could not answer %s from the saved directory: %v %v", member.Label, answer, err)
				}
			}
		}
	}
}

func TestPrivateDNSBeforeJoiningAnswersOnlyItsOwnNames(t *testing.T) {
	presentation := &privatePresentation{hostname: "desktop.wb.inthedark.boo", names: []string{"previous.wb.inthedark.boo"}}
	addresses := []netip.Addr{netip.MustParseAddr("100.80.0.1")}
	for _, name := range []string{presentation.hostname, presentation.names[0], trustProbeHostname(presentation.hostname)} {
		answer, err := answerPrivateDNS(context.Background(), presentation, addresses, nil, new(dns.Msg).SetQuestion(name+".", dns.TypeA), false)
		if err != nil || !answer.Authoritative || len(answer.Answer) != 1 { t.Fatalf("own name was not answered before joining: %v %v", answer, err) }
	}
	answer, err := answerPrivateDNS(context.Background(), presentation, addresses, nil, new(dns.Msg).SetQuestion("nas.wb.inthedark.boo.", dns.TypeA), false)
	if err != nil || answer.Rcode != dns.RcodeRefused { t.Fatalf("answered a different member before joining: %v %v", answer, err) }
}

func TestDNSOwnership(t *testing.T) {
	host := "desktop.wb.inthedark.boo"
	addresses := []netip.Addr{netip.MustParseAddr("100.64.0.8"), netip.MustParseAddr("fd7a:115c:a1e0::8")}
	for _, recordType := range []uint16{dns.TypeA, dns.TypeAAAA} {
		query := new(dns.Msg).SetQuestion("DESKTOP.wb.inthedark.boo.", recordType)
		answer := dnsAnswer(host, addresses, query)
		if answer.Rcode != dns.RcodeSuccess || len(answer.Answer) != 1 || !answer.Authoritative || answer.Id != query.Id {
			t.Fatalf("own address query was not answered: %v", answer)
		}
	}
	for _, name := range []string{"wb.inthedark.boo.", "other.wb.inthedark.boo.", "child.desktop.wb.inthedark.boo."} {
		answer := dnsAnswer(host, addresses, new(dns.Msg).SetQuestion(name, dns.TypeA))
		if answer.Rcode != dns.RcodeRefused || len(answer.Answer) != 0 {
			t.Fatalf("answered another owner's name: %v", answer)
		}
	}
}

func TestDNSNoData(t *testing.T) {
	query := new(dns.Msg).SetQuestion("desktop.wb.inthedark.boo.", dns.TypeAAAA)
	answer := dnsAnswer("desktop.wb.inthedark.boo", []netip.Addr{netip.MustParseAddr("100.64.0.8")}, query)
	if answer.Rcode != dns.RcodeSuccess || len(answer.Answer) != 0 || len(answer.Ns) != 1 {
		t.Fatalf("absent address family must be authoritative NODATA: %v", answer)
	}
	query.Question = append(query.Question, query.Question[0])
	if answer := dnsAnswer("desktop.wb.inthedark.boo", nil, query); answer.Rcode != dns.RcodeFormatError {
		t.Fatal("accepted ambiguous multi-question request")
	}
}
