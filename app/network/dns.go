// No exports. Answer the private app directory and forward public misses without system DNS recursion.
package main

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"strings"

	"github.com/miekg/dns"
)

type directoryDNS struct {
	members func() []networkMember
	exchange func(context.Context, *dns.Msg, bool) (*dns.Msg, error)
}

func publicDNSExchange(ctx context.Context, query *dns.Msg, tcp bool) (*dns.Msg, error) {
	network := "udp"
	if tcp { network = "tcp" }
	// The DNS client's protocol exchange deadline bounds a single upstream attempt,
	// not application setup or enrolment. Failure becomes SERVFAIL, never NXDOMAIN.
	client := &dns.Client{Net: network}
	answer, _, err := client.ExchangeContext(ctx, query, "1.1.1.1:53")
	return answer, err
}

func (resolver directoryDNS) answer(ctx context.Context, query *dns.Msg, tcp bool) (*dns.Msg, error) {
	answer := new(dns.Msg).SetReply(query)
	if len(query.Question) != 1 {
		answer.Rcode = dns.RcodeFormatError
		return answer, nil
	}
	question := query.Question[0]
	name := strings.ToLower(dns.Fqdn(question.Name))
	if query.Opcode != dns.OpcodeQuery || question.Qclass != dns.ClassINET ||
		(name != "wb.inthedark.boo." && !strings.HasSuffix(name, ".wb.inthedark.boo.")) {
		answer.Rcode = dns.RcodeRefused
		return answer, nil
	}
	for _, member := range resolver.members() {
		if member.Published != nil && !*member.Published { continue }
		host, err := machineHostname(member.Label)
		if err != nil { return dnsFailure(query), errors.New("invalid app label in DNS directory") }
		names := []string{host}
		if member.Rename != nil {
			for _, label := range []string{member.Rename.From, member.Rename.To} {
				alias, err := machineHostname(label)
				if err != nil { return dnsFailure(query), errors.New("invalid reserved label in DNS directory") }
				names = append(names, alias)
			}
		}
		matched := false
		for _, candidate := range names {
			if name == dns.Fqdn(candidate) { matched = true; break }
		}
		if !matched { continue }
		addresses := make([]netip.Addr, 0, len(member.Addresses))
		for _, value := range member.Addresses {
			address, err := netip.ParseAddr(value)
			if err != nil || !tailnetAddress(address) {
				return dnsFailure(query), errors.New("invalid private address in DNS directory")
			}
			addresses = append(addresses, address)
		}
		return dnsAnswer(host, addresses, query, names...), nil
	}
	forwarded, err := resolver.exchange(ctx, query, tcp)
	if err == nil && forwarded != nil && forwarded.Truncated && !tcp {
		forwarded, err = resolver.exchange(ctx, query, true)
	}
	if err != nil || forwarded == nil {
		return dnsFailure(query), errors.New("public DNS upstream could not answer")
	}
	return forwarded, nil
}

func dnsFailure(query *dns.Msg) *dns.Msg {
	answer := new(dns.Msg).SetReply(query)
	answer.Rcode = dns.RcodeServerFailure
	return answer
}

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
