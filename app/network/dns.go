// No exports. Answer DNS only for the current installation's exact private hostname.
package main

import (
	"net"
	"net/netip"
	"strings"

	"github.com/miekg/dns"
)

func dnsAnswer(host string, addresses []netip.Addr, query *dns.Msg, aliases ...string) *dns.Msg {
	answer := new(dns.Msg).SetReply(query)
	if len(query.Question) != 1 {
		answer.Rcode = dns.RcodeFormatError
		return answer
	}
	question := query.Question[0]
	matched := strings.EqualFold(question.Name, dns.Fqdn(host))
	for _, alias := range aliases {
		if strings.EqualFold(question.Name, dns.Fqdn(alias)) { matched = true; break }
	}
	if query.Opcode != dns.OpcodeQuery || question.Qclass != dns.ClassINET ||
		!matched {
		answer.Rcode = dns.RcodeRefused
		return answer
	}
	answer.Authoritative = true
	header := dns.RR_Header{Name: question.Name, Class: dns.ClassINET, Ttl: 30}
	for _, address := range addresses {
		if address.Is4() && question.Qtype == dns.TypeA {
			header.Rrtype = dns.TypeA
			answer.Answer = append(answer.Answer, &dns.A{Hdr: header, A: net.IP(address.AsSlice())})
		}
		if address.Is6() && question.Qtype == dns.TypeAAAA {
			header.Rrtype = dns.TypeAAAA
			answer.Answer = append(answer.Answer, &dns.AAAA{Hdr: header, AAAA: net.IP(address.AsSlice())})
		}
	}
	if len(answer.Answer) == 0 {
		answer.Ns = []dns.RR{&dns.SOA{
			Hdr: dns.RR_Header{Name: dns.Fqdn(host), Rrtype: dns.TypeSOA, Class: dns.ClassINET, Ttl: 30},
			Ns:  dns.Fqdn(host), Mbox: "hostmaster." + dns.Fqdn(host),
			Serial: 1, Refresh: 30, Retry: 30, Expire: 300, Minttl: 30,
		}}
	}
	return answer
}
