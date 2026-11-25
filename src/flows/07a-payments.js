flow({
  id: 'payment-checkout',
  title: 'Card payment checkout',
  category: 'Commerce & money',
  tags: ['Stripe', 'Idempotency', 'Webhooks', '3-D Secure', 'Ledger'],
  summary: 'Leo pays €59.90 for a concert ticket. His card number never touches your servers, a double tap charges him once, his bank asks for a 3-D Secure confirmation, and the order is fulfilled only when a signed webhook confirms the money, then recorded in a double-entry ledger.',
  requirements: {
    functional: [
      'Customers pay by card (and wallets) on a checkout page; orders are confirmed only when payment succeeds.',
      'Strong Customer Authentication (3-D Secure) when the bank requires it.',
      'Refunds, and a daily reconciliation against the payment provider\'s reports.'
    ],
    nonFunctional: [
      'A customer is never charged twice for one order, even with retries, timeouts and double clicks.',
      'Card data never touches our servers (keeps us in the lightest PCI DSS scope).',
      'Every cent is traceable: balances are derived from an append-only ledger.'
    ]
  },
  estimates: [
    { label: 'Checkouts', value: '≈ 50 / s peak', note: 'Assumption: 1M orders a day with a 4× evening peak.' },
    { label: 'PSP latency', value: '1–3 s', note: 'Card networks are slow; never hold a DB transaction open across the call.' },
    { label: '3DS rate', value: '≈ 20–40%', note: 'Varies by country and amount; in the EU, SCA applies to most online card payments.' },
    { label: 'Webhooks', value: '≈ 3 per order', note: 'payment_intent.created / succeeded / charge updates. Expect duplicates and out-of-order delivery.' }
  ],
  grid: { cols: 5, rows: 2 },
  nodes: [
    { id: 'browser', label: 'Checkout page', sub: 'Next.js + Stripe.js', kind: 'client', icon: 'card', x: 0, y: 0, desc: 'Renders Stripe\'s Payment Element: card fields live in an iframe served by Stripe.' },
    { id: 'api', label: 'Checkout API', sub: 'FastAPI', kind: 'service', x: 1, y: 0, desc: 'Creates the order and the PaymentIntent, with idempotency keys on both sides.' },
    { id: 'db', label: 'Orders DB', sub: 'PostgreSQL', kind: 'db', x: 2, y: 0, desc: 'Orders with a status machine, payment attempts, and processed webhook ids.' },
    { id: 'psp', label: 'Stripe', sub: 'PSP', kind: 'external', icon: 'card', x: 1, y: 1, desc: 'Payment service provider: tokenises the card, talks to card networks and banks.' },
    { id: 'bank', label: 'Card issuer', sub: 'Leo\'s bank (3DS)', kind: 'external', icon: 'lock', x: 0, y: 1, desc: 'Approves or declines, and may challenge Leo in its banking app.' },
    { id: 'hook', label: 'Webhook receiver', sub: 'FastAPI', kind: 'service', icon: 'bell', x: 2, y: 1, desc: 'Verifies Stripe\'s signature, records the event, enqueues processing, answers 200 fast.' },
    { id: 'q', label: 'Payment events', sub: 'queue', kind: 'queue', x: 3, y: 1, desc: 'Decouples webhook receipt from fulfilment so slow work never makes Stripe retry.' },
    { id: 'ful', label: 'Fulfilment', sub: 'worker', kind: 'worker', x: 3, y: 0, desc: 'Marks the order paid, issues the ticket, writes ledger entries, sends the receipt.' },
    { id: 'ledger', label: 'Ledger', sub: 'PostgreSQL', kind: 'db', icon: 'chart', x: 4, y: 0, desc: 'Append-only double-entry journal. Every money movement is two entries that sum to zero.' },
    { id: 'recon', label: 'Reconciliation', sub: 'nightly job', kind: 'worker', icon: 'clock', x: 4, y: 1, desc: 'Compares the ledger with Stripe\'s balance transactions and payout reports.' }
  ],
  steps: [
    {
      from: 'browser', to: 'api', label: 'POST /v1/checkout',
      title: 'Leo clicks "Pay €59.90"',
      caption: 'The page posts the cart id and an idempotency key generated when the checkout page loaded. Prices come from the server, never from the browser.',
      text: ['The browser sends what Leo wants, not what it costs. The API recomputes the total from the catalog, so editing the request in DevTools cannot buy a ticket for €0.01.', 'The {{idempotency key}} is created once per checkout page, so a double click or a retry after a network error maps to the same order.'],
      payloadKind: 'HTTP request',
      payload: { method: 'POST', path: '/v1/checkout', headers: { Cookie: 'session=…', 'Idempotency-Key': 'chk_5f0b2c1e-9a7d-4d3e-8b61-0c2f7a9e4d11' }, body: { cart_id: 'cart_77Q1', currency: 'EUR' } }
    },
    {
      from: 'api', to: 'db', label: 'INSERT order (pending)',
      title: 'Create the order before talking to Stripe',
      caption: 'The order row is written first with status pending_payment and the idempotency key. If the key already exists, the existing order (and its PaymentIntent) is returned.',
      text: ['Creating our record before the external call means that if the process dies right after Stripe creates a PaymentIntent, we still know which order it belongs to and can find it again. Amounts are stored as integers in minor units (5990 cents), never as floats.'],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
INSERT INTO orders (id, customer_id, amount_minor, currency, status, idempotency_key)
VALUES ('ord_01JDQ9', 'usr_leo', 5990, 'EUR', 'pending_payment',
        'chk_5f0b2c1e-9a7d-4d3e-8b61-0c2f7a9e4d11')
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING id;            -- no row returned ⇒ a retry: load the existing order`,
      fields: { amount_minor: '€59.90 as 5990 cents. Floats cannot represent 0.10 exactly.' }
    },
    {
      from: 'api', to: 'psp', label: 'create PaymentIntent',
      title: 'Create a PaymentIntent with the same idempotency',
      caption: 'The API asks Stripe for a PaymentIntent of 5990 EUR, passing its own idempotency key derived from the order id. Stripe returns a client_secret for the browser.',
      text: ['Stripe stores the result of a request per Idempotency-Key for at least 24 hours: a retried create returns the same PaymentIntent instead of a second one.', 'Putting `order_id` in `metadata` is how every later webhook finds its way back to the order.'],
      payloadKind: 'Stripe API call',
      payload: { request: { method: 'POST', url: 'https://api.stripe.com/v1/payment_intents', headers: { Authorization: 'Bearer sk_live_…', 'Idempotency-Key': 'pi-create-ord_01JDQ9' }, form: { amount: 5990, currency: 'eur', 'automatic_payment_methods[enabled]': true, 'metadata[order_id]': 'ord_01JDQ9' } }, response: { id: 'pi_3QJ8sQ2eZvKYlo2C1abc', status: 'requires_payment_method', client_secret: 'pi_3QJ8sQ2eZvKYlo2C1abc_secret_Xy…', amount: 5990 } },
      fields: { 'response.client_secret': 'Lets the browser confirm this one PaymentIntent. Not a secret key; it cannot create charges.' },
      code: [{ lang: 'python', title: 'Checkout endpoint (FastAPI + stripe-python)', src: String.raw`
@router.post("/v1/checkout")
async def checkout(body: CheckoutIn, user=Depends(current_user),
                   idem: str = Header(alias="Idempotency-Key"), db=Depends(get_db)):
    total = await price_cart(db, body.cart_id, user.id)        # server-side prices only
    order = await db.fetchrow(
        """INSERT INTO orders (id, customer_id, amount_minor, currency, status, idempotency_key)
           VALUES ($1,$2,$3,'EUR','pending_payment',$4)
           ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
           RETURNING *""", new_id("ord"), user.id, total, idem)
    if order["payment_intent_id"]:
        pi = stripe.PaymentIntent.retrieve(order["payment_intent_id"])
    else:
        pi = stripe.PaymentIntent.create(                       # no DB transaction held open here
            amount=order["amount_minor"], currency="eur",
            automatic_payment_methods={"enabled": True},
            metadata={"order_id": order["id"]},
            idempotency_key=f"pi-create-{order['id']}")
        await db.execute("UPDATE orders SET payment_intent_id=$2 WHERE id=$1", order["id"], pi.id)
    return {"order_id": order["id"], "client_secret": pi.client_secret}` }],
      failure: ['**Stripe times out:** retry with the same idempotency key. Either Stripe never got it (a new PaymentIntent is created) or it did (the same one is returned). Never retry with a new key.']
    },
    {
      from: 'browser', to: 'psp', label: 'confirmPayment (card in iframe)',
      title: 'The card goes straight from the browser to Stripe',
      caption: 'Leo types his card into Stripe\'s iframe. stripe.confirmPayment() sends it to Stripe with the client_secret. Our servers never see the card number.',
      text: ['This is {{tokenization}}: Stripe holds the card and gives us only references (`pm_…`, `pi_…`). Using hosted fields keeps us in the simplest {{pci dss}} self-assessment instead of a full audit.'],
      payloadKind: 'Browser code',
      payloadLang: 'ts',
      payload: String.raw`
// The card fields are an iframe from js.stripe.com; this page cannot read them.
const { error } = await stripe.confirmPayment({
  elements,
  confirmParams: { return_url: 'https://tickets.example.com/orders/ord_01JDQ9/done' },
});
// If 3DS is needed, Stripe opens the bank challenge (modal or redirect) first.
if (error) showError(error.message);  // e.g. "Your card was declined."`,
      code: [{ lang: 'ts', title: 'Checkout form (Next.js client component)', src: String.raw`
'use client';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_KEY!);

function PayForm({ orderId }: { orderId: string }) {
  const stripe = useStripe(); const elements = useElements();
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault(); if (!stripe || !elements || busy) return;
    setBusy(true);                                             // blocks the double click
    const { error } = await stripe.confirmPayment({ elements,
      confirmParams: { return_url: location.origin + '/orders/' + orderId + '/done' } });
    if (error) { setBusy(false); setMessage(error.message ?? 'Payment failed'); }
  }
  return <form onSubmit={onSubmit}><PaymentElement /><button disabled={busy}>Pay €59.90</button></form>;
}

export function Checkout({ clientSecret, orderId }: Props) {
  return <Elements stripe={stripePromise} options={{ clientSecret }}><PayForm orderId={orderId} /></Elements>;
}` }]
    },
    {
      from: 'psp', to: 'bank', label: 'authorise + 3DS',
      title: 'Leo\'s bank asks him to confirm',
      caption: 'Stripe sends the authorisation through the card network. The bank requires Strong Customer Authentication, so Leo approves the payment in his banking app (3-D Secure 2).',
      text: ['{{3-d secure}} moves fraud liability for that payment from the merchant to the bank. The browser shows the challenge; when Leo approves, the authorisation completes and the PaymentIntent becomes `succeeded` (with automatic capture).', 'Declines come back as codes such as `insufficient_funds` or `do_not_honor`. Show a generic message for fraud-related ones: precise reasons help card testers.'],
      payloadKind: 'PaymentIntent status changes',
      payload: [{ status: 'requires_payment_method' }, { status: 'requires_action', next_action: { type: 'use_stripe_sdk', 'three_d_secure_2': 'challenge' } }, { status: 'processing' }, { status: 'succeeded', latest_charge: 'ch_3QJ8sQ2eZvKYlo2C1xyz', amount_received: 5990 }],
      failure: ['**Leo closes the tab during 3DS:** the PaymentIntent stays `requires_action` and the order stays pending. A job cancels unpaid orders after 30 minutes and releases the reserved ticket.']
    },
    {
      from: 'psp', to: 'browser', label: 'redirect to return_url', reply: true,
      title: 'The browser lands on the "done" page',
      caption: 'The page shows "Payment received, confirming your order…". It does not mark the order paid: the browser can lie or close. The webhook is the source of truth.',
      text: ['The done page polls `GET /v1/orders/ord_01JDQ9` (or listens on a WebSocket) until status becomes `paid`, usually within a second or two.'],
      payloadKind: 'Return URL',
      payloadLang: 'http',
      payload: String.raw`
GET /orders/ord_01JDQ9/done?payment_intent=pi_3QJ8sQ2eZvKYlo2C1abc&payment_intent_client_secret=pi_…_secret_Xy…&redirect_status=succeeded`
    },
    {
      from: 'psp', to: 'hook', label: 'payment_intent.succeeded', async: true,
      title: 'Stripe sends a signed webhook',
      caption: 'Stripe POSTs the event with a Stripe-Signature header. The receiver verifies the HMAC over the raw body and the timestamp before trusting anything.',
      text: ['Signature verification needs the **raw** request bytes: parsing the JSON and re-serialising it changes the bytes and breaks the {{hmac}}. The timestamp check (tolerance 5 minutes) stops replay of an old captured event.', 'Webhooks are {{at-least-once}} and can arrive out of order (a `charge.updated` before `payment_intent.succeeded`). Handlers look at the current state, not the order of arrival.'],
      payloadKind: 'Webhook request',
      payload: { headers: { 'Stripe-Signature': 't=1764068130,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd' }, body: { id: 'evt_1QJ8t02eZvKYlo2C9pqr', type: 'payment_intent.succeeded', created: 1764068130, data: { object: { id: 'pi_3QJ8sQ2eZvKYlo2C1abc', amount_received: 5990, currency: 'eur', status: 'succeeded', latest_charge: 'ch_3QJ8sQ2eZvKYlo2C1xyz', metadata: { order_id: 'ord_01JDQ9' } } } } },
      fields: { 'Stripe-Signature.t': 'Unix time Stripe signed it. Reject if more than 5 minutes off.', 'Stripe-Signature.v1': 'HMAC-SHA256 of "t.raw_body" with your endpoint secret (whsec_…).', 'body.id': 'Event id: the dedupe key.' },
      code: [{ lang: 'python', title: 'Webhook receiver', src: String.raw`
@app.post("/webhooks/stripe")
async def stripe_webhook(request: Request, db=Depends(get_db)):
    raw = await request.body()                                     # raw bytes, not parsed JSON
    try:
        event = stripe.Webhook.construct_event(raw, request.headers["Stripe-Signature"],
                                               WHSEC, tolerance=300)
    except (ValueError, stripe.error.SignatureVerificationError):
        raise HTTPException(400)
    inserted = await db.fetchval(
        "INSERT INTO webhook_events (id, type, payload) VALUES ($1,$2,$3) "
        "ON CONFLICT (id) DO NOTHING RETURNING id", event.id, event.type, raw.decode())
    if inserted:                                                   # first time we see it
        await queue.send({"event_id": event.id})
    return {"received": True}                                      # fast 200, always` }]
    },
    {
      from: 'hook', to: 'q', label: 'enqueue event_id',
      title: 'Record, enqueue, answer 200 fast',
      caption: 'The event id is stored (the primary key deduplicates) and queued. Stripe gets its 200 within milliseconds.',
      text: ['If the receiver did the fulfilment inline and it took 20 seconds, Stripe would time out and retry, causing exactly the duplicates you are trying to avoid. Stripe retries failed deliveries with backoff for up to three days in live mode.'],
      payloadKind: 'Queue message',
      payload: { event_id: 'evt_1QJ8t02eZvKYlo2C9pqr', type: 'payment_intent.succeeded', enqueued_at: '2026-11-25T11:15:30.208Z' }
    },
    {
      from: 'q', to: 'ful', label: 'process event',
      title: 'Fulfil the order exactly once',
      caption: 'The worker re-reads the PaymentIntent from Stripe, checks the amount and currency against the order, and moves the order from pending_payment to paid with a guarded UPDATE.',
      text: ['The guard `WHERE status = \'pending_payment\'` is what makes fulfilment idempotent: a duplicate event updates zero rows and stops. Checking the amount catches an order whose cart changed after the PaymentIntent was made.'],
      payloadKind: 'Transaction',
      payloadLang: 'sql',
      payload: String.raw`
BEGIN;
UPDATE orders SET status = 'paid', paid_at = now(), charge_id = 'ch_3QJ8sQ2eZvKYlo2C1xyz'
WHERE id = 'ord_01JDQ9' AND status = 'pending_payment' AND amount_minor = 5990;
-- 1 row ⇒ continue; 0 rows ⇒ already done (or mismatch: alert)
INSERT INTO tickets (id, order_id, event_id, seat) VALUES ('tkt_9A1', 'ord_01JDQ9', 'evt_concert_1206', 'GA');
INSERT INTO outbox (topic, payload) VALUES ('order.paid', '{"order_id":"ord_01JDQ9"}');
COMMIT;`,
      code: [{ lang: 'python', title: 'Fulfilment worker', src: String.raw`
async def on_payment_succeeded(event_id: str):
    ev = await db.fetchrow("SELECT payload FROM webhook_events WHERE id=$1", event_id)
    pi_id = json.loads(ev["payload"])["data"]["object"]["id"]
    pi = stripe.PaymentIntent.retrieve(pi_id)                  # trust Stripe's current state
    if pi.status != "succeeded":
        return
    order_id = pi.metadata["order_id"]
    async with db.transaction():
        n = await db.execute(
            "UPDATE orders SET status='paid', paid_at=now(), charge_id=$3 "
            "WHERE id=$1 AND status='pending_payment' AND amount_minor=$2",
            order_id, pi.amount_received, pi.latest_charge)
        if n == "UPDATE 0":
            return await check_already_paid_or_alert(order_id, pi)
        await issue_ticket(order_id)
        await post_ledger(order_id, pi)                        # next step, same transaction
        await outbox("order.paid", {"order_id": order_id})       # receipt email etc.` }],
      failure: ['**Paid but the seat was released (payment came after the 30-minute timeout):** the order is in `cancelled`; the worker refunds automatically and emails Leo. Rare, but it must be handled, not ignored.']
    },
    {
      from: 'ful', to: 'ledger', label: 'journal entries',
      title: 'Write the money movement to the ledger',
      caption: 'One journal transaction with entries that sum to zero: Stripe owes us €59.90 minus fees; fees are an expense; revenue is recognised.',
      text: ['A {{double-entry ledger}} never updates a balance in place. Balances are sums of immutable entries, so every euro has a history and errors are fixed with new correcting entries, not edits.', 'Stripe\'s fee (here 1.5% + €0.25 = €1.15, an example rate) is known from the balance transaction; until then it can be booked when the payout report arrives.'],
      payloadKind: 'Ledger entries (minor units)',
      payload: { journal_id: 'jr_7731', ref: 'ord_01JDQ9', entries: [{ account: 'assets:stripe_balance', amount: 5875 }, { account: 'expenses:payment_fees', amount: 115 }, { account: 'revenue:tickets', amount: -4950 }, { account: 'liabilities:vat_payable', amount: -1040 }], sum: 0 },
      fields: { sum: 'Must be 0. A database CHECK via a deferred constraint or the writing code enforces it.', 'entries[3]': 'VAT included in the price: 59.90 = 49.50 net + 10.40 VAT (21%, Belgian standard rate), rounded to the cent.' }
    },
    {
      from: 'recon', to: 'psp', label: 'nightly reconciliation',
      title: 'Reconcile with Stripe every night',
      caption: 'A job downloads Stripe\'s balance transactions for the day and matches each to a ledger journal by charge id. Anything unmatched or with a different amount becomes an alert.',
      text: ['{{reconciliation}} catches what webhooks miss: an event that was never processed, a refund made in the Stripe dashboard by support, a dispute, or a bug that booked the wrong fee.'],
      payloadKind: 'Reconciliation report',
      payload: { date: '2026-11-25', stripe_transactions: 912455, ledger_journals: 912453, matched: 912451, mismatched_amount: [{ charge: 'ch_3QJ7…', stripe: 2990, ledger: 2900 }], missing_in_ledger: ['ch_3QJ9…(refund via dashboard)', 'ch_3QJA…'], action: 'tickets opened for finance + replay of 2 missed events' }
    }
  ],
  api: [
    { verb: 'POST', path: '/v1/checkout', desc: 'Create the order and PaymentIntent; returns client_secret. Requires Idempotency-Key.' },
    { verb: 'GET', path: '/v1/orders/{id}', desc: 'Order status for the confirmation page.' },
    { verb: 'POST', path: '/webhooks/stripe', desc: 'Signed Stripe events.' },
    { verb: 'POST', path: '/v1/orders/{id}/refund', desc: 'Partial or full refund; writes reversing ledger entries when refund.succeeded arrives.' }
  ],
  schema: String.raw`
CREATE TABLE orders (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0), currency CHAR(3) NOT NULL,
  status TEXT NOT NULL,             -- pending_payment | paid | cancelled | refunded
  idempotency_key TEXT UNIQUE NOT NULL,
  payment_intent_id TEXT UNIQUE, charge_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(), paid_at TIMESTAMPTZ
);
CREATE TABLE webhook_events (id TEXT PRIMARY KEY, type TEXT, payload JSONB, received_at TIMESTAMPTZ DEFAULT now());

CREATE TABLE journal (id TEXT PRIMARY KEY, ref TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE entries (
  journal_id TEXT REFERENCES journal, account TEXT NOT NULL,
  amount_minor BIGINT NOT NULL      -- positive = debit, negative = credit
);
-- invariant: SELECT journal_id FROM entries GROUP BY 1 HAVING sum(amount_minor) <> 0  → no rows`,
  decisions: [
    { q: 'When is the order marked paid?', options: [
      { verdict: 'bad', name: 'When the browser returns from Stripe', why: 'The browser can close, lose connection, or be forged.' },
      { verdict: 'great', name: 'When a verified webhook (re-checked against the API) says succeeded', why: 'Server-to-server, signed, retried until acknowledged.' }
    ] },
    { q: 'How do you avoid double charges?', options: [
      { verdict: 'bad', name: 'Disable the button', why: 'Helps, but does nothing for network retries or two tabs.' },
      { verdict: 'great', name: 'Idempotency keys end to end + one PaymentIntent per order + guarded state transitions', why: 'Each layer turns retries into no-ops.' }
    ] },
    { q: 'How do you store money?', options: [
      { verdict: 'bad', name: 'FLOAT columns and a balance updated in place', why: 'Rounding errors and no history.' },
      { verdict: 'great', name: 'Integer minor units in an append-only double-entry ledger', why: 'Exact, auditable, reconcilable.' }
    ] }
  ],
  refs: [
    { label: 'Stripe: Idempotent requests', url: 'https://docs.stripe.com/api/idempotent_requests' },
    { label: 'Stripe: Receive events in your webhook endpoint', url: 'https://docs.stripe.com/webhooks' },
    { label: 'Stripe: Accept a payment (Payment Element)', url: 'https://docs.stripe.com/payments/accept-a-payment' },
    { label: 'Stripe: 3D Secure authentication', url: 'https://docs.stripe.com/payments/3d-secure' },
    { label: 'Square: Books, an immutable double-entry accounting database', url: 'https://developer.squareup.com/blog/books-an-immutable-double-entry-accounting-database-service/' }
  ]
});
