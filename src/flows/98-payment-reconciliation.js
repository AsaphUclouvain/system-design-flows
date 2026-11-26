flow({
  id: 'payment-reconciliation',
  title: 'Payment system: PSP webhooks, ledger and reconciliation',
  category: 'Commerce & money',
  tags: ['Idempotency keys', 'PSP webhook', 'Double-entry ledger', 'Settlement file', 'Nightly reconciliation', 'Payouts to sellers', 'Mismatch queue'],
  summary: 'Taking a payment is only half of a payment system. The money has to be recorded in a ledger, matched against what the payment provider actually settled to your bank, and paid out to sellers. This flow follows a charge confirmed by webhook, the nightly reconciliation that compares three sources, a mismatch that goes to a human, and the seller payout.',
  requirements: {
    functional: ['Record every money movement in a double-entry ledger.', 'Match internal records with the PSP\'s settlement report every day.', 'Pay sellers their balance minus fees on a schedule.'],
    nonFunctional: ['Never charge or pay twice.', 'Every cent explainable: an audit can trace any balance to entries.', 'Mismatches are found within a day, not at the end of the quarter.']
  },
  grid: { cols: 5, rows: 3 },
  nodes: [
    { id: 'pay', label: 'Payment service', sub: 'payment orders', kind: 'service', icon: 'card', x: 1, y: 1, desc: 'Tracks each payment order: CREATED → PENDING → SUCCEEDED / FAILED. Calls the PSP with an idempotency key.' },
    { id: 'psp', label: 'PSP', sub: 'Stripe / Adyen', kind: 'external', icon: 'external', x: 0, y: 0, desc: 'Charges the card and later settles the money (minus fees) to the platform\'s bank account.' },
    { id: 'ledger', label: 'Ledger', sub: 'double-entry, append-only', kind: 'db', icon: 'doc', x: 2, y: 1, desc: 'Every movement is two entries that sum to zero. Balances are sums of entries.' },
    { id: 'recon', label: 'Reconciliation job', sub: 'nightly', kind: 'worker', icon: 'check', x: 2, y: 0, desc: 'Loads the PSP settlement report and compares it line by line with payment orders and ledger entries.' },
    { id: 'ops', label: 'Finance ops', sub: 'mismatch queue', kind: 'client', icon: 'user', x: 4, y: 0, desc: 'Investigates lines that do not match and fixes them with adjusting entries, never by editing history.' },
    { id: 'payout', label: 'Payout service', sub: 'weekly', kind: 'worker', icon: 'wallet', x: 3, y: 1, desc: 'Pays each seller\'s available balance to their bank account.' },
    { id: 'bank', label: 'Seller\'s bank', sub: 'SEPA transfer', kind: 'external', icon: 'building', x: 4, y: 1, desc: 'Receives the payout.' },
    { id: 'shop', label: 'Checkout', sub: 'buyer', kind: 'client', icon: 'cart', x: 0, y: 2, desc: 'Where the payment order started.' }
  ],
  pseudo: `
order = create_payment_order(id=po_551, amount=4990, idempotency_key=po_551)
psp.charge(order)  ->  webhook payment_intent.succeeded (may arrive twice)
on_webhook(evt): if processed(evt.id): return 200
    order.status = SUCCEEDED
    ledger.post([(buyer_clearing, -4990), (seller_balance, +4490), (platform_fees, +500)])
nightly: report = psp.settlement_report(date)
for line in report: match(line, orders[line.ref], ledger[line.ref])
    if mismatch: open_case(line)
weekly: for seller: amount = available_balance(seller); bank.transfer(seller, amount, key=payout_id)
    ledger.post([(seller_balance, -amount), (bank_out, +amount)])`,
  steps: [
    {
      from: 'shop', to: 'pay', label: 'create payment order po_551 €49.90', pc: ['order = create_payment_order'],
      title: 'A payment order is created',
      caption: 'The buyer pays €49.90 to a seller on the marketplace. The order id doubles as the idempotency key for every call to the PSP.',
      text: [],
      payloadKind: 'Payment order',
      payload: { id: 'po_551', amount_cents: 4990, currency: 'EUR', buyer: 'u_88', seller: 's_12', status: 'CREATED' }
    },
    {
      from: 'pay', to: 'psp', label: 'charge (Idempotency-Key: po_551)', pc: ['psp.charge(order)'],
      title: 'Charge through the PSP',
      caption: 'If the call times out, the service retries with the same key and the PSP returns the first result instead of charging again.',
      text: ['Airbnb\'s engineering team described building an idempotency library for exactly this reason: retries in a distributed payment flow must never double-charge.'],
      payloadKind: 'Charge request',
      payload: { amount: 4990, currency: 'eur', idempotency_key: 'po_551', metadata: { payment_order: 'po_551' } }
    },
    {
      from: 'psp', to: 'pay', label: 'webhook payment_intent.succeeded (evt_9a)', pc: ['on_webhook(evt)', 'order.status = SUCCEEDED'],
      title: 'The PSP confirms by webhook',
      caption: 'Webhooks are at-least-once: the same event can arrive twice. The handler stores processed event ids and ignores repeats.',
      text: [],
      payloadKind: 'Webhook',
      payload: { id: 'evt_9a', type: 'payment_intent.succeeded', data: { id: 'pi_3Q…', amount: 4990, metadata: { payment_order: 'po_551' } } }
    },
    {
      from: 'pay', to: 'ledger', label: 'post 3 entries, sum = 0', pc: ['ledger.post([(buyer_clearing'],
      title: 'Record it in the double-entry ledger',
      caption: 'Money is never created or lost: −€49.90 from clearing, +€44.90 to the seller\'s balance, +€5.00 platform fee. The entries sum to zero.',
      text: [],
      payloadKind: 'Ledger entries',
      payload: { tx: 'tx_551', entries: [{ account: 'buyer_clearing', cents: -4990 }, { account: 'seller:s_12', cents: 4490 }, { account: 'platform_fees', cents: 500 }], sum: 0 }
    },
    {
      from: 'recon', to: 'psp', label: 'download settlement report 2026-11-26', pc: ['nightly: report = psp.settlement_report'],
      title: 'Nightly: get what the PSP really settled',
      caption: 'The PSP\'s report lists every charge, refund and fee that made up the money transferred to the platform\'s bank, each with its reference.',
      text: [],
      payloadKind: 'Settlement line',
      payload: { ref: 'po_551', gross: 4990, psp_fee: 87, net: 4903, payout_id: 'po_psp_771', type: 'charge' }
    },
    {
      from: 'recon', to: 'ledger', label: 'match 18 204 lines vs orders + ledger', pc: ['for line in report: match'],
      title: 'Match three sources line by line',
      caption: 'For each settlement line: is there a SUCCEEDED payment order with this reference and amount, and ledger entries for it? 18 203 match.',
      text: [],
      payloadKind: 'Recon summary',
      payload: { date: '2026-11-26', lines: 18204, matched: 18203, mismatched: 1 },
      branch: { q: 'Any mismatch?', options: [ { label: 'yes: open a case', goto: 'case' }, { label: 'no: close the day', goto: 'payout1' } ] }
    },
    {
      id: 'case', path: 'case', from: 'recon', to: 'ops', label: 'po_602: PSP settled, our order says FAILED', pc: ['if mismatch: open_case'],
      title: 'Other outcome: a mismatch',
      caption: 'The PSP settled €12.00 for po_602, but our order is FAILED: the success webhook was lost during an outage. Finance ops confirms it and posts an adjusting entry; history is never edited.',
      text: [],
      payloadKind: 'Case',
      payload: { ref: 'po_602', psp: 'succeeded 1200', internal: 'FAILED', fix: 'mark SUCCEEDED + adjusting ledger entry adj_77', resolved_by: 'finance-ops' }
    },
    {
      id: 'payout1', from: 'payout', to: 'ledger', label: 'seller s_12 available: €1 284.10', pc: ['weekly: for seller', 'available_balance'],
      title: 'Weekly payout: compute available balances',
      caption: 'The available balance is the sum of the seller\'s ledger entries, minus funds still in a refund-hold window.',
      text: [],
      payloadKind: 'Balance',
      payload: { seller: 's_12', balance_cents: 141210, on_hold_cents: 12800, available_cents: 128410 }
    },
    {
      from: 'payout', to: 'bank', label: 'SEPA €1 284.10 (key payout_2026w48_s12)', pc: ['bank.transfer', '(seller_balance, -amount)'],
      title: 'Pay the seller, idempotently',
      caption: 'The transfer uses a key per seller per week so a retry cannot pay twice, and the payout is posted to the ledger like every other movement.',
      text: [],
      payloadKind: 'Payout',
      payload: { seller: 's_12', iban: 'BE71 0961 2345 6769', amount_cents: 128410, key: 'payout_2026w48_s12', ledger: [{ account: 'seller:s_12', cents: -128410 }, { account: 'bank_out', cents: 128410 }] }
    }
  ],
  decisions: [
    { q: 'Trust webhooks alone?', options: [
      { name: 'Webhooks + nightly reconciliation', verdict: 'good', why: 'Webhooks are fast; reconciliation catches the ones that were lost or mis-processed.' },
      { name: 'Webhooks only', verdict: 'bad', why: 'A lost webhook becomes a silent money discrepancy.' } ] },
    { q: 'Fix errors how?', options: [
      { name: 'Adjusting entries', verdict: 'good', why: 'Append-only history stays auditable.' },
      { name: 'UPDATE the wrong row', verdict: 'bad', why: 'Destroys the audit trail.' } ] }
  ],
  refs: [
    { label: 'Stripe docs: Payout reconciliation report', url: 'https://docs.stripe.com/reports/payout-reconciliation' },
    { label: 'Stripe docs: Idempotent requests', url: 'https://docs.stripe.com/api/idempotent_requests' },
    { label: 'Stripe docs: Webhooks (duplicate events)', url: 'https://docs.stripe.com/webhooks' },
    { label: 'Airbnb Engineering: Avoiding double payments in a distributed payments system', url: 'https://medium.com/airbnb-engineering/avoiding-double-payments-in-a-distributed-payments-system-2981f6b070bb' },
    { label: 'ByteByteGo: System Design Interview Vol. 2, chapter "Payment System" (book)', url: 'https://bytebytego.com/courses/system-design-interview/payment-system' }
  ],
  verify: {
    checked: ['Settlement report that matches payouts to the underlying transactions: Stripe payout reconciliation docs.', 'Idempotency keys and duplicate webhook events: Stripe docs.', 'Idempotency to avoid double payments: Airbnb engineering post.'],
    uncertain: ['Amounts, fees, line counts and the IBAN (a published example format) are illustrative.']
  }
});
