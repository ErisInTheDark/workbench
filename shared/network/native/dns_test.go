// No exports. Protect exact-name ownership, address families and negative DNS responses.
package main

import (
	"context"
	"errors"
	"net/netip"
	"testing"

	"github.com/miekg/dns"
)

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
	for _, name := range []string{"NAS.wb.inthedark.boo.", "desktop.wb.inthedark.boo."} {
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
	for _, name := range []string{"wb.inthedark.boo.", "docs.wb.inthedark.boo."} {
		answer, err := resolver.answer(context.Background(), new(dns.Msg).SetQuestion(name, dns.TypeA), false)
		if err != nil || answer.Truncated || answer.Authoritative { t.Fatalf("public fallback failed: %v %v", answer, err) }
	}
	if forwards != 4 { t.Fatal("truncated public responses must retry using TCP") }
	answer, err = resolver.answer(context.Background(), new(dns.Msg).SetQuestion("failed.wb.inthedark.boo.", dns.TypeA), false)
	if err == nil || answer.Rcode != dns.RcodeServerFailure { t.Fatal("upstream failure must not become a negative answer") }
	answer, err = resolver.answer(context.Background(), new(dns.Msg).SetQuestion("example.com.", dns.TypeA), false)
	if err != nil || answer.Rcode != dns.RcodeRefused { t.Fatal("private DNS must not become an unrestricted resolver") }
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
