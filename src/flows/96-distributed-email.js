flow({
  id: 'distributed-email',
  title: 'Distributed email service (Gmail-style mailbox)',
  category: 'Messaging & events',
  tags: ['SMTP inbound', 'Spam / virus checks', 'Attachments in object storage', 'Mailbox metadata DB', 'Search index', 'Push sync (JMAP / IMAP IDLE)'],
  summary: 'This is the receiving side of email: how a message from another provider lands in your inbox and on all your devices. Inbound SMTP servers accept it, filters check it, attachments go to object storage, metadata goes to a database partitioned by user, a search index is updated, and your devices are told to sync. Follow a normal email, a spam message, and the search afterwards.',
  requirements: {
    functional: ['Receive email for billions of mailboxes.', 'Folders/labels, read/unread, threads.', 'Full-text search over your own mail.', 'Sync to web and phone in near real time.'],
    nonFunctional: ['Never lose an accepted email.', 'Strict isolation: one user\'s mail is never visible to another.', 'Storage dominated by attachments.']
  },
  grid: { cols: 5, rows: 3 },
  nodes: [
    { id: 'ext', label: 'Sender\'s mail server', sub: 'other provider', kind: 'external', icon: 'globe', x: 0, y: 1, desc: 'Looks up the MX record for madgate.be and connects over SMTP.' },
    { id: 'smtp', label: 'Inbound SMTP', sub: 'MX servers', kind: 'edge', icon: 'inbox', x: 1, y: 1, desc: 'Accepts the message and only replies "250 OK" after it is durably queued.' },
    { id: 'filter', label: 'Filters', sub: 'SPF/DKIM/DMARC, spam, virus', kind: 'service', icon: 'shield', x: 1, y: 0, desc: 'Checks sender authentication and scores the message for spam and malware.' },
    { id: 'store', label: 'Mail store service', sub: 'writes mailbox', kind: 'service', icon: 'server', x: 2, y: 1, desc: 'Splits the message into metadata, body and attachments and writes each to the right store.' },
    { id: 'blob', label: 'Attachment store', sub: 'object storage', kind: 'storage', icon: 'storage', x: 2, y: 2, desc: 'Large bodies and attachments by content hash.' },
    { id: 'meta', label: 'Mailbox DB', sub: 'partitioned by user_id', kind: 'db', icon: 'db', x: 3, y: 1, desc: 'Per-user rows: message id, thread, labels, flags, snippet, blob pointers.' },
    { id: 'idx', label: 'Search index', sub: 'per-user inverted index', kind: 'db', icon: 'search', x: 3, y: 2, desc: 'Lets the user search their own mail by words, sender and date.' },
    { id: 'push', label: 'Sync / push', sub: 'JMAP push, IMAP IDLE', kind: 'service', icon: 'bell', x: 3, y: 0, desc: 'Tells the user\'s connected clients that the mailbox state changed.' },
    { id: 'client', label: 'Your devices', sub: 'web + phone', kind: 'client', icon: 'phone', x: 4, y: 1, desc: 'Fetch the changes since their last state and show the new message.' }
  ],
  pseudo: `
smtp: MAIL FROM, RCPT TO <swampi@madgate.be>, DATA
queue.durable_write(msg); reply "250 OK"
verdict = filters(spf, dkim, dmarc, spam_score, av_scan)
if verdict.spam: label = "Spam" else label = "Inbox"
for a in msg.attachments: blob.put(sha256(a), a)
mailbox.insert(user_id, msg_id, thread_id, label, flags, snippet, blob_refs)
search.index(user_id, msg_id, words)
state = mailbox.bump_state(user_id); push.notify(user_id, state)
client: Email/changes(sinceState) -> Email/get(ids)`,
  steps: [
    {
      from: 'ext', to: 'smtp', label: 'SMTP RCPT TO:<swampi@madgate.be>', pc: ['smtp: MAIL FROM'],
      title: 'Another server delivers over SMTP',
      caption: 'The sender\'s server found our MX record in DNS and connects. The message has a 2.4 MB PDF attached.',
      text: [],
      payloadKind: 'SMTP envelope',
      payload: { mail_from: 'prof@uclouvain.be', rcpt_to: 'swampi@madgate.be', size_bytes: 2540000, subject: 'Graph theory: exam room' }
    },
    {
      from: 'smtp', to: 'smtp', label: 'durably queued → "250 OK"', pc: ['queue.durable_write'],
      title: 'Accept only once it is safe',
      caption: 'After "250 OK" the sender deletes its copy, so the message must be on replicated disk first. Otherwise a crash would lose mail.',
      text: [],
      payloadKind: 'SMTP reply',
      payload: { code: 250, text: '2.0.0 OK queued as q_88a1' }
    },
    {
      from: 'smtp', to: 'filter', label: 'SPF pass, DKIM pass, spam 0.4', pc: ['verdict = filters'],
      title: 'Authenticate and filter',
      caption: 'SPF checks the sending IP is allowed for the domain, DKIM checks the signature, DMARC says what to do on failure. Then spam and virus scoring.',
      text: [],
      payloadKind: 'Verdict',
      payload: { spf: 'pass', dkim: 'pass', dmarc: 'pass', spam_score: 0.4, virus: 'clean' },
      branch: { q: 'Spam?', options: [ { label: 'no: Inbox', goto: 'att' }, { label: 'yes: Spam folder', goto: 'spam' } ] }
    },
    {
      id: 'spam', path: 'spam', from: 'filter', to: 'store', label: 'DKIM fail, score 9.1 → label Spam', pc: ['if verdict.spam'],
      title: 'Other outcome: spam',
      caption: 'A message claiming to be from your bank fails DKIM and scores 9.1. It is still stored (users check spam folders), but labelled Spam and no notification is sent.',
      text: [],
      payloadKind: 'Spam verdict',
      payload: { from: 'security@bank-be-verify.com', dkim: 'fail', spam_score: 9.1, label: 'Spam', notify: false }
    },
    {
      id: 'att', from: 'store', to: 'blob', label: 'PUT att/9c2e… (2.4 MB PDF)', pc: ['blob.put'],
      title: 'Attachments go to object storage',
      caption: 'Big bytes do not belong in the mailbox database. They are stored by hash; a newsletter attachment sent to a million users can be stored once.',
      text: [],
      payloadKind: 'Blob',
      payload: { key: 'att/9c2e…', size_bytes: 2410000, content_type: 'application/pdf' }
    },
    {
      from: 'store', to: 'meta', label: 'insert msg into user u_8812 partition', pc: ['mailbox.insert'],
      title: 'Write the mailbox row',
      caption: 'Everything for one user lives in one partition, so listing the inbox is one partition read. The row holds labels, flags, thread id, a snippet and blob pointers.',
      text: [],
      payloadKind: 'Mailbox row',
      payload: { user_id: 'u_8812', msg_id: 'm_01JDY…', thread_id: 't_4410', labels: ['Inbox'], unread: true, snippet: 'The exam will take place in room A.10…', blobs: ['att/9c2e…'] }
    },
    {
      from: 'store', to: 'idx', label: 'index words for u_8812', pc: ['search.index'],
      title: 'Index it for search',
      caption: 'Words from subject, body and sender go into the user\'s own index.',
      text: [],
      payloadKind: 'Index entry',
      payload: { user_id: 'u_8812', msg_id: 'm_01JDY…', terms: ['graph', 'theory', 'exam', 'room', 'a.10'] }
    },
    {
      from: 'meta', to: 'push', label: 'state s_771 → s_772', pc: ['push.notify'],
      title: 'Mailbox state changes, devices are told',
      caption: 'Each change bumps a per-user state string. Connected clients get a push with the new state, not the email itself.',
      text: [],
      payloadKind: 'Push',
      payload: { '@type': 'StateChange', changed: { u_8812: { Email: 's_772' } } }
    },
    {
      from: 'push', to: 'client', label: 'Email/changes since s_771 → 1 created', pc: ['client: Email/changes'],
      title: 'Each device fetches only what changed',
      caption: 'The phone asks "what changed since s_771?", gets one new id, and fetches it. This is how JMAP (RFC 8620/8621) works; IMAP IDLE is the older equivalent.',
      text: [],
      payloadKind: 'JMAP',
      payload: { request: ['Email/changes', { sinceState: 's_771' }], response: { created: ['m_01JDY…'], newState: 's_772' } }
    }
  ],
  decisions: [
    { q: 'Where to store bodies and attachments?', options: [
      { name: 'Metadata in DB, blobs in object storage', verdict: 'good', why: 'DB stays small and fast; blobs are cheap and deduplicated.' },
      { name: 'Everything in the DB', verdict: 'bad', why: 'Huge rows, expensive replication and backups.' } ] },
    { q: 'Partition key?', options: [
      { name: 'user_id', verdict: 'good', why: 'All mailbox queries are per user; strong isolation.' } ] }
  ],
  refs: [
    { label: 'RFC 5321: Simple Mail Transfer Protocol', url: 'https://www.rfc-editor.org/rfc/rfc5321' },
    { label: 'RFC 8620: The JSON Meta Application Protocol (JMAP)', url: 'https://www.rfc-editor.org/rfc/rfc8620' },
    { label: 'RFC 8621: JMAP for Mail', url: 'https://www.rfc-editor.org/rfc/rfc8621' },
    { label: 'RFC 7489: DMARC', url: 'https://www.rfc-editor.org/rfc/rfc7489' },
    { label: 'ByteByteGo: System Design Interview Vol. 2, chapter "Distributed Email Service" (book)', url: 'https://bytebytego.com/courses/system-design-interview/distributed-email-service' }
  ],
  verify: {
    checked: ['SMTP envelope and 250 reply: RFC 5321.', 'State strings, Email/changes and push StateChange: RFC 8620 and RFC 8621.', 'DMARC builds on SPF and DKIM: RFC 7489.'],
    uncertain: ['Addresses, sizes, scores and ids are illustrative. Gmail\'s internal storage design is not public; the split shown is the common design.']
  }
});
