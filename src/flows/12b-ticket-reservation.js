flow({
  id: 'ticket-booking',
  title: 'Ticket sale: waiting room, seat holds and checkout',
  category: 'Commerce & money',
  tags: ['Waiting room', 'Seat holds with TTL', 'Optimistic concurrency', 'Hot inventory', 'Payment timeout'],
  summary: 'A concert opens for sale and 400,000 fans arrive in the first minute for 18,000 seats. Follow a fan through a virtual queue, a seat hold that expires on its own after 8 minutes, a payment, and a booking that can never sell the same seat twice.',
  requirements: {
    functional: [
      'Fans pick specific seats on a map and get them held while they pay.',
      'A held seat is released automatically if the fan does not pay in time.',
      'No seat is ever sold twice; fans see near-live seat availability.'
    ],
    nonFunctional: [
      'The booking system receives a controlled rate, whatever the crowd size.',
      'Fair order: earlier arrivals are admitted first (after the opening randomisation).',
      'Bots cannot hoard seats: holds are limited per account and per payment card.'
    ]
  },
  estimates: [
    { label: 'Crowd at opening', value: '400,000 in 60 s', note: 'Mostly refreshing the page; without a queue that is ~20,000 req/s of seat-map reads and hold attempts.' },
    { label: 'Admission rate', value: '1,200 / min', note: 'Sized so checkouts finish in ~8 minutes and seat-map contention stays low.' },
    { label: 'Seats', value: '18,000', note: 'One event, ~600 sections and rows; seat state fits easily in Redis.' },
    { label: 'Sell-out', value: '≈ 25 min', note: 'At ~1,000 completed orders per minute with ~2 seats each.' }
  ],
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'fan', label: 'Fan browser', sub: 'Next.js', kind: 'client', icon: 'phone', x: 0, y: 0, desc: 'A fan who opened the event page a minute before the sale.' },
    { id: 'wr', label: 'Waiting room', sub: 'edge worker', kind: 'edge', icon: 'ticket', x: 1, y: 0, desc: 'Gives everyone a queue position and admits a fixed number per minute with a signed pass.' },
    { id: 'qstore', label: 'Queue store', sub: 'Redis', kind: 'cache', x: 1, y: 1, desc: 'Sorted set of queue positions and the admission counter.' },
    { id: 'api', label: 'Booking API', sub: 'FastAPI', kind: 'service', x: 2, y: 0, desc: 'Seat map, holds and orders. Only reachable with a valid admission pass.' },
    { id: 'holds', label: 'Seat holds', sub: 'Redis', kind: 'cache', icon: 'lock', x: 2, y: 1, desc: 'One key per seat with an expiry: the fast, contended part.' },
    { id: 'db', label: 'Bookings DB', sub: 'PostgreSQL', kind: 'db', x: 3, y: 1, desc: 'Source of truth for sold seats, with a unique constraint per event seat.' },
    { id: 'pay', label: 'Payments', sub: 'Stripe', kind: 'external', icon: 'card', x: 3, y: 0, desc: 'Card payment for the order.' },
    { id: 'sweeper', label: 'Expiry sweeper', sub: 'worker', kind: 'worker', icon: 'clock', x: 2, y: 2, desc: 'Cancels orders whose hold ran out and publishes freed seats.' },
    { id: 'live', label: 'Seat updates', sub: 'SSE fan-out', kind: 'service', icon: 'pulse', x: 0, y: 2, desc: 'Pushes seat changes to fans looking at the map.' }
  ],
  steps: [
    {
      from: 'fan', to: 'wr', label: 'GET /e/arena-dec-12',
      title: 'The fan arrives before the sale opens',
      caption: 'Everyone arriving before 10:00 lands in a pre-queue. At 10:00 their order is shuffled once, so arriving at 9:45 or 9:59 gives the same chance; later arrivals queue behind in arrival order.',
      text: ['A {{waiting room}} runs at the edge, so the crowd never reaches the booking servers. The queue page is a static page that polls a cheap endpoint.', 'Randomising the pre-queue removes the incentive to hammer refresh at 09:59:59.'],
      payloadKind: 'HTTP response',
      payload: { status: 200, page: 'queue.html', set_cookie: 'wr_ticket=wt_41f0c7…; Secure; HttpOnly; SameSite=Lax', state: { phase: 'pre-queue', opens_at: '2026-11-25T10:00:00+01:00' } },
      fields: { wr_ticket: 'An opaque, signed ticket id bound to this browser. Opening ten tabs does not give ten positions.' }
    },
    {
      from: 'wr', to: 'qstore', label: 'ZADD queue',
      title: 'A position in the queue',
      caption: 'At opening, every pre-queue ticket gets a random score; later arrivals get the current time as score. The fan\'s rank is their position: 15,340th.',
      text: ['Redis sorted sets give the rank of a member in O(log n), so 400,000 browsers polling their position every 10 seconds is about 40,000 cheap reads a second, served from replicas.'],
      payloadKind: 'Redis',
      payloadLang: 'redis',
      payload: String.raw`
> ZADD wr:arena-dec-12 0.6181302 wt_41f0c7        -- random score (pre-queue)
(integer) 1
> ZRANK wr:arena-dec-12 wt_41f0c7
(integer) 15339                                   -- 0-based: position 15,340
> GET wr:arena-dec-12:admitted
"14400"                                           -- admitted so far`,
      code: [{ lang: 'python', title: 'Queue status endpoint', src: String.raw`
@app.get("/wr/{event}/status")
async def status(event: str, wr_ticket: str = Cookie()):
    tid = verify_ticket(wr_ticket)                     # HMAC check, no DB
    rank = await redis_ro.zrank(f"wr:{event}", tid)
    admitted = int(await redis_ro.get(f"wr:{event}:admitted") or 0)
    if rank is not None and rank < admitted:
        return {"admitted": True, "pass": sign_pass(event, tid, ttl_s=900)}
    ahead = (rank or 0) - admitted
    return {"admitted": False, "position": ahead,
            "eta_min": round(ahead / ADMIT_PER_MIN, 1)}   # admitted counter rises 1,200/min` }]
    },
    {
      from: 'wr', to: 'fan', label: 'admitted + pass', reply: true,
      title: 'Admitted after about 13 minutes',
      caption: 'The admitted counter passes the fan\'s rank. The next poll returns a signed admission pass valid for 15 minutes, and the browser is sent to the seat map.',
      text: ['The pass is a short signed token (event, ticket, expiry). The booking API checks the signature locally on every call, so the queue cannot be skipped by calling the API directly.'],
      payloadKind: 'Admission pass',
      payload: { admitted: true, pass: { event: 'arena-dec-12', ticket: 'wt_41f0c7', exp: '2026-11-25T12:17:02+01:00', sig: 'Ed25519:9c1f…' }, redirect: '/e/arena-dec-12/seats' },
      failure: ['**Pass expires before checkout starts:** the fan goes back to the end of the queue. Shown clearly as a countdown on the page.']
    },
    {
      from: 'fan', to: 'api', label: 'GET /seats (map)',
      title: 'Load the seat map',
      caption: 'The API returns the section layout (static, cached at the CDN) plus a compact availability bitmap for this event. Then the browser subscribes to live seat updates.',
      text: ['Sending availability as a bitmap (one bit per seat, 18,000 bits ≈ 2.3 KB) instead of JSON objects keeps the map fast on phones.'],
      payloadKind: 'HTTP response',
      payload: { status: 200, body: { event: 'arena-dec-12', layout_url: 'https://cdn.example/layouts/arena-v4.json', availability: { encoding: 'bitmap-base64', seats: 18000, available: 6311, data: 'AP//+H8A…' }, version: 88124 } },
      fields: { version: 'Sequence number of seat changes. The live stream sends changes after this version, so nothing is missed between load and subscribe.' }
    },
    {
      from: 'fan', to: 'api', label: 'POST /holds [B-12-7, B-12-8]',
      title: 'The fan picks two seats',
      caption: 'The fan taps B-12-7 and B-12-8. The browser asks for a hold on both. Many others may be tapping the same seats at the same moment.',
      text: ['The hold request carries the pass and an idempotency key. Account limits (at most 4 seats per event) are checked before touching seat state.'],
      payloadKind: 'HTTP request',
      payload: { method: 'POST', path: '/v1/events/arena-dec-12/holds', headers: { 'X-Admission-Pass': 'eyJldmVudCI6…', 'Idempotency-Key': 'hold_5c21' }, body: { seats: ['B-12-7', 'B-12-8'] } }
    },
    {
      from: 'api', to: 'holds', label: 'Lua: SET NX EX 480 × 2',
      title: 'Hold both seats atomically, with an expiry',
      caption: 'A Lua script runs in Redis as one atomic step: if both seat keys are free, set both to this fan\'s hold id with an 8-minute expiry; otherwise set nothing.',
      text: ['All-or-nothing matters: holding B-12-7 but losing B-12-8 to someone else would leave the fan with one seat they did not want.', 'The {{ttl}} is the release mechanism. If the fan closes the tab, the keys disappear after 8 minutes without any job having to run. Seats of one event share a hash tag `{arena-dec-12}` so they live on the same Redis Cluster shard.'],
      payloadKind: 'Redis',
      payloadLang: 'redis',
      payload: String.raw`
-- KEYS: seat:{arena-dec-12}:B-12-7  seat:{arena-dec-12}:B-12-8   ARGV: hld_7Qp2 480
for i, k in ipairs(KEYS) do
  if redis.call('EXISTS', k) == 1 then return {0, k} end   -- someone holds it
end
for i, k in ipairs(KEYS) do
  redis.call('SET', k, ARGV[1], 'EX', ARGV[2])
end
return {1}

> EVALSHA 7d0e… 2 seat:{arena-dec-12}:B-12-7 seat:{arena-dec-12}:B-12-8 hld_7Qp2 480
1) (integer) 1                                   -- both held until 12:10:31`,
      failure: ['**One seat already held:** the script returns `{0, "seat:…:B-12-8"}`; the API answers 409 with that seat, and the map greys it out. Nothing is held.', '**Redis primary fails over:** a hold written just before the failover can be lost on the replica. The database unique constraint in the booking step is the final guard, so a seat still cannot be sold twice.']
    },
    {
      from: 'api', to: 'live', label: 'seat.held × 2', async: true,
      title: 'Everyone else sees the seats go grey',
      caption: 'The API publishes a seat change; the live service pushes it to the ~9,000 fans currently on the map, so they stop tapping seats that are taken.',
      text: ['Updates are batched every 250 ms per event, so a burst of holds becomes one small message per connected browser instead of hundreds.'],
      payloadKind: 'SSE message',
      payloadLang: 'text',
      payload: String.raw`
event: seats
id: 88125
data: {"held":["B-12-7","B-12-8","C-03-1"],"freed":["A-01-9"],"available":6308}`
    },
    {
      from: 'api', to: 'db', label: 'INSERT order PENDING',
      title: 'Create a pending order with a deadline',
      caption: 'The API records a PENDING order for the two seats, with the same 8-minute deadline as the hold, and returns the checkout page with a visible countdown.',
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
INSERT INTO orders (id, event_id, user_id, hold_id, status, total_minor, expires_at)
VALUES ('tko_33a1', 'arena-dec-12', 'usr_ana', 'hld_7Qp2', 'PENDING', 15800,
        now() + interval '8 minutes');
INSERT INTO order_seats (order_id, event_id, seat) VALUES
  ('tko_33a1', 'arena-dec-12', 'B-12-7'), ('tko_33a1', 'arena-dec-12', 'B-12-8');`,
      text: ['Two places now know about the hold: Redis (fast, for contention) and PostgreSQL (durable, for the order). The design treats Redis as advisory and the database as the truth.']
    },
    {
      from: 'fan', to: 'pay', label: 'confirm card',
      title: 'The fan pays',
      caption: 'The checkout confirms a PaymentIntent with the card, including a 3-D Secure check from the bank. Payment must succeed before the hold expires.',
      text: ['The PaymentIntent was created server-side with the order id in its metadata and an idempotency key, so a refresh during payment cannot charge twice.'],
      payloadKind: 'Payment',
      payload: { payment_intent: 'pi_3QY…', amount: 15800, currency: 'eur', metadata: { order_id: 'tko_33a1', hold_id: 'hld_7Qp2' }, status: 'succeeded', webhook: 'payment_intent.succeeded → /webhooks/stripe' }
    },
    {
      from: 'pay', to: 'db', label: 'webhook → book seats',
      title: 'Book the seats: the database is the final guard',
      caption: 'The payment webhook books the seats in one transaction. A unique constraint on (event, seat) in sold_seats makes double-selling impossible, whatever happened in Redis.',
      text: ['If the hold expired a few seconds before payment completed and someone else bought the seat, the INSERT fails, the transaction rolls back, and the payment is refunded automatically with an apology and priority re-entry.'],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
BEGIN;
UPDATE orders SET status = 'PAID', paid_at = now()
  WHERE id = 'tko_33a1' AND status = 'PENDING';                -- 1 row
INSERT INTO sold_seats (event_id, seat, order_id) VALUES
  ('arena-dec-12', 'B-12-7', 'tko_33a1'),
  ('arena-dec-12', 'B-12-8', 'tko_33a1');                       -- PK (event_id, seat)
COMMIT;
-- then: DEL both Redis hold keys, publish seat.sold, issue tickets (QR codes)`,
      code: [{ lang: 'python', title: 'Webhook handler', src: String.raw`
@router.post("/webhooks/stripe")
async def stripe_webhook(req: Request):
    ev = stripe.Webhook.construct_event(await req.body(), req.headers["stripe-signature"], SECRET)
    if ev.type != "payment_intent.succeeded":
        return {"ignored": ev.type}
    oid = ev.data.object.metadata["order_id"]
    try:
        async with pool.acquire() as c, c.transaction():
            n = await c.execute("UPDATE orders SET status='PAID', paid_at=now() "
                                "WHERE id=$1 AND status='PENDING'", oid)
            if n == "UPDATE 0":
                return {"already": True}           # webhook retried: fine
            await c.executemany("INSERT INTO sold_seats(event_id, seat, order_id) "
                                "VALUES($1,$2,$3)", await seats_of(c, oid))
    except asyncpg.UniqueViolationError:
        await refund_and_apologise(oid, ev.data.object.id)   # seat sold after hold expired
        return {"refunded": True}
    await release_hold_keys(oid); await publish_sold(oid); await issue_tickets(oid)
    return {"booked": oid}` }],
      failure: ['**Webhook delivered twice:** the `status = PENDING` guard makes the second delivery a no-op.', '**Webhook delayed:** the order stays PENDING past its deadline; the sweeper sees a succeeded PaymentIntent and books it instead of cancelling.']
    },
    {
      from: 'sweeper', to: 'db', label: 'expire unpaid orders',
      title: 'Unpaid holds go back on sale',
      caption: 'Another fan held C-03-1 but never paid. Their Redis key already expired; every 15 seconds the sweeper cancels such orders after checking with Stripe, and publishes the seat as free.',
      text: ['The sweeper checks the PaymentIntent status before cancelling, so a payment that succeeded but whose webhook is late is booked, not cancelled.'],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
SELECT id, payment_intent FROM orders
WHERE status = 'PENDING' AND expires_at < now() - interval '30 seconds'
ORDER BY expires_at LIMIT 500
FOR UPDATE SKIP LOCKED;                 -- several sweepers can run safely

UPDATE orders SET status = 'EXPIRED' WHERE id = 'tko_2f90';
-- publish seat.freed C-03-1  → map turns it available again`
    },
    {
      from: 'live', to: 'fan', label: 'tickets issued', reply: true,
      title: 'Tickets in the fan\'s account',
      caption: 'The fan\'s checkout page switches to "You\'re going!" with two mobile tickets. Each ticket has a rotating QR code to make screenshots useless for resale.',
      text: ['The ticket QR encodes a signed payload with a time step (like a TOTP), so a copy that is more than a minute old fails at the gate scanner.'],
      payloadKind: 'Order',
      payload: { order: 'tko_33a1', status: 'PAID', seats: ['B-12-7', 'B-12-8'], tickets: [{ id: 'tkt_9a1', seat: 'B-12-7', qr: 'rotating, 30 s step' }, { id: 'tkt_9a2', seat: 'B-12-8', qr: 'rotating, 30 s step' }], total: '€158.00' }
    }
  ],
  api: [
    { verb: 'GET', path: '/wr/{event}/status', desc: 'Queue position and ETA, or an admission pass.' },
    { verb: 'GET', path: '/v1/events/{event}/seats', desc: 'Availability bitmap and version; needs the pass.' },
    { verb: 'POST', path: '/v1/events/{event}/holds', desc: 'Hold up to 4 seats atomically for 8 minutes; 409 if any is taken.' },
    { verb: 'POST', path: '/webhooks/stripe', desc: 'Books seats when payment succeeds; refunds if a seat was sold after expiry.' }
  ],
  schema: String.raw`
CREATE TABLE orders (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL, user_id TEXT NOT NULL, hold_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','PAID','EXPIRED','REFUNDED')),
  total_minor INT NOT NULL, payment_intent TEXT, expires_at TIMESTAMPTZ, paid_at TIMESTAMPTZ
);
CREATE INDEX ON orders (expires_at) WHERE status = 'PENDING';
CREATE TABLE order_seats (order_id TEXT REFERENCES orders, event_id TEXT, seat TEXT);
CREATE TABLE sold_seats (
  event_id TEXT, seat TEXT, order_id TEXT NOT NULL,
  PRIMARY KEY (event_id, seat)          -- the guarantee: one sale per seat
);

-- Redis
-- wr:{event}                 ZSET ticket -> score (queue)
-- wr:{event}:admitted        counter raised by the admission ticker
-- seat:{event}:{seat}        hold id, EX 480`,
  decisions: [
    { q: 'How do you stop two fans buying the same seat?', options: [
      { verdict: 'bad', name: 'Check availability, then insert', why: 'Two requests both see "free" and both insert.' },
      { verdict: 'good', name: 'SELECT … FOR UPDATE on seat rows', why: 'Correct, but hot rows lock up under thousands of concurrent taps.' },
      { verdict: 'great', name: 'Atomic Redis holds with TTL + unique constraint at booking', why: 'Fast contention handling and a database guarantee as the last word.' }
    ] },
    { q: 'How do you handle 400,000 people at once?', options: [
      { verdict: 'bad', name: 'Autoscale the booking API', why: 'The seats, not the servers, are the bottleneck; scaling adds contention.' },
      { verdict: 'great', name: 'Waiting room at the edge with a fixed admission rate', why: 'The backend sees a steady, sized load and fans get an honest ETA.' }
    ] }
  ],
  refs: [
    { label: 'Redis: Scripting with Lua', url: 'https://redis.io/docs/latest/develop/interact/programmability/eval-intro/' },
    { label: 'Cloudflare Waiting Room', url: 'https://developers.cloudflare.com/waiting-room/' },
    { label: 'PostgreSQL: SELECT … FOR UPDATE SKIP LOCKED', url: 'https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE' }
  ]
});
