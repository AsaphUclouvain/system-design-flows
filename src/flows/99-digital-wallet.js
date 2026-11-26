flow({
  id: 'digital-wallet',
  title: 'Digital wallet: transfers across shards',
  category: 'Commerce & money',
  tags: ['Accounts sharded by id', 'Two-phase transfer (reserve / post)', 'Pending → posted / voided', 'Event sourcing', 'Idempotent commands', 'Replay to rebuild state'],
  summary: 'Alice sends Bob €20 in an app. Their balances live on different database shards, so one local transaction cannot cover both. The wallet reserves the money on Alice\'s shard, credits Bob\'s, then finalises, and every step is an event in an append-only log that can rebuild any balance. Follow a transfer, a failure that voids the reservation, and a replay.',
  requirements: {
    functional: ['Transfer money between any two accounts.', 'Show balance and history.', 'Audit: explain any balance at any point in time.'],
    nonFunctional: ['Money is never created or lost, even if a service crashes mid-transfer.', 'A retried transfer request happens once.', 'Thousands of transfers per second.']
  },
  grid: { cols: 5, rows: 3 },
  nodes: [
    { id: 'app', label: 'Alice\'s app', sub: 'send €20', kind: 'client', icon: 'phone', x: 0, y: 1, desc: 'Sends a transfer command with a client-generated id.' },
    { id: 'coord', label: 'Transfer coordinator', sub: 'state machine', kind: 'service', icon: 'split', x: 1, y: 1, desc: 'Drives the transfer through RESERVED → CREDITED → POSTED (or VOIDED) and persists each state.' },
    { id: 'shA', label: 'Shard A', sub: 'Alice\'s account', kind: 'db', icon: 'wallet', x: 2, y: 0, desc: 'Holds Alice\'s balance and pending amounts.' },
    { id: 'shB', label: 'Shard B', sub: 'Bob\'s account', kind: 'db', icon: 'wallet', x: 2, y: 2, desc: 'Holds Bob\'s balance.' },
    { id: 'log', label: 'Event log', sub: 'append-only', kind: 'queue', icon: 'log', x: 3, y: 1, desc: 'Every command result as an event: TransferReserved, Credited, Posted, Voided. The source of truth.' },
    { id: 'view', label: 'Balance views', sub: 'projections', kind: 'cache', icon: 'chart', x: 4, y: 1, desc: 'Read models built by replaying events: balances, history, statements.' }
  ],
  pseudo: `
cmd = Transfer(id=t_301, from=alice, to=bob, amount=2000)
if log.has(t_301): return log.state(t_301)          # idempotent
shardA: if available(alice) >= 2000: pending(alice) += 2000 -> TransferReserved
shardB: balance(bob) += 2000 -> Credited
shardA: pending(alice) -= 2000; balance(alice) -= 2000 -> Posted
if credit fails: shardA: pending(alice) -= 2000 -> Voided
views: balance(acct) = fold(events for acct)
rebuild: replay(log from 0) -> same balances`,
  steps: [
    {
      from: 'app', to: 'coord', label: 'Transfer t_301: alice → bob €20', pc: ['cmd = Transfer', 'if log.has(t_301)'],
      title: 'A transfer command arrives',
      caption: 'The app generates t_301 before sending. If the network drops and the app retries, the coordinator sees t_301 already exists and returns its current state.',
      text: [],
      payloadKind: 'Command',
      payload: { id: 't_301', from: 'acct_alice', to: 'acct_bob', amount_cents: 2000, currency: 'EUR' }
    },
    {
      from: 'coord', to: 'shA', label: 'reserve €20 on Alice (pending)', pc: ['shardA: if available'],
      title: 'Phase 1: reserve on Alice\'s shard',
      caption: 'A local transaction on shard A checks Alice can afford it and moves €20 to "pending". She cannot spend it twice, but it has not left yet.',
      text: ['TigerBeetle, a financial database, has this exact primitive: a pending transfer that is later posted or voided.'],
      payloadKind: 'Shard A',
      payload: { account: 'acct_alice', balance: 15000, pending: '0 → 2000', available: '15000 → 13000' }
    },
    {
      from: 'shA', to: 'log', label: 'TransferReserved t_301', pc: ['-> TransferReserved'],
      title: 'Record the event',
      caption: 'The state change is appended to the log. If the coordinator crashes now, a new one reads the log and continues from RESERVED.',
      text: [],
      payloadKind: 'Event',
      payload: { seq: 88120, type: 'TransferReserved', transfer: 't_301', account: 'acct_alice', amount: 2000 }
    },
    {
      from: 'coord', to: 'shB', label: 'credit Bob €20', pc: ['shardB: balance(bob)'],
      title: 'Phase 2: credit Bob\'s shard',
      caption: 'A local transaction on shard B adds €20 to Bob, keyed by t_301 so a retry does not credit twice.',
      text: [],
      payloadKind: 'Shard B',
      payload: { account: 'acct_bob', balance: '4200 → 6200', applied_transfer: 't_301' },
      branch: { q: 'Did the credit succeed?', options: [ { label: 'yes: post', goto: 'post' }, { label: 'no: void the reservation', goto: 'void' } ] }
    },
    {
      id: 'void', path: 'void', from: 'coord', to: 'shA', label: 'acct_bob frozen → void, release €20', pc: ['if credit fails'],
      title: 'Other outcome: void',
      caption: 'Bob\'s account is frozen by compliance, so the credit is rejected. The coordinator voids the reservation: Alice\'s pending €20 becomes available again. No money moved.',
      text: [],
      payloadKind: 'Void',
      payload: { transfer: 't_301', event: 'TransferVoided', reason: 'destination_frozen', alice_available: '13000 → 15000' },
      next: 'proj'
    },
    {
      id: 'post', from: 'coord', to: 'shA', label: 'post: pending −€20, balance −€20', pc: ['shardA: pending(alice) -= 2000; balance'],
      title: 'Phase 3: post on Alice\'s shard',
      caption: 'The pending amount becomes a real debit. The transfer is complete, and the total across both shards is unchanged.',
      text: [],
      payloadKind: 'Shard A',
      payload: { account: 'acct_alice', balance: '15000 → 13000', pending: '2000 → 0', event: 'TransferPosted' }
    },
    {
      id: 'proj', from: 'log', to: 'view', label: 'fold events → balances + history', pc: ['views: balance(acct) = fold'],
      title: 'Views are built from events',
      caption: 'The app\'s history screen and balances are projections of the log. Adding a new view (monthly statement) means replaying old events into it.',
      text: ['This is event sourcing: state is derived from an append-only sequence of events rather than stored as the only copy.'],
      payloadKind: 'Projection',
      payload: { acct_alice: { balance: 13000, last_event: 88122 }, acct_bob: { balance: 6200, last_event: 88121 } }
    },
    {
      from: 'view', to: 'log', label: 'replay from seq 0 → same balances', pc: ['rebuild: replay'],
      title: 'Audit or recover by replaying',
      caption: 'Lose a view, or need "Alice\'s balance on 1 Nov"? Replay events up to that point. Same events in the same order always give the same result.',
      text: [],
      payloadKind: 'Replay',
      payload: { from_seq: 0, to_seq: 88122, accounts: 1200000, matches_live: true }
    }
  ],
  decisions: [
    { q: 'Cross-shard transfer method?', options: [
      { name: 'Reserve / post (TC/C style) with a persisted state machine', verdict: 'good', why: 'Each step is a local transaction; crashes resume from the log.' },
      { name: '2PC across shards', verdict: 'ok', why: 'Atomic, but holds locks during the protocol and blocks if the coordinator dies.' },
      { name: 'Two independent updates', verdict: 'bad', why: 'A crash between them creates or destroys money.' } ] }
  ],
  refs: [
    { label: 'TigerBeetle docs: Two-phase transfers (pending, post, void)', url: 'https://docs.tigerbeetle.com/coding/two-phase-transfers/' },
    { label: 'Martin Fowler: Event Sourcing', url: 'https://martinfowler.com/eaaDev/EventSourcing.html' },
    { label: 'microservices.io: Saga pattern', url: 'https://microservices.io/patterns/data/saga.html' },
    { label: 'ByteByteGo: System Design Interview Vol. 2, chapter "Digital Wallet" (book)', url: 'https://bytebytego.com/courses/system-design-interview/digital-wallet' }
  ],
  verify: {
    checked: ['Pending transfers that are later posted or voided: TigerBeetle docs.', 'State rebuilt by replaying events: Fowler, Event Sourcing.'],
    uncertain: ['Balances, sequence numbers and account counts are illustrative. Real wallets also need fraud checks and limits not shown.']
  }
});
