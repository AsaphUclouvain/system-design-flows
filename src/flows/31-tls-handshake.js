flow({
  id: 'tls-handshake',
  title: 'HTTPS: TCP and the TLS 1.3 handshake',
  category: 'Web & networking',
  tags: ['TCP 3-way handshake', 'TLS 1.3', 'ECDHE key share', 'Certificate chain', 'Session resumption', 'HTTP/3'],
  summary: 'How a browser and a server that have never met agree on a secret key in one round trip, and how the browser knows it is really talking to madgate.app. Follow TCP\'s SYN / SYN-ACK / ACK, the TLS 1.3 ClientHello and ServerHello with key shares, certificate checks, and the first encrypted request; then the faster resumed path.',
  requirements: {
    functional: ['Encrypt everything between browser and server.', 'Prove the server owns the name in the address bar.', 'Detect any tampering in transit.'],
    nonFunctional: ['Add as few round trips as possible before the first byte of HTTP (TLS 1.3: one; resumed: zero for some data).', 'Forward secrecy: stealing the server\'s key later must not decrypt old traffic.']
  },
  grid: { cols: 3, rows: 3 },
  nodes: [
    { id: 'browser', label: 'Browser', sub: 'client', kind: 'client', icon: 'browser', x: 0, y: 1, desc: 'Starts the connection, offers key shares and cipher suites, and checks the server\'s certificate against its trusted root store.' },
    { id: 'server', label: 'madgate.app', sub: 'nginx :443', kind: 'service', icon: 'server', x: 2, y: 1, desc: 'Holds a certificate for madgate.app and the matching private key. Chooses the parameters and proves it owns the key.' },
    { id: 'ca', label: 'Certificate authority', sub: 'trusted root in the OS', kind: 'external', icon: 'shield', x: 1, y: 0, desc: 'Signed the server\'s certificate (through an intermediate). The browser trusts it because its root is pre-installed in the OS or browser.' },
    { id: 'keys', label: 'Session keys', sub: 'derived on both sides', kind: 'cache', icon: 'key', x: 1, y: 2, desc: 'Never sent over the network. Both sides compute the same secret from the ECDHE key shares, then derive traffic keys with HKDF.' }
  ],
  pseudo: `
# client side
tcp = connect(ip, 443)                         # SYN, SYN-ACK, ACK
priv, pub = x25519_keypair()                   # fresh for this connection
send(ClientHello(sni="madgate.app", key_share=pub, ciphers=[AES_128_GCM, CHACHA20]))
sh = recv(ServerHello)                         # server's key_share + choice
secret = x25519(priv, sh.key_share)            # same value on both sides
keys = hkdf_expand(secret, transcript_hash)
cert = decrypt(recv(Certificate), keys)
verify_chain(cert, trusted_roots, host="madgate.app")
verify_signature(recv(CertificateVerify), cert.public_key, transcript)
check_mac(recv(Finished), keys); send(Finished)
send(encrypt("GET / HTTP/1.1 ...", keys))       # first app data after 1 RTT of TLS`,
  steps: [
    {
      from: 'browser', to: 'server', label: 'SYN → 216.24.57.1:443', pc: ['connect(ip, 443)'],
      title: 'TCP: open a connection (SYN)',
      caption: 'With the IP from DNS, the browser starts TCP\'s three-way handshake: SYN, then the server\'s SYN-ACK, then ACK. One round trip, about 20 ms here, before any TLS byte.',
      text: ['TCP gives a reliable, ordered byte stream. The handshake agrees on starting sequence numbers in both directions. HTTP/3 replaces TCP + TLS with QUIC over UDP, merging the transport and TLS handshakes.'],
      payloadKind: 'TCP segments',
      payload: { '1_client': 'SYN seq=1000', '2_server': 'SYN-ACK seq=5000 ack=1001', '3_client': 'ACK ack=5001', rtt_ms: 20 },
      branch: { q: 'Has this browser connected to madgate.app recently?', options: [ { label: 'no: full handshake', goto: 'full' }, { label: 'yes: resume with a ticket', goto: 'resume' } ] }
    },
    {
      id: 'full', path: 'full', from: 'browser', to: 'server', label: 'ClientHello  sni=madgate.app  key_share=x25519', pc: ['x25519_keypair', 'ClientHello'],
      title: 'ClientHello: "here is my half of a key"',
      caption: 'The browser generates a one-time key pair and sends the public half in its ClientHello, with the server name (SNI) and the cipher suites it supports.',
      text: ['In TLS 1.3 the client guesses the key-exchange group and sends its key share right away. That guess is why TLS 1.3 needs one round trip where TLS 1.2 needed two. Static RSA key exchange, where the client encrypted a secret with the server\'s public key (as in ByteByteGo\'s simplified diagram), was removed in TLS 1.3.'],
      payloadKind: 'ClientHello',
      payload: { version: 'TLS 1.3', sni: 'madgate.app', cipher_suites: ['TLS_AES_128_GCM_SHA256', 'TLS_CHACHA20_POLY1305_SHA256'], key_share: { group: 'x25519', public: '9f1c…e2' }, alpn: ['h2', 'http/1.1'] },
      fields: { sni: 'Server Name Indication: lets one IP host many sites and pick the right certificate.', alpn: 'Which HTTP version to speak after the handshake.' }
    },
    {
      path: 'full', from: 'server', to: 'browser', reply: true, label: 'ServerHello + {Certificate, CertificateVerify, Finished}', pc: ['recv(ServerHello)'],
      title: 'ServerHello and the server\'s encrypted proof',
      caption: 'The server picks AES-128-GCM, sends its own key share, and from that moment everything is encrypted: its certificate chain, a signature over the handshake, and Finished.',
      text: ['CertificateVerify is a signature, made with the certificate\'s private key, over everything said so far. It proves the server holds that key without ever sending it.'],
      payloadKind: 'Server flight',
      payload: { ServerHello: { cipher: 'TLS_AES_128_GCM_SHA256', key_share: { group: 'x25519', public: '41ab…07' } }, encrypted: ['EncryptedExtensions (alpn=h2)', 'Certificate [madgate.app ← R11 intermediate]', 'CertificateVerify (ECDSA-P256 signature)', 'Finished (MAC)'] }
    },
    {
      path: 'full', from: 'browser', to: 'keys', label: 'x25519(my_priv, server_pub)', pc: ['secret = x25519', 'hkdf_expand'],
      title: 'Both sides compute the same secret',
      caption: 'Each side combines its own private key with the other\'s public share (elliptic-curve Diffie-Hellman) and gets the same shared secret. An eavesdropper who saw both public shares cannot compute it.',
      text: ['Because the key pairs are thrown away after the connection, stealing the server\'s certificate key later does not reveal this session: forward secrecy. Traffic keys are derived with HKDF from the secret and a hash of the handshake transcript.'],
      payloadKind: 'Key schedule',
      payload: { shared_secret: '(32 bytes, never sent)', handshake_traffic_keys: 'HKDF(secret, transcript)', application_traffic_keys: 'HKDF(…, after Finished)' }
    },
    {
      path: 'full', from: 'browser', to: 'ca', label: 'verify chain → trusted root', pc: ['verify_chain', 'verify_signature'],
      title: 'Is this certificate really madgate.app\'s?',
      caption: 'The browser checks that the name matches, the dates are valid, and each certificate is signed by the next up the chain, ending at a root it already trusts. Then it checks the CertificateVerify signature.',
      text: ['No network call to the CA is needed for the signature check: the root\'s public key is already in the trust store. Revocation status may be checked separately (OCSP stapling, CRLs).'],
      payloadKind: 'Chain check',
      payload: { leaf: { subject: 'madgate.app', valid: '2026-10-02 → 2026-12-31', signed_by: 'R11' }, intermediate: { subject: 'R11', signed_by: 'ISRG Root X1' }, root: 'ISRG Root X1 (in trust store)', name_match: true, signature_ok: true },
      failure: ['**Name mismatch or expired:** the browser stops with a full-page warning (NET::ERR_CERT_COMMON_NAME_INVALID or _DATE_INVALID). No HTTP request is sent.']
    },
    {
      path: 'full', from: 'browser', to: 'server', label: 'Finished + GET / (encrypted)', pc: ['check_mac', 'send(encrypt'],
      title: 'Finished, then the first HTTP request',
      caption: 'The browser checks the server\'s Finished MAC, sends its own, and sends the HTTP request in the same flight. TLS cost exactly one round trip.',
      text: ['From here every record is encrypted and authenticated with AES-GCM. The server can also send a NewSessionTicket so that the next connection can resume faster.'],
      payloadKind: 'Application data',
      payload: { record: 'application_data', decrypted_view: 'GET / HTTP/2  :authority madgate.app', tls_rtts: 1, total_rtts_before_request: 2 },
      end: true
    },
    {
      id: 'resume', path: 'resumed', from: 'browser', to: 'server', label: 'ClientHello + PSK ticket (+ early data)', pc: ['ClientHello'],
      title: 'Resumption: present a ticket from last time',
      caption: 'The browser kept a session ticket from yesterday\'s visit. It sends it as a pre-shared key, plus a new key share, and may even send the GET request immediately as 0-RTT early data.',
      text: ['0-RTT data can be replayed by an attacker, so the spec warns it must only carry requests that are safe to repeat, such as a plain GET. Many servers accept PSK resumption but disable 0-RTT.'],
      payloadKind: 'ClientHello (resumed)',
      payload: { pre_shared_key: { identity: 'ticket_7b2e…', age_ms: 81234000 }, key_share: { group: 'x25519', public: '1d77…' }, early_data: 'GET / (only if the server allows 0-RTT)' }
    },
    {
      path: 'resumed', from: 'server', to: 'browser', reply: true, label: 'ServerHello (PSK accepted) + Finished', pc: ['recv(ServerHello)', 'check_mac'],
      title: 'No certificate needed this time',
      caption: 'The server recognises the ticket, skips the certificate and signature, and finishes. With a fresh key share the session still gets forward secrecy.',
      text: ['Resumption saves CPU (no signature) and bytes (no certificate chain). With 0-RTT, the first response can arrive after a single round trip in total.'],
      payloadKind: 'Server flight',
      payload: { ServerHello: { pre_shared_key: 'accepted', key_share: 'x25519' }, encrypted: ['EncryptedExtensions (early_data accepted)', 'Finished'], certificate_sent: false }
    }
  ],
  decisions: [
    { q: 'Allow 0-RTT early data?', options: [
      { name: 'Enable for idempotent GETs only', verdict: 'good', why: 'Saves a full round trip for returning visitors. Requires the app to reject or deduplicate replayed early requests.' },
      { name: 'Disable', verdict: 'good', why: 'Simplest and safe: resumption still skips the certificate. Most APIs that take writes choose this.' } ] }
  ],
  refs: [
    { label: 'RFC 8446: The Transport Layer Security (TLS) Protocol Version 1.3', url: 'https://www.rfc-editor.org/rfc/rfc8446', note: 'handshake, key schedule, 0-RTT replay.' },
    { label: 'ByteByteGo newsletter: How does HTTPS work?', url: 'https://blog.bytebytego.com/p/how-does-https-work-episode-6', note: 'simplified (RSA-style) overview.' },
    { label: 'MDN: How browsers work (DNS, TCP, TLS before the first byte)', url: 'https://developer.mozilla.org/en-US/docs/Web/Performance/Guides/How_browsers_work' }
  ],
  verify: {
    checked: ['1-RTT full handshake, key_share in ClientHello, encrypted Certificate/CertificateVerify/Finished, PSK resumption and 0-RTT replay risk: RFC 8446.', 'Certificate sent and validated, then symmetric encryption: ByteByteGo HTTPS post.'],
    uncertain: ['ByteByteGo\'s diagram shows the client encrypting a session key with the server\'s public key: that is TLS 1.2 RSA key exchange, removed in 1.3. This flow follows RFC 8446.', 'Certificate names, dates and RTTs are illustrative.']
  }
});
