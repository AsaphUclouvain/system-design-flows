flow({
  id: 'email-delivery',
  title: 'Transactional email delivery',
  category: 'Messaging & events',
  tags: ['Templating', 'SMTP / MTA', 'SPF, DKIM, DMARC', 'Bounces and complaints', 'Suppression list', 'Per-domain throttling'],
  summary: 'A customer resets their password and the email must land in the inbox, not spam, within seconds. Follow it from the API through a queue, template rendering, DKIM signing and an SMTP conversation with Gmail\'s servers, then see a bounce and a spam complaint come back and protect your sender reputation.',
  requirements: {
    functional: [
      'Send transactional emails (password reset, receipts) from templates with per-user data.',
      'Track each message: queued, sent, delivered, bounced, complained, opened.',
      'Never send again to addresses that hard-bounced, complained or unsubscribed.'
    ],
    nonFunctional: [
      'Password-reset emails delivered in under 10 seconds p95.',
      'High inbox placement: authenticated mail, low bounce and complaint rates.',
      'Marketing bursts never delay transactional mail.'
    ]
  },
  estimates: [
    { label: 'Transactional', value: '≈ 3M / day', note: 'Receipts, resets, notifications; ~35/s average, 300/s peak.' },
    { label: 'Marketing', value: '≈ 20M / week', note: 'Sent on separate queues and IPs so it cannot slow down resets.' },
    { label: 'Bounce budget', value: '< 2%', note: 'Mailbox providers start filtering senders with high bounce rates.' },
    { label: 'Complaint budget', value: '< 0.1%', note: 'Gmail\'s sender guidelines ask to stay under 0.1% and never reach 0.3%.' }
  ],
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'app', label: 'Auth API', sub: 'FastAPI', kind: 'service', icon: 'key', x: 0, y: 0, desc: 'Creates the reset token and asks for the email to be sent.' },
    { id: 'q', label: 'Email queue', sub: 'priority lanes', kind: 'queue', x: 1, y: 0, desc: 'Separate lanes for transactional and bulk mail.' },
    { id: 'render', label: 'Email worker', sub: 'templates + checks', kind: 'worker', icon: 'mail', x: 1, y: 1, desc: 'Checks suppression, renders the template, builds the MIME message.' },
    { id: 'supp', label: 'Suppression list', sub: 'PostgreSQL', kind: 'db', icon: 'shield', x: 0, y: 2, desc: 'Addresses that must not receive mail.' },
    { id: 'mta', label: 'Sending MTA', sub: 'Postfix / SES', kind: 'service', icon: 'server', x: 2, y: 0, desc: 'Signs with DKIM, queues per destination domain and talks SMTP.' },
    { id: 'dns', label: 'DNS', sub: 'MX, SPF, DKIM', kind: 'external', icon: 'dns', x: 2, y: 2, desc: 'Where receivers look up your SPF, DKIM key and DMARC policy, and where you look up their MX.' },
    { id: 'gmail', label: 'Receiving server', sub: 'gmail-smtp-in', kind: 'external', icon: 'mail', x: 3, y: 0, desc: 'Gmail\'s inbound mail servers.' },
    { id: 'events', label: 'Feedback handler', sub: 'webhooks', kind: 'worker', icon: 'bell', x: 3, y: 2, desc: 'Processes delivery, bounce and complaint events.' },
    { id: 'log', label: 'Message log', sub: 'PostgreSQL', kind: 'db', x: 1, y: 2, desc: 'Status history of every message.' }
  ],
  steps: [
    {
      from: 'app', to: 'q', label: 'enqueue password_reset',
      title: 'The app asks for an email, it does not send it',
      caption: 'Ana clicks "Forgot password". The auth API creates a reset token and enqueues a send request on the transactional lane. It never opens an SMTP connection itself.',
      text: ['Sending from the request handler would make the page wait on a remote server and lose the email if that server is slow. A queue makes sending retryable and keeps the API fast.', 'The {{idempotency key}} prevents two emails if Ana double-clicks.'],
      payloadKind: 'Queue message',
      payload: { lane: 'transactional', message_id: 'em_01JDQJ7', idempotency_key: 'pwreset:usr_ana:2026-11-25T11:41', template: 'password_reset', to: 'ana.lopez@gmail.com', locale: 'fr-BE', data: { first_name: 'Ana', reset_url: 'https://shop.example/reset?t=rst_9fK2…', expires_minutes: 30 } },
      fields: { lane: 'Transactional and bulk use different queues, workers and sending IPs.', reset_url: 'The token is single-use and expires in 30 minutes; the email itself is not a secret store.' },
      code: [{ lang: 'python', title: 'Request a send', src: String.raw`
@router.post("/v1/auth/password-reset")
async def request_reset(body: ResetIn):
    user = await users.by_email(body.email)
    if user:                                          # same answer either way (no account probing)
        token = await reset_tokens.create(user.id, ttl_min=30)
        await email_queue.enqueue(
            lane="transactional", template="password_reset", to=user.email,
            locale=user.locale, idempotency_key=f"pwreset:{user.id}:{minute()}",
            data={"first_name": user.first_name,
                  "reset_url": f"{SITE}/reset?t={token}", "expires_minutes": 30})
    return {"ok": True}` }]
    },
    {
      from: 'q', to: 'render', label: 'dequeue',
      title: 'A worker picks it up',
      caption: 'An email worker takes the message from the transactional lane within milliseconds. Transactional workers never take bulk work, so a newsletter of 2 million emails cannot delay a reset.',
      text: ['This is {{bulkhead}} isolation applied to email: separate queues and worker pools per traffic type.'],
      payloadKind: 'Worker',
      payload: { worker: 'email-tx-4', lane: 'transactional', queue_depth: 12, bulk_queue_depth: 1840220, waited_ms: 31 }
    },
    {
      from: 'render', to: 'supp', label: 'is suppressed?',
      title: 'Check the suppression list first',
      caption: 'Before rendering, the worker checks that ana.lopez@gmail.com has not hard-bounced, complained or unsubscribed. She has not, so the send continues.',
      text: ['Sending to a {{suppression list}} address again is how senders lose reputation: mailbox providers see repeated sends to dead or complaining addresses as spam behaviour.', 'Password resets ignore marketing unsubscribes (people must still be able to reset), but never ignore hard bounces or complaints.'],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
SELECT reason, created_at FROM suppressions
WHERE email_hash = digest(lower('ana.lopez@gmail.com'), 'sha256')
  AND (reason IN ('hard_bounce', 'complaint') OR (reason = 'unsubscribe' AND category = 'marketing' AND $cat = 'marketing'));
-- 0 rows`
    },
    {
      from: 'render', to: 'render', label: 'render + MIME',
      title: 'Render the template into a MIME message',
      caption: 'The worker renders the French template with Ana\'s data into HTML and a plain-text version, then builds a MIME message with the headers mailbox providers expect.',
      text: ['A plain-text part, a real From address, and a `List-Unsubscribe` header on non-essential mail all help inbox placement. Links point to your own domain, which matches the DKIM domain.'],
      payloadKind: 'MIME message',
      payloadLang: 'text',
      payload: String.raw`
From: Shop <no-reply@mail.shop.example>
To: ana.lopez@gmail.com
Subject: =?UTF-8?Q?R=C3=A9initialisez_votre_mot_de_passe?=
Date: Wed, 25 Nov 2026 11:41:44 +0100
Message-ID: <em_01JDQJ7@mail.shop.example>
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary="b1"
X-Entity-Ref-ID: em_01JDQJ7

--b1
Content-Type: text/plain; charset=UTF-8

Bonjour Ana, cliquez sur ce lien pour choisir un nouveau mot de passe (valable 30 min) : …
--b1
Content-Type: text/html; charset=UTF-8

<!doctype html><html lang="fr">…<a href="https://shop.example/reset?t=rst_9fK2…">Choisir un mot de passe</a>…
--b1--`,
      code: [{ lang: 'python', title: 'Render with Jinja2', src: String.raw`
env = Environment(loader=FileSystemLoader("templates"), autoescape=select_autoescape(["html"]))

def render(msg: SendRequest) -> EmailMessage:
    html = env.get_template(f"{msg.template}.{msg.locale}.html").render(**msg.data)
    text = env.get_template(f"{msg.template}.{msg.locale}.txt").render(**msg.data)
    m = EmailMessage()
    m["From"] = "Shop <no-reply@mail.shop.example>"
    m["To"], m["Subject"] = msg.to, subjects[msg.template][msg.locale]
    m["Message-ID"] = make_msgid(idstring=msg.message_id, domain="mail.shop.example")
    m.set_content(text)
    m.add_alternative(html, subtype="html")
    return m` }]
    },
    {
      from: 'render', to: 'mta', label: 'submit (port 587)',
      title: 'Hand the message to the sending MTA',
      caption: 'The worker submits the message to the mail transfer agent and records it as sent to MTA. The MTA (here Amazon SES or your own Postfix) is responsible for getting it to Gmail.',
      payloadKind: 'Message log',
      payload: { message_id: 'em_01JDQJ7', status: 'submitted', mta_id: '0102019361a4c2f1-…', ip_pool: 'transactional', submitted_at: '2026-11-25T11:41:44.210Z' },
      text: ['The MTA keeps a queue per destination domain with its own rate limits, because each mailbox provider tolerates a different sending speed from a given IP.']
    },
    {
      from: 'mta', to: 'dns', label: 'MX gmail.com?',
      title: 'Find where gmail.com accepts mail',
      caption: 'The MTA looks up the MX records of gmail.com and connects to the one with the lowest preference number, falling back to the others if it does not answer.',
      text: ['An {{mx record}} lookup happens per destination domain and is cached for its TTL.'],
      payloadKind: 'DNS answer',
      payloadLang: 'text',
      payload: String.raw`
gmail.com.  3600 IN MX  5 gmail-smtp-in.l.google.com.
gmail.com.  3600 IN MX 10 alt1.gmail-smtp-in.l.google.com.
gmail.com.  3600 IN MX 20 alt2.gmail-smtp-in.l.google.com.`
    },
    {
      from: 'mta', to: 'gmail', label: 'SMTP + DKIM signature',
      title: 'Sign with DKIM and deliver over SMTP',
      caption: 'The MTA signs selected headers and the body with the private DKIM key for mail.shop.example, opens a TLS SMTP session with Gmail and transfers the message. Gmail answers 250: accepted.',
      text: ['{{dkim}} lets Gmail verify the message really comes from your domain and was not modified. The signature covers From, Subject, Date and a hash of the body.'],
      payloadKind: 'SMTP conversation',
      payloadLang: 'text',
      payload: String.raw`
S: 220 mx.google.com ESMTP
C: EHLO out-14.mail.shop.example
S: 250-STARTTLS …
C: STARTTLS                         (TLS 1.3 negotiated)
C: MAIL FROM:<bounce+em_01JDQJ7@mail.shop.example>
S: 250 2.1.0 OK
C: RCPT TO:<ana.lopez@gmail.com>
S: 250 2.1.5 OK
C: DATA
C: DKIM-Signature: v=1; a=rsa-sha256; d=mail.shop.example; s=s2026;
C:   h=from:to:subject:date:message-id; bh=47DEQpj8HBSa+/TImW+5JCeuQeR…; b=dzdVyOfAKCd…
C: (headers and body) .
S: 250 2.0.0 OK 1764069704 a640c23a62f3a-… - gsmtp`,
      fields: {},
      failure: ['**421 / 4xx (try later, rate limited):** a soft failure. The MTA keeps the message and retries with backoff for up to 24 hours, slowing its rate to Gmail.', '**550 5.1.1 (user unknown):** a {{hard bounce}}; no retry, the address goes on the suppression list (a later step).']
    },
    {
      from: 'gmail', to: 'dns', label: 'check SPF, DKIM, DMARC',
      title: 'Gmail checks who really sent it',
      caption: 'Gmail looks up your SPF record to check the sending IP, fetches the DKIM public key to verify the signature, and reads your DMARC policy. All three pass and align with the From domain.',
      text: ['{{spf}} authorises sending IPs; {{dkim}} proves integrity and domain; {{dmarc}} says what to do if both fail and requires the domain in From to match. Since 2024, Gmail and Yahoo require all three for bulk senders.'],
      payloadKind: 'DNS records + result',
      payloadLang: 'text',
      payload: String.raw`
mail.shop.example.            TXT "v=spf1 include:amazonses.com -all"
s2026._domainkey.mail.shop.example. TXT "v=DKIM1; k=rsa; p=MIIBIjANBgkqh…"
_dmarc.shop.example.          TXT "v=DMARC1; p=quarantine; rua=mailto:dmarc@shop.example; adkim=r; aspf=r"

Authentication-Results: mx.google.com;
  dkim=pass header.i=@mail.shop.example header.s=s2026;
  spf=pass smtp.mailfrom=bounce+em_01JDQJ7@mail.shop.example;
  dmarc=pass (p=QUARANTINE) header.from=mail.shop.example`,
      failure: ['**SPF or DKIM misconfigured after a provider change:** DMARC fails and, with `p=quarantine`, mail goes to spam. DMARC aggregate reports to `rua` reveal this within a day.']
    },
    {
      from: 'mta', to: 'events', label: 'Delivery event', async: true,
      title: 'A delivery event comes back',
      caption: 'The MTA reports the 250 from Gmail as a Delivery event. The feedback handler marks the message delivered. About 3 seconds passed since Ana clicked.',
      text: ['Delivered means Gmail accepted it, not that it reached the inbox: inbox or spam is Gmail\'s decision. Gmail Postmaster Tools shows your domain reputation and spam rate.'],
      payloadKind: 'Event',
      payload: { eventType: 'Delivery', mail: { messageId: '0102019361a4c2f1-…', tags: { message_id: ['em_01JDQJ7'] } }, delivery: { timestamp: '2026-11-25T11:41:46.903Z', recipients: ['ana.lopez@gmail.com'], smtpResponse: '250 2.0.0 OK', processingTimeMillis: 2693 } }
    },
    {
      from: 'events', to: 'supp', label: 'Bounce: 5.1.1 → suppress',
      title: 'Another message hard-bounces',
      caption: 'A receipt to old.address@company.example bounces with 550 5.1.1 user unknown. The handler adds the address to the suppression list and flags the user\'s email as invalid in the app.',
      text: ['A bounce comes back either synchronously (rejected during SMTP) or later as a bounce message to the `MAIL FROM` address; encoding the message id in that address (VERP) tells you exactly which message bounced.'],
      payloadKind: 'Event',
      payload: { eventType: 'Bounce', bounce: { bounceType: 'Permanent', bounceSubType: 'General', bouncedRecipients: [{ emailAddress: 'old.address@company.example', status: '5.1.1', diagnosticCode: 'smtp; 550 5.1.1 The email account that you tried to reach does not exist' }] }, mail: { tags: { message_id: ['em_01JDQ0Z'] } } },
      code: [{ lang: 'python', title: 'Feedback handler', src: String.raw`
@router.post("/webhooks/ses")
async def ses_events(ev: SesEvent = Depends(verified_sns)):
    mid = ev.mail.tags["message_id"][0]
    match ev.eventType:
        case "Delivery":
            await log.set_status(mid, "delivered")
        case "Bounce" if ev.bounce.bounceType == "Permanent":
            for r in ev.bounce.bouncedRecipients:
                await suppress(r.emailAddress, "hard_bounce", detail=r.diagnosticCode)
                await users.mark_email_invalid(r.emailAddress)   # ask to update in app
            await log.set_status(mid, "bounced")
        case "Bounce":
            await log.set_status(mid, "soft_bounced")           # MTA already retried
        case "Complaint":
            for r in ev.complaint.complainedRecipients:
                await suppress(r.emailAddress, "complaint")
            await log.set_status(mid, "complained")
    return {"ok": True}` }]
    },
    {
      from: 'events', to: 'log', label: 'Complaint → record',
      title: 'A spam complaint comes back',
      caption: 'Someone marks a shipping update as spam. The provider\'s feedback loop reports it; the handler suppresses that address for all non-essential email and records the complaint against the template.',
      text: ['Complaint rate per template is a key metric. A template with a high rate (too frequent, confusing sender name) is fixed before it drags down the whole domain\'s reputation.'],
      payloadKind: 'Event + metric',
      payload: { eventType: 'Complaint', complaint: { complainedRecipients: [{ emailAddress: 'm.dupont@yahoo.fr' }], complaintFeedbackType: 'abuse', timestamp: '2026-11-25T12:03:10Z' }, metric: { template: 'shipping_update', complaint_rate_7d: '0.04%', budget: '0.10%' } }
    }
  ],
  api: [
    { verb: 'POST', path: '/internal/v1/emails', desc: 'Enqueue a templated email with an idempotency key.' },
    { verb: 'GET', path: '/internal/v1/emails/{id}', desc: 'Status history: queued, submitted, delivered, bounced…' },
    { verb: 'POST', path: '/webhooks/ses', desc: 'Delivery, bounce and complaint events (SNS-signed).' },
    { verb: 'POST', path: '/v1/unsubscribe', desc: 'One-click unsubscribe target for List-Unsubscribe-Post.' }
  ],
  schema: String.raw`
CREATE TABLE email_messages (
  id TEXT PRIMARY KEY, idem_key TEXT UNIQUE, template TEXT NOT NULL, lane TEXT NOT NULL,
  to_hash BYTEA NOT NULL, status TEXT NOT NULL, mta_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ
);
CREATE TABLE email_events (message_id TEXT, type TEXT, detail JSONB, at TIMESTAMPTZ);
CREATE TABLE suppressions (
  email_hash BYTEA NOT NULL, reason TEXT NOT NULL CHECK (reason IN ('hard_bounce','complaint','unsubscribe')),
  category TEXT, detail TEXT, created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (email_hash, reason, category)
);`,
  decisions: [
    { q: 'Where is mail sent from?', options: [
      { verdict: 'bad', name: 'smtplib from the request handler', why: 'Slow requests, lost mail on errors, no retry or throttling.' },
      { verdict: 'good', name: 'Queue + your own Postfix fleet', why: 'Full control, but you manage IP warm-up and reputation yourself.' },
      { verdict: 'great', name: 'Queue + a managed sending service with event webhooks', why: 'Retries, throttling and feedback loops handled; you own templates and suppression.' }
    ] },
    { q: 'How do you protect reputation?', options: [
      { verdict: 'bad', name: 'One domain and IP for everything', why: 'A marketing complaint spike sends password resets to spam.' },
      { verdict: 'great', name: 'SPF + DKIM + DMARC, separate streams for transactional and bulk, strict suppression', why: 'Authenticated, isolated and clean lists.' }
    ] }
  ],
  refs: [
    { label: 'Google: Email sender guidelines', url: 'https://support.google.com/a/answer/81126' },
    { label: 'RFC 6376: DKIM Signatures', url: 'https://www.rfc-editor.org/rfc/rfc6376' },
    { label: 'RFC 7489: DMARC', url: 'https://www.rfc-editor.org/rfc/rfc7489' },
    { label: 'Amazon SES: Event publishing', url: 'https://docs.aws.amazon.com/ses/latest/dg/monitor-using-event-publishing.html' }
  ]
});
