flow({
  id: 'dns-resolution',
  title: 'DNS resolution: from a name to an IP address',
  category: 'Web & networking',
  tags: ['Stub resolver', 'Recursive resolver', 'Root / TLD / authoritative', 'TTL caching', 'NXDOMAIN'],
  summary: 'Before a browser can open a connection to madgate.app it needs an IP address. Follow one lookup through the browser and OS caches, a recursive resolver, the root, the .app TLD and the authoritative name server, then see what a cache hit and an unknown name look like.',
  requirements: {
    functional: ['Turn a host name into one or more IP addresses (A / AAAA records).', 'Let the domain owner change the answer, and have the change reach users within the TTL.'],
    nonFunctional: ['Most lookups answered from a cache in under 1 ms; a full cold lookup in tens of milliseconds.', 'No single server for the whole internet: the namespace is delegated level by level.']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'browser', label: 'Browser', sub: 'Chrome on a laptop', kind: 'client', icon: 'laptop', x: 0, y: 1, desc: 'Needs the IP of madgate.app. Checks its own DNS cache first, then asks the operating system.' },
    { id: 'os', label: 'OS stub resolver', sub: 'cache + /etc/hosts', kind: 'client', icon: 'server', x: 1, y: 1, desc: 'A small resolver in the OS. It has a cache and the hosts file, and forwards misses to the configured recursive resolver (from DHCP, e.g. the ISP or 1.1.1.1).' },
    { id: 'rec', label: 'Recursive resolver', sub: 'ISP or 1.1.1.1', kind: 'edge', icon: 'globe', x: 2, y: 1, desc: 'Does the legwork: walks the hierarchy from the root down, caches every answer for its TTL, and returns the final answer to the stub.' },
    { id: 'root', label: 'Root server', sub: '13 logical (a–m)', kind: 'external', icon: 'globe', x: 3, y: 0, desc: 'Knows where every top-level domain\'s name servers are. 13 logical names, each served by many anycast machines.' },
    { id: 'tld', label: '.app TLD server', sub: 'run by the registry', kind: 'external', icon: 'globe', x: 3, y: 1, desc: 'Knows which authoritative name servers are responsible for each .app domain (the NS records the owner registered).' },
    { id: 'auth', label: 'Authoritative NS', sub: 'ns1.dnshost.net', kind: 'db', icon: 'db', x: 3, y: 2, desc: 'Holds the real records for madgate.app (A, AAAA, CNAME, MX…). Its answer is final, marked with the authoritative flag.' }
  ],
  pseudo: `
def resolve(name):
    if hit := browser_cache.get(name): return hit
    if hit := os_cache.get(name) or hosts_file.get(name): return hit
    return recursive_resolver.query(name, "A")

# inside the recursive resolver
def query(name, rtype):
    if hit := cache.get((name, rtype)): return hit       # most queries end here
    server = ROOT_HINTS                               # a.root-servers.net …
    while True:
        reply = ask(server, name, rtype)
        if reply.rcode == NXDOMAIN: cache_negative(name); return NXDOMAIN
        if reply.answer: cache.put(reply, ttl=reply.ttl); return reply.answer
        server = reply.referral_ns                     # go one level down`,
  steps: [
    {
      from: 'browser', to: 'os', label: 'getaddrinfo("madgate.app")', pc: ['def resolve', 'browser_cache', 'os_cache'],
      title: 'The browser asks the operating system',
      caption: 'The user types madgate.app. The browser\'s own DNS cache has nothing, so it asks the OS, which checks its cache and the hosts file.',
      text: ['ByteByteGo lists the cache layers a lookup can hit before the network: browser, OS, local network (home router) and ISP. Each layer stores answers for as long as the record\'s TTL allows.'],
      payloadKind: 'Lookup',
      payload: { name: 'madgate.app', type: 'A', browser_cache: 'miss', os_cache: 'miss', hosts_file: 'no entry' }
    },
    {
      from: 'os', to: 'rec', label: 'UDP :53  A? madgate.app (RD=1)', pc: ['recursive_resolver.query'],
      title: 'The stub sends one recursive query',
      caption: 'The OS sends a single UDP packet to its configured resolver, 1.1.1.1, with the "recursion desired" flag: "give me the final answer, do the work for me".',
      text: ['The stub only ever talks to the recursive resolver. Classic DNS uses UDP port 53; large answers fall back to TCP, and many resolvers also accept encrypted DNS over HTTPS or TLS.'],
      payloadKind: 'DNS query',
      payload: { id: '0x3f2a', flags: { RD: 1 }, question: { name: 'madgate.app.', type: 'A', class: 'IN' }, to: '1.1.1.1:53' },
      branch: { q: 'Does the resolver already have madgate.app cached?', options: [ { label: 'no: walk the hierarchy', goto: 'cold' }, { label: 'yes: cache hit', goto: 'hit' } ] }
    },
    {
      id: 'cold', path: 'cache miss', from: 'rec', to: 'root', label: 'A? madgate.app → a.root-servers.net', pc: ['ROOT_HINTS', 'ask(server'],
      title: 'Ask a root server',
      caption: 'The resolver starts at the top. It ships with the root servers\' addresses (root hints) and asks one of them about madgate.app.',
      text: ['The root does not know madgate.app. It answers with a referral: "I don\'t know, but here are the servers for .app". Resolvers cache that referral for two days, so real root traffic is rare.'],
      payloadKind: 'Referral',
      payload: { rcode: 'NOERROR', answer: [], authority: [{ name: 'app.', type: 'NS', value: 'ns-tld1.charlestonroadregistry.com.', ttl: 172800 }], additional: '(glue A records for the TLD servers)' },
      fields: { authority: 'A referral: the NS records of the next level down, instead of an answer.' }
    },
    {
      path: 'cache miss', from: 'rec', to: 'tld', label: 'A? madgate.app → .app TLD', pc: ['referral_ns', 'ask(server'],
      title: 'Ask the .app TLD server',
      caption: 'The TLD server knows every .app domain\'s delegation. It refers the resolver to the name servers the owner registered: ns1 and ns2.dnshost.net.',
      text: ['This NS set is what you change at your registrar when you move DNS hosting. The TLD stores only the delegation, never your A records.'],
      payloadKind: 'Referral',
      payload: { rcode: 'NOERROR', answer: [], authority: [{ name: 'madgate.app.', type: 'NS', value: 'ns1.dnshost.net.', ttl: 3600 }, { name: 'madgate.app.', type: 'NS', value: 'ns2.dnshost.net.', ttl: 3600 }] }
    },
    {
      path: 'cache miss', from: 'rec', to: 'auth', label: 'A? madgate.app → ns1.dnshost.net', pc: ['ask(server', 'reply.answer'],
      title: 'Ask the authoritative server',
      caption: 'Third hop: the authoritative name server holds the zone and answers with the A record, flagged as authoritative (AA). The resolver caches it for its TTL, 300 seconds.',
      text: ['A short TTL like 300 s lets the owner move the site quickly; a long TTL means fewer lookups but slower changes. If the name did not exist, the server would reply NXDOMAIN, and resolvers cache that negative answer too.'],
      payloadKind: 'Answer',
      payload: { rcode: 'NOERROR', flags: { AA: 1 }, answer: [{ name: 'madgate.app.', type: 'A', value: '216.24.57.1', ttl: 300 }] },
      failure: ['**Typo (madgte.app):** NXDOMAIN. The resolver caches the negative answer (for the zone\'s SOA minimum) and the browser shows "This site can\'t be reached".', '**Authoritative servers down:** the resolver tries ns2; if both fail it returns SERVFAIL. Running at least two name servers on separate networks avoids this.']
    },
    {
      path: 'cache miss', from: 'rec', to: 'os', reply: true, label: 'madgate.app = 216.24.57.1 (ttl 300)', pc: ['return reply.answer'],
      title: 'The answer travels back and is cached everywhere',
      caption: 'The resolver returns the address to the OS, which caches it and hands it to the browser. A cold lookup took about 60 ms; the next one will take under 1 ms.',
      text: ['Now the browser can open a TCP (or QUIC) connection to 216.24.57.1. See the HTTPS request flow for what happens next.'],
      payloadKind: 'DNS response',
      payload: { id: '0x3f2a', answer: [{ name: 'madgate.app.', type: 'A', value: '216.24.57.1', ttl: 300 }], total_ms: 61 },
      next: 'done'
    },
    {
      id: 'hit', path: 'cache hit', from: 'rec', to: 'rec', label: 'cache hit, ttl 212 s left', pc: ['if hit := cache.get'],
      title: 'Cache hit: no hierarchy walk at all',
      caption: 'Someone else using 1.1.1.1 looked up madgate.app 88 seconds ago. The cached A record still has 212 seconds to live, so the resolver answers at once.',
      text: ['This is the normal case for popular names. The TTL counts down in the cache, and the remaining TTL is what the stub receives, so all caches expire together.'],
      payloadKind: 'Cache entry',
      payload: { key: ['madgate.app.', 'A'], value: '216.24.57.1', original_ttl: 300, remaining_ttl: 212 }
    },
    {
      path: 'cache hit', from: 'rec', to: 'os', reply: true, label: 'madgate.app = 216.24.57.1 (ttl 212)', pc: ['return hit'],
      title: 'Answer in about 4 ms',
      caption: 'One round trip to the resolver and back. The stub caches the record for the remaining 212 seconds.',
      text: ['Most DNS latency a user feels is this single round trip to the resolver, which is why resolvers like 1.1.1.1 and 8.8.8.8 run on anycast close to users.'],
      payloadKind: 'DNS response',
      payload: { id: '0x3f2a', answer: [{ name: 'madgate.app.', type: 'A', value: '216.24.57.1', ttl: 212 }], total_ms: 4 }
    },
    {
      id: 'done', from: 'os', to: 'browser', reply: true, label: '216.24.57.1', pc: ['return recursive_resolver.query'],
      title: 'The browser has its IP address',
      caption: 'getaddrinfo returns 216.24.57.1. The browser caches it too (Chrome keeps entries about a minute) and moves on to connecting.',
      text: ['If several A records come back, the client can try them in turn. DNS-based load balancing and GeoDNS work by returning different records to different resolvers.'],
      payloadKind: 'Result',
      payload: { host: 'madgate.app', addresses: ['216.24.57.1'], next: 'TCP connect 216.24.57.1:443' }
    }
  ],
  decisions: [
    { q: 'What TTL should your records use?', options: [
      { name: 'Short (60–300 s)', verdict: 'good', why: 'Fast failover and migrations. More queries reach your authoritative servers.' },
      { name: 'Long (hours–days)', verdict: 'good', why: 'Fewer queries and resilience if your DNS host has an outage, but changes take that long to reach everyone. Lower it a day before a planned move.' } ] }
  ],
  refs: [
    { label: 'ByteByteGo newsletter: How does the Domain Name System (DNS) lookup work?', url: 'https://blog.bytebytego.com/p/how-does-the-domain-name-system-dns' },
    { label: 'ByteByteGo newsletter: What happens when you type a URL into your browser?', url: 'https://blog.bytebytego.com/p/what-happens-when-you-type-a-url', note: 'cache layers.' },
    { label: 'RFC 1034: Domain names, concepts and facilities', url: 'https://www.rfc-editor.org/rfc/rfc1034' },
    { label: 'RFC 2308: Negative caching of DNS queries', url: 'https://www.rfc-editor.org/rfc/rfc2308' }
  ],
  verify: {
    checked: ['Root → TLD → authoritative order, 13 logical root servers, cache layers: ByteByteGo posts above.', 'Referrals, recursion desired, TTL caching: RFC 1034. Negative caching of NXDOMAIN: RFC 2308.'],
    uncertain: ['The .app TLD server name, IPs and timings are illustrative.', 'Chrome\'s own DNS cache duration varies by version; "about a minute" is approximate.']
  }
});
