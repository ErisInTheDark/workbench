// No exports. Protect exact-name ownership, address families and negative DNS responses.
package main

import (
	"net/netip"
	"testing"

	"github.com/miekg/dns"
)

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
