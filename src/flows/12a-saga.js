flow({
  id: 'saga-order',
  title: 'Distributed transaction: order saga with compensation',
  category: 'Commerce and money',
  tags: ['Saga', 'Orchestration', 'Outbox', 'Idempotency', 'Compensating transactions', 'Temporal-style workflow'],
  summary: 'Placing an order touches three services that each own their database: orders, inventory and payments. There is no shared transaction. Follow an orchestrator that runs the steps, persists its state after each one, and when the payment is declined undoes the stock reservation, so the system ends consistent.',
  requirements: {
    functional: [
      'Placing an order reserves stock, charges the card, and confirms, or ends cancelled with nothing reserved or charged.',
      'The customer sees a clear status: pending, confirmed or failed with a reason.',
      'Each service keeps its own database; no distributed lock or two-phase commit across them.'
    ],
    nonFunctional: [
      'Survives a crash of any service or the orchestrator at any point without losing or duplicating effects.',
      'Every step is idempotent so retries are safe.',
      'p95 time from click to confirmed under 3 seconds.'
    ]
  },
  estimates: [
    { label: 'Orders', value: '300 / s', note: 'Peak during a sale.' },
    { label: 'Messages per order', value: '≈ 8', note: 'Command and reply for 3 steps, plus events. 2,400 msg/s at peak.' },
    { label: 'Payment declines', value: '≈ 6%', note: 'So compensation is a normal path, not an edge case: ~18 / s at peak.' },
    { label: 'Saga state rows', value: '26M / year', note: 'Kept 90 days hot for support, then archived.' }
  ],
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'web', label: 'Checkout page', sub: 'Next.js', kind: 'client', icon: 'cart', x: 0, y: 0, desc: 'The customer presses "Place order".' },
    { id: 'orders', label: 'Orders API', sub: 'FastAPI', kind: 'service', x: 1, y: 0, desc: 'Creates the order in PENDING and starts the saga through its outbox.' },
    { id: 'odb', label: 'Orders DB', sub: 'PostgreSQL', kind: 'db', x: 1, y: 1, desc: 'Orders, the outbox table, and the saga state.' },
    { id: 'orch', label: 'Saga orchestrator', sub: 'workflow worker', kind: 'worker', icon: 'cpu', x: 2, y: 1, desc: 'Runs the steps in order, records each result, and runs compensations when a step fails.' },
    { id: 'bus', label: 'Message broker', sub: 'Kafka', kind: 'queue', x: 2, y: 0, desc: 'Carries commands to services and their replies back.' },
    { id: 'inv', label: 'Inventory service', sub: 'FastAPI', kind: 'service', icon: 'box', x: 3, y: 0, desc: 'Owns stock. Reserves and releases items.' },
    { id: 'pay', label: 'Payments service', sub: 'FastAPI', kind: 'service', icon: 'card', x: 3, y: 1, desc: 'Owns charges. Talks to the card processor.' },
    { id: 'psp', label: 'Card processor', sub: 'Stripe', kind: 'external', icon: 'card', x: 3, y: 2, desc: 'Authorises the card.' },
    { id: 'notify', label: 'Notifications', sub: 'email / push', kind: 'service', icon: 'bell', x: 1, y: 2, desc: 'Tells the customer the outcome.' }
  ],
  steps: [
    {
      from: 'web', to: 'orders', label: 'POST /v1/orders',
      title: 'The customer places the order',
      caption: 'The checkout sends the cart and an idempotency key. If the network drops and the browser retries, the same key returns the same order instead of creating a second one.',
      text: ['The {{idempotency key}} is generated once per checkout attempt in the browser and kept in session storage, so a double click or a retry after a timeout cannot duplicate the order.'],
      payloadKind: 'HTTP request',
      payload: { method: 'POST', path: '/v1/orders', headers: { 'Idempotency-Key': 'chk_9b2e41f0', Authorization: 'Bearer eyJ…' }, body: { items: [{ sku: 'SPG6-42-BLU', qty: 1 }, { sku: 'SOCK-TRL-M', qty: 2 }], payment_method: 'pm_1QAbc', shipping_address_id: 'addr_33' } },
      code: [{ lang: 'ts', title: 'Server action: place order', src: String.raw`
"use server";
export async function placeOrder(cart: Cart, key: string) {
  const res = await fetch(API + "/v1/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key,
               Authorization: "Bearer " + (await getToken()) },
    body: JSON.stringify(toOrderRequest(cart)),
  });
  if (res.status === 202) redirect("/orders/" + (await res.json()).id);  // shows live status
  throw new Error(await res.text());
}` }]
    },
    {
      from: 'orders', to: 'odb', label: 'INSERT order + outbox',
      title: 'One local transaction: order row and outbox row',
      caption: 'The Orders API writes the order as PENDING and, in the same transaction, an outbox row that says "start the saga". Either both are saved or neither is.',
      text: ['This is the {{outbox pattern}} pattern. Writing the order and then publishing to Kafka separately would be a {{dual write}}: a crash between the two leaves an order that no saga ever processes.'],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
BEGIN;
INSERT INTO orders (id, user_id, status, total_minor, currency, idem_key)
VALUES ('ord_7731', 'usr_ana', 'PENDING', 11700, 'EUR', 'chk_9b2e41f0');
INSERT INTO order_items (order_id, sku, qty, unit_minor) VALUES
  ('ord_7731', 'SPG6-42-BLU', 1, 8900), ('ord_7731', 'SOCK-TRL-M', 2, 1400);
INSERT INTO outbox (id, topic, key, payload)
VALUES ('obx_51', 'saga.start', 'ord_7731', '{"saga":"place_order","order_id":"ord_7731"}');
COMMIT;`,
      failure: ['**Same idempotency key again:** the unique index on `idem_key` makes the insert fail; the API returns the existing order with 202 instead.']
    },
    {
      from: 'orders', to: 'web', label: '202 Accepted', reply: true,
      title: 'Answer immediately with a pending order',
      caption: 'The API does not wait for stock and payment. It returns 202 with the order id; the page subscribes to status updates and shows "Placing your order…".',
      text: ['Returning early keeps the request short and makes every later step retryable in the background. The page listens on Server-Sent Events, the same pattern as the notification flow.'],
      payloadKind: 'HTTP response',
      payload: { status: 202, body: { id: 'ord_7731', status: 'PENDING', status_url: '/v1/orders/ord_7731/events' } }
    },
    {
      from: 'odb', to: 'orch', label: 'outbox relay → saga.start', async: true,
      title: 'The saga starts',
      caption: 'A relay reads new outbox rows and publishes them. The orchestrator receives saga.start, creates a saga instance and records its first state before doing anything.',
      text: ['The orchestrator is a small state machine whose state lives in a database table. After every step it writes where it is, so a crashed orchestrator picks up exactly where it stopped. Tools like Temporal do this for you by replaying an event history.'],
      payloadKind: 'Saga state',
      payload: { saga_id: 'sg_ord_7731', type: 'place_order', state: 'RESERVING_STOCK', step: 1, completed: [], compensations_pending: [], attempts: 0, started_at: '2026-11-25T11:41:43.210Z' },
      fields: { completed: 'Steps that succeeded. If something fails later, their compensations run in reverse order.', saga_id: 'Derived from the order id, so starting the same saga twice finds the existing instance.' }
    },
    {
      from: 'orch', to: 'bus', label: 'cmd: ReserveStock',
      title: 'Command: reserve the items',
      caption: 'The orchestrator sends a ReserveStock command to the inventory service with a command id. Commands go over Kafka, so they survive the inventory service being briefly down.',
      text: ['{{orchestration}} puts the order of steps in one place you can read. With choreography, each service would listen for the previous one\'s event; fine for two steps, hard to follow for five.'],
      payloadKind: 'Command',
      payload: { topic: 'inventory.commands', key: 'ord_7731', value: { type: 'ReserveStock', command_id: 'cmd_sg_ord_7731_1', saga_id: 'sg_ord_7731', order_id: 'ord_7731', items: [{ sku: 'SPG6-42-BLU', qty: 1 }, { sku: 'SOCK-TRL-M', qty: 2 }], reply_to: 'saga.replies', hold_minutes: 15 } },
      fields: { command_id: 'Saga id + step number. The inventory service stores processed ids, so a redelivered command does nothing the second time.', hold_minutes: 'Reservations expire on their own if nobody confirms or releases them, a safety net if the saga is lost.' }
    },
    {
      from: 'bus', to: 'inv', label: 'reserve (atomic)',
      title: 'Inventory reserves both items',
      caption: 'In one local transaction the inventory service checks the command id was not processed, decrements available stock with a guard so it cannot go negative, and records the reservation.',
      text: ['The `available >= qty` condition in the UPDATE makes the check and the decrement one atomic step; two concurrent orders for the last pair cannot both succeed.'],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
BEGIN;
INSERT INTO processed_commands (id) VALUES ('cmd_sg_ord_7731_1');   -- PK: duplicate = already done
UPDATE stock SET available = available - 1
  WHERE sku = 'SPG6-42-BLU' AND available >= 1;   -- 1 row
UPDATE stock SET available = available - 2
  WHERE sku = 'SOCK-TRL-M'  AND available >= 2;   -- 1 row
INSERT INTO reservations (id, order_id, status, expires_at)
  VALUES ('rsv_88', 'ord_7731', 'HELD', now() + interval '15 minutes');
INSERT INTO outbox (topic, key, payload) VALUES
  ('saga.replies', 'ord_7731', '{"command_id":"cmd_sg_ord_7731_1","ok":true,"reservation_id":"rsv_88"}');
COMMIT;`,
      code: [{ lang: 'python', title: 'Idempotent command handler', src: String.raw`
async def handle_reserve(cmd: ReserveStock):
    async with pool.acquire() as c, c.transaction():
        try:
            await c.execute("INSERT INTO processed_commands(id) VALUES($1)", cmd.command_id)
        except asyncpg.UniqueViolationError:
            return                                 # already handled; reply was already sent via outbox
        for it in cmd.items:
            n = await c.execute("UPDATE stock SET available = available - $2 "
                                "WHERE sku = $1 AND available >= $2", it.sku, it.qty)
            if n == "UPDATE 0":
                raise OutOfStock(it.sku)           # whole transaction rolls back
        rid = await create_reservation(c, cmd)
        await outbox(c, "saga.replies", cmd.order_id,
                     {"command_id": cmd.command_id, "ok": True, "reservation_id": rid})` }],
      failure: ['**Out of stock:** the transaction rolls back, and a separate transaction writes a reply `ok: false, reason: OUT_OF_STOCK`. Nothing was done yet, so the saga simply ends with the order FAILED.', '**Inventory crashes after COMMIT but before the reply is published:** the outbox relay publishes it after restart. If the command is redelivered, `processed_commands` makes it a no-op.']
    },
    {
      from: 'inv', to: 'orch', label: 'reply: reserved', async: true,
      title: 'The orchestrator records step 1 as done',
      caption: 'The reply arrives. The orchestrator saves that step 1 succeeded and that its compensation is ReleaseStock(rsv_88), then moves on.',
      text: ['Recording the compensation together with the success is what makes a later rollback possible: the orchestrator always knows exactly what to undo.'],
      payloadKind: 'Saga state',
      payload: { saga_id: 'sg_ord_7731', state: 'CHARGING', step: 2, completed: [{ step: 'reserve_stock', reservation_id: 'rsv_88' }], compensations_pending: [{ type: 'ReleaseStock', reservation_id: 'rsv_88' }], updated_at: '2026-11-25T11:41:43.402Z' },
      fields: { compensations_pending: 'Stack of undo actions. Charging fails → pop and run ReleaseStock.' }
    },
    {
      from: 'orch', to: 'pay', label: 'cmd: ChargeCard',
      title: 'Command: charge the card',
      caption: 'The orchestrator asks payments to charge €117 to the saved card, again with a command id that payments forwards to Stripe as its idempotency key.',
      text: ['Passing the same id all the way to the processor means a retried command can never charge twice, even if payments crashed after Stripe accepted the first attempt.'],
      payloadKind: 'Command',
      payload: { topic: 'payments.commands', key: 'ord_7731', value: { type: 'ChargeCard', command_id: 'cmd_sg_ord_7731_2', order_id: 'ord_7731', amount_minor: 11700, currency: 'EUR', customer: 'cus_ana', payment_method: 'pm_1QAbc', reply_to: 'saga.replies' } }
    },
    {
      from: 'pay', to: 'psp', label: 'create PaymentIntent',
      title: 'The bank declines',
      caption: 'Payments calls Stripe with the idempotency key. The issuing bank declines the card for insufficient funds. This is a business failure, not a technical one: retrying will not help.',
      text: ['The orchestrator must tell apart failures worth retrying (timeouts, 5xx) from final ones (declined). Retrying a decline only annoys the bank and the customer.'],
      payloadKind: 'Processor response',
      payload: { request: { method: 'POST', url: 'https://api.stripe.com/v1/payment_intents', headers: { 'Idempotency-Key': 'cmd_sg_ord_7731_2' }, form: { amount: 11700, currency: 'eur', customer: 'cus_ana', payment_method: 'pm_1QAbc', confirm: true, off_session: true } }, response: { status: 402, error: { type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds', payment_intent: { id: 'pi_3QX…', status: 'requires_payment_method' } } } },
      fields: { decline_code: 'Mapped to a customer-facing reason. Some codes (like `fraudulent`) are shown as a generic decline on purpose.' },
      failure: ['**Timeout calling Stripe:** payments retries with the same idempotency key; Stripe returns the original result if the first call actually went through.', '**3-D Secure required:** the reply is `ACTION_REQUIRED`; the saga waits (with a timeout) while the page asks the customer to authenticate.']
    },
    {
      from: 'pay', to: 'orch', label: 'reply: declined', async: true,
      title: 'Step 2 failed: switch to compensating',
      caption: 'Payments replies ok: false with reason CARD_DECLINED. The orchestrator records the failure and changes state to COMPENSATING. Only step 1 needs undoing.',
      text: ['A saga does not roll back; it moves forward through {{compensating transaction}}s. The reservation really existed for a few hundred milliseconds and its release is a new, recorded fact.'],
      payloadKind: 'Saga state',
      payload: { saga_id: 'sg_ord_7731', state: 'COMPENSATING', failed_step: { step: 'charge_card', reason: 'CARD_DECLINED', decline_code: 'insufficient_funds' }, compensations_pending: [{ type: 'ReleaseStock', reservation_id: 'rsv_88' }] },
      code: [{ lang: 'python', title: 'Orchestrator reply handling', src: String.raw`
STEPS = [
    Step("reserve_stock", do=ReserveStock, undo=ReleaseStock),
    Step("charge_card",   do=ChargeCard,   undo=RefundCharge),
    Step("confirm_order", do=ConfirmOrder, undo=None),
]

async def on_reply(r: Reply):
    async with db.transaction():
        saga = await load_for_update(r.saga_id)        # row lock: one reply at a time
        if r.command_id in saga.seen_replies:
            return                                     # duplicate delivery
        saga.seen_replies.add(r.command_id)
        if r.ok:
            saga.record_success(r)
            nxt = saga.next_step()
            await (send(nxt.do(saga)) if nxt else finish(saga, "CONFIRMED"))
        elif r.retryable and saga.attempts < 5:
            await send_later(saga.current.do(saga), backoff(saga.attempts))
        else:
            saga.state = "COMPENSATING"
            await run_next_compensation(saga)          # pops the stack, newest first
        await save(saga)` }]
    },
    {
      from: 'orch', to: 'inv', label: 'cmd: ReleaseStock',
      title: 'Compensate: release the reservation',
      caption: 'The orchestrator sends ReleaseStock for rsv_88. Inventory adds the items back and marks the reservation RELEASED, idempotently: releasing twice changes nothing.',
      text: ['Compensations must be retried until they succeed. A compensation that gives up leaves stock locked forever, which is why the reservation also expires by itself after 15 minutes.'],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
BEGIN;
UPDATE reservations SET status = 'RELEASED'
  WHERE id = 'rsv_88' AND status = 'HELD'          -- 1 row (0 rows if already released)
  RETURNING order_id;
UPDATE stock SET available = available + 1 WHERE sku = 'SPG6-42-BLU';   -- only if 1 row above
UPDATE stock SET available = available + 2 WHERE sku = 'SOCK-TRL-M';
INSERT INTO outbox (topic, key, payload) VALUES
  ('saga.replies', 'ord_7731', '{"command_id":"cmd_sg_ord_7731_c1","ok":true}');
COMMIT;`,
      failure: ['**Inventory down:** the command waits in Kafka; the orchestrator retries with backoff and alerts after 10 minutes. The 15-minute reservation expiry frees the stock anyway.']
    },
    {
      from: 'orch', to: 'odb', label: 'order → FAILED',
      title: 'Finish: the order ends cleanly failed',
      caption: 'With all compensations done, the orchestrator marks the saga COMPENSATED and the order FAILED with reason CARD_DECLINED. Stock is back, no money moved.',
      text: ['The final state is consistent across all three services even though they never shared a transaction. That is the guarantee a saga gives: eventually all-or-nothing.'],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
UPDATE orders SET status = 'FAILED', failure_reason = 'CARD_DECLINED', updated_at = now()
WHERE id = 'ord_7731' AND status = 'PENDING';
UPDATE sagas SET state = 'COMPENSATED', finished_at = now() WHERE id = 'sg_ord_7731';
INSERT INTO outbox (topic, key, payload)
VALUES ('order.events', 'ord_7731', '{"type":"OrderFailed","reason":"CARD_DECLINED"}');`
    },
    {
      from: 'orch', to: 'notify', label: 'OrderFailed', async: true,
      title: 'Tell the customer what to do next',
      caption: 'The status stream updates the page to "Your bank declined the card" with a button to try another card, and an email follows. Trying again starts a new saga with a new key.',
      text: ['Reasons shown to customers are mapped from internal codes. The page keeps the cart, so trying another card is one tap.'],
      payloadKind: 'Event',
      payload: { topic: 'order.events', value: { type: 'OrderFailed', order_id: 'ord_7731', user_id: 'usr_ana', reason: 'CARD_DECLINED', customer_message: 'Your bank declined the payment. Try another card or payment method.', cart_preserved: true } }
    }
  ],
  api: [
    { verb: 'POST', path: '/v1/orders', desc: 'Create an order; needs `Idempotency-Key`; returns 202 PENDING.' },
    { verb: 'GET', path: '/v1/orders/{id}', desc: 'Current status: PENDING, CONFIRMED or FAILED with reason.' },
    { verb: 'GET', path: '/v1/orders/{id}/events', desc: 'Server-Sent Events stream of status changes.' }
  ],
  schema: String.raw`
-- orders service
CREATE TABLE orders (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL,
  total_minor INT NOT NULL, currency CHAR(3) NOT NULL,
  idem_key TEXT UNIQUE NOT NULL, failure_reason TEXT, updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE sagas (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, state TEXT NOT NULL,
  data JSONB NOT NULL,          -- completed steps, compensation stack, seen replies
  attempts INT DEFAULT 0, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ
);
CREATE TABLE outbox (id BIGSERIAL PRIMARY KEY, topic TEXT, key TEXT, payload JSONB,
                     created_at TIMESTAMPTZ DEFAULT now(), published_at TIMESTAMPTZ);

-- inventory service
CREATE TABLE stock (sku TEXT PRIMARY KEY, available INT NOT NULL CHECK (available >= 0));
CREATE TABLE reservations (id TEXT PRIMARY KEY, order_id TEXT, status TEXT, expires_at TIMESTAMPTZ);
CREATE TABLE processed_commands (id TEXT PRIMARY KEY, at TIMESTAMPTZ DEFAULT now());`,
  decisions: [
    { q: 'How do you keep three services consistent?', options: [
      { verdict: 'bad', name: 'Call them one after another from the request handler', why: 'A crash halfway leaves stock reserved and no order, with no record of what to undo.' },
      { verdict: 'ok', name: 'Two-phase commit (XA) across databases', why: 'Strong, but blocks while the coordinator is down and few modern stores support it.' },
      { verdict: 'great', name: 'Saga with persisted state, idempotent steps and compensations', why: 'Each service stays independent; failures end in a defined, consistent state.' }
    ] },
    { q: 'Orchestration or choreography?', options: [
      { verdict: 'good', name: 'Choreography: services react to each other\'s events', why: 'No central component, but the flow is spread across services and hard to change.' },
      { verdict: 'great', name: 'Orchestration for multi-step business processes', why: 'The whole process is readable in one place, with timeouts and compensations explicit.' }
    ] }
  ],
  refs: [
    { label: 'Garcia-Molina & Salem: Sagas (1987)', url: 'https://www.cs.cornell.edu/andru/cs711/2002fa/reading/sagas.pdf' },
    { label: 'microservices.io: Saga pattern', url: 'https://microservices.io/patterns/data/saga.html' },
    { label: 'Temporal: What is a Temporal Workflow?', url: 'https://docs.temporal.io/workflows' }
  ]
});
