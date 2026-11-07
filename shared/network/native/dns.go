// No exports. Own private DNS query policy, saved directory answers, public-miss forwarding, and the tailnet's
// configured nameservers for the private suffix.
package main

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"net/url"
	"slices"
	"strings"

	"github.com/miekg/dns"
	"tailscale.com/types/netmap"
)

type tailnetNameserver struct {
	Address string `json:"address"`
	// Nil when no tailnet node owns the address, so its reachability is unknown.
	Online *bool `json:"online"`
}

type tailnetDNS struct {
	Nameservers []tailnetNameserver `json:"nameservers"`
}

// privateDNSRoute reads the split-DNS nameservers the tailnet sends private names to, as every client sees them.
func privateDNSRoute(network *netmap.NetworkMap) *tailnetDNS {
	if network == nil { return nil }
	online := map[netip.Addr]bool{}
	if network.SelfNode.Valid() {
		for _, prefix := range network.SelfNode.Addresses().All() { online[prefix.Addr()] = true }
	}
	for _, peer := range network.Peers {
		state, known := peer.Online().GetOk()
		for _, prefix := range peer.Addresses().All() { online[prefix.Addr()] = known && state }
	}
	route := tailnetDNS{Nameservers: []tailnetNameserver{}}
	for suffix, resolvers := range network.DNS.Routes {
		if !strings.EqualFold(strings.TrimSuffix(suffix, "."), "wb.inthedark.boo") { continue }
		for _, resolver := range resolvers {
			if resolver == nil { continue }
			address := resolverHost(resolver.Addr)
			if address == "" || slices.ContainsFunc(route.Nameservers, func(item tailnetNameserver) bool { return item.Address == address }) { continue }
			entry := tailnetNameserver{Address: address}
			if parsed, err := netip.ParseAddr(address); err == nil {
				if state, known := online[parsed]; known { entry.Online = &state }
			}
			route.Nameservers = append(route.Nameservers, entry)
		}
	}
	slices.SortFunc(route.Nameservers, func(left, right tailnetNameserver) int { return strings.Compare(left.Address, right.Address) })
	return &route
}

// resolverHost reduces a resolver address (`ip`, `ip:port`, `[ip]:port` or a URL) to its host.
func resolverHost(value string) string {
	value = strings.TrimSpace(value)
	if parsed, err := url.Parse(value); err == nil && parsed.Scheme != "" && parsed.Host != "" { return parsed.Hostname() }
	if host, _, err := net.SplitHostPort(value); err == nil { return host }
	return strings.Trim(value, "[]")
}

type directoryDNS struct {
	members func() []networkMember
	exchange func(context.Context, *dns.Msg, bool) (*dns.Msg, error)
}

func answerPrivateDNS(ctx context.Context, presentation *privatePresentation, addresses []netip.Addr, directory *networkDirectory, query *dns.Msg, tcp bool) (*dns.Msg, error) {
	if directory == nil {
		return dnsAnswer(presentation.hostname, addresses, query,
			append(slices.Clone(presentation.names), trustProbeHostname(presentation.hostname))...), nil
	}
	resolver := directoryDNS{members: func() []networkMember { return directory.Members }, exchange: publicDNSExchange}
	answer, err := resolver.answer(ctx, query, tcp)
	if !tcp {
		size := uint16(512)
		if opt := query.IsEdns0(); opt != nil { size = max(size, opt.UDPSize()) }
		answer.Truncate(int(min(size, 1232)))
	}
	return answer, err
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
		names := []string{host, trustProbeHostname(host)}
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
