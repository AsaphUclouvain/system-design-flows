flow({
  id: 'stock-exchange',
  title: 'Stock exchange: order matching',
  category: 'Commerce & money',
  tags: ['Order gateway', 'Pre-trade risk checks', 'Sequencer', 'Single-threaded matching engine', 'Order book price-time priority', 'Market data feed', 'Replay for recovery'],
  summary: 'A broker sends "buy 100 ACME at €52.10". The exchange checks risk, stamps the order with a sequence number, and a single-threaded in-memory matching engine pairs it with sell orders by price, then time. Fills go back to both brokers and the change is broadcast to everyone as market data. Follow a match, a rejected order, and recovery after a crash.',
  requirements: {
    functional: ['Accept limit orders and cancels.', 'Match by price-time priority.', 'Publish trades and order-book changes to all participants.'],
    nonFunctional: ['Microsecond-level, predictable latency.', 'Deterministic: replaying the same input gives the same trades.', 'Fair: everyone sees the same market data at the same time.']
  },
  grid: { cols: 5, rows: 3 },
  nodes: [
    { id: 'broker', label: 'Broker', sub: 'FIX connection', kind: 'client', icon: 'laptop', x: 0, y: 1, desc: 'Sends orders on behalf of its clients over a persistent session.' },
    { id: 'gw', label: 'Order gateway', sub: 'validate', kind: 'edge', icon: 'shield', x: 1, y: 1, desc: 'Checks the message format, the session and the symbol.' },
    { id: 'risk', label: 'Risk check', sub: 'pre-trade', kind: 'service', icon: 'gauge', x: 1, y: 0, desc: 'Rejects orders over the broker\'s limits or far from the current price.' },
    { id: 'seq', label: 'Sequencer', sub: 'total order + journal', kind: 'queue', icon: 'hash', x: 2, y: 1, desc: 'Gives every input a sequence number and writes it to a journal before matching, so the run can be replayed.' },
    { id: 'me', label: 'Matching engine', sub: 'one thread, in memory', kind: 'worker', icon: 'cpu', x: 3, y: 1, desc: 'Keeps the order book in memory and processes inputs one at a time, in sequence order.' },
    { id: 'md', label: 'Market data', sub: 'multicast feed', kind: 'service', icon: 'chart', x: 3, y: 2, desc: 'Publishes every book change and trade to all subscribers.' },
    { id: 'report', label: 'Execution reports', sub: 'to both brokers', kind: 'service', icon: 'doc', x: 4, y: 1, desc: 'Sends fills to the buyer\'s and seller\'s brokers; feeds clearing.' }
  ],
  pseudo: `
msg = NewOrder(BUY, ACME, qty=100, limit=52.10, client_id=o_77)
gateway.validate(msg); if not risk.ok(msg): reject
seq = sequencer.next(); journal.append(seq, msg)
me.apply(seq, msg):
    while qty and best_ask.price <= limit:
        fill = min(qty, best_ask.qty); trade(best_ask.price, fill)
    if qty: book.bids.insert(limit, time=seq)
publish(market_data, changes); send(execution_reports)
recovery: load snapshot; replay journal from snapshot.seq`,
  steps: [
    {
      from: 'broker', to: 'gw', label: 'NewOrder BUY 100 ACME @ 52.10', pc: ['msg = NewOrder', 'gateway.validate'],
      title: 'A limit order arrives',
      caption: 'The broker\'s client wants to buy 100 shares, paying at most €52.10 each.',
      text: [],
      payloadKind: 'Order',
      payload: { type: 'NewOrder', side: 'BUY', symbol: 'ACME', qty: 100, limit: 52.1, tif: 'DAY', client_order_id: 'o_77', broker: 'BRK1' }
    },
    {
      from: 'gw', to: 'risk', label: 'notional €5 210 vs limit €2 M', pc: ['risk.ok(msg)'],
      title: 'Pre-trade risk check',
      caption: 'Is the broker within its credit limit? Is the price within a sane band of the last trade? A fat-finger order for 1 000 000 shares would stop here.',
      text: [],
      payloadKind: 'Risk result',
      payload: { notional_eur: 5210, broker_limit_eur: 2000000, price_band: '±10%', ok: true },
      branch: { q: 'Within limits?', options: [ { label: 'yes', goto: 'seq1' }, { label: 'no: reject', goto: 'rej' } ] }
    },
    {
      id: 'rej', path: 'rej', from: 'risk', to: 'broker', reply: true, label: 'Reject: price 5.21 outside band', pc: ['reject'],
      title: 'Other outcome: rejected',
      caption: 'Another order typed 5.21 instead of 52.10. It is 90% below the market, outside the band, and rejected before it ever reaches the book.',
      text: [],
      payloadKind: 'Reject',
      payload: { client_order_id: 'o_78', reason: 'PRICE_OUT_OF_BAND', limit: 5.21, reference: 52.08 },
      next: 'seq1'
    },
    {
      id: 'seq1', from: 'gw', to: 'seq', label: 'seq 10 448 213 → journal', pc: ['seq = sequencer.next()'],
      title: 'Sequence and journal it',
      caption: 'Every order and cancel, from every gateway, gets one global sequence number and is written to a journal before matching. The order of the journal is the order of the market.',
      text: [],
      payloadKind: 'Journal entry',
      payload: { seq: 10448213, ts_ns: 1764171012000123456, msg: 'NewOrder BUY 100 ACME @52.10 o_77' }
    },
    {
      from: 'seq', to: 'me', label: 'apply seq 10 448 213', pc: ['me.apply', 'while qty and best_ask', 'book.bids.insert'],
      title: 'Match by price, then time',
      caption: 'The best asks are 60 @ 52.05 and 80 @ 52.10. The order takes all 60 at 52.05, then 40 of the 80 at 52.10 (the oldest order at that price goes first). Fully filled, nothing rests on the book.',
      text: ['LMAX described processing about 6 million orders per second on a single thread with everything in memory: no locks, and the input journal makes it recoverable.'],
      payloadKind: 'Order book (ACME)',
      payload: { asks_before: [{ px: 52.05, qty: 60 }, { px: 52.1, qty: 80 }, { px: 52.15, qty: 300 }], trades: [{ px: 52.05, qty: 60 }, { px: 52.1, qty: 40 }], asks_after: [{ px: 52.1, qty: 40 }, { px: 52.15, qty: 300 }] }
    },
    {
      from: 'me', to: 'report', label: 'Fill 60@52.05, Fill 40@52.10', pc: ['send(execution_reports)'],
      title: 'Execution reports to both sides',
      caption: 'The buyer\'s broker and each seller\'s broker get fills. Average price: €52.07.',
      text: [],
      payloadKind: 'Execution report',
      payload: { client_order_id: 'o_77', status: 'FILLED', fills: [{ qty: 60, px: 52.05 }, { qty: 40, px: 52.1 }], avg_px: 52.07 }
    },
    {
      from: 'me', to: 'md', label: 'trade + book update, seq 10 448 213', pc: ['publish(market_data'],
      title: 'Broadcast market data',
      caption: 'Everyone gets the same messages: two trades and the changed ask levels, numbered so receivers detect gaps.',
      text: ['Nasdaq\'s TotalView-ITCH feed is an example: messages like Add Order and Order Executed describe every change to the book.'],
      payloadKind: 'Market data',
      payload: [{ type: 'Trade', symbol: 'ACME', px: 52.05, qty: 60 }, { type: 'Trade', symbol: 'ACME', px: 52.1, qty: 40 }, { type: 'BookLevel', side: 'ASK', px: 52.1, qty: 40 }]
    },
    {
      from: 'seq', to: 'me', label: 'crash → snapshot @10.4 M + replay journal', pc: ['recovery: load snapshot'],
      title: 'Recovery: replay the journal',
      caption: 'If the engine crashes, a standby loads the last snapshot and replays the journal from there. Because matching is deterministic, it rebuilds exactly the same book and trades.',
      text: [],
      payloadKind: 'Recovery',
      payload: { snapshot_seq: 10400000, replayed: 48213, rebuilt_book_matches: true, downtime_ms: 900 }
    }
  ],
  decisions: [
    { q: 'Multi-threaded or single-threaded matching?', options: [
      { name: 'Single thread per symbol group, in memory', verdict: 'good', why: 'No locks, deterministic, very fast; shard by symbol for more throughput.' },
      { name: 'Many threads on a shared book', verdict: 'bad', why: 'Locks, non-deterministic ordering, unfair.' } ] }
  ],
  refs: [
    { label: 'Martin Fowler: The LMAX Architecture', url: 'https://martinfowler.com/articles/lmax.html' },
    { label: 'Nasdaq TotalView-ITCH 5.0 specification (PDF)', url: 'https://www.nasdaqtrader.com/content/technicalsupport/specifications/dataproducts/NQTVITCHspecification.pdf' },
    { label: 'FIX Trading Community: FIX protocol', url: 'https://www.fixtrading.org/standards/' },
    { label: 'ByteByteGo: System Design Interview Vol. 2, chapter "Stock Exchange" (book)', url: 'https://bytebytego.com/courses/system-design-interview/stock-exchange' }
  ],
  verify: {
    checked: ['Single-threaded in-memory business logic, input journal and about 6 million orders/s: Fowler, The LMAX Architecture.', 'Add Order / Order Executed messages: Nasdaq ITCH 5.0 spec.'],
    uncertain: ['Symbol, prices, limits, sequence numbers and recovery time are illustrative.']
  }
});
