flow({
  id: 'hotel-reservation',
  title: 'Hotel reservation system',
  category: 'Commerce & money',
  tags: ['Inventory per room type per night', 'Idempotent reserve', 'Optimistic locking / DB constraint', 'Overbooking %', 'Hold → pay → confirm', 'Cache for search, DB for truth'],
  summary: 'Unlike concert seats, hotel inventory is a count: "12 Deluxe rooms left on 24 Dec". A reservation decrements the count for every night of the stay in one transaction, a database constraint makes overselling impossible, and an idempotency key makes double-clicks harmless. Follow a booking, a double click, and a race for the last room.',
  requirements: {
    functional: ['Search availability for dates and room types.', 'Reserve a room type for a date range, then pay.', 'Cancel; allow a configurable overbooking percentage.'],
    nonFunctional: ['Never sell more than capacity × (1 + overbooking).', 'A retried request never creates two reservations.', 'Search can be slightly stale; booking must not.']
  },
  estimates: ['Illustrative: 5 000 hotels × 20 room types × 2 years of nights ≈ 73 M inventory rows: fits one sharded relational DB.'],
  grid: { cols: 5, rows: 3 },
  nodes: [
    { id: 'guest', label: 'Guest', sub: 'booking page', kind: 'client', icon: 'browser', x: 0, y: 1, desc: 'Picks Deluxe Double, 23–25 Dec, and presses Book.' },
    { id: 'res', label: 'Reservation service', sub: 'stateless', kind: 'service', icon: 'building', x: 2, y: 1, desc: 'Validates, reserves inventory and creates the reservation in one transaction.' },
    { id: 'cache', label: 'Availability cache', sub: 'Redis, for search', kind: 'cache', icon: 'cache', x: 1, y: 0, desc: 'Fast, slightly stale counts for search results. Never used to decide a booking.' },
    { id: 'db', label: 'Inventory DB', sub: 'room_type_inventory', kind: 'db', icon: 'db', x: 3, y: 1, desc: 'One row per (hotel, room type, date) with total and reserved. A CHECK constraint stops overselling.' },
    { id: 'pay', label: 'Payment service', sub: 'PSP', kind: 'external', icon: 'card', x: 3, y: 2, desc: 'Charges the card for the reservation id.' },
    { id: 'timer', label: 'Expiry job', sub: 'unpaid holds', kind: 'worker', icon: 'clock', x: 2, y: 2, desc: 'Releases inventory for reservations still PENDING after 15 minutes.' },
    { id: 'mail', label: 'Confirmation', sub: 'email', kind: 'service', icon: 'mail', x: 4, y: 0, desc: 'Sends the booking confirmation once payment succeeds.' }
  ],
  pseudo: `
POST /reservations  Idempotency-Key: r_7f3c
if reservations.exists(key): return existing   # double click
BEGIN
  UPDATE room_type_inventory SET reserved = reserved + 1
   WHERE hotel=211 AND type='deluxe' AND date IN ('12-23','12-24')
  -- CHECK (reserved <= total * 1.10) fails if no room left
  INSERT reservations(id=key, status='PENDING', expires=now()+15min)
COMMIT
pay(key) -> on success status='CONFIRMED'; email
expiry job: PENDING and expired -> release inventory`,
  steps: [
    {
      from: 'guest', to: 'cache', label: 'search 23–25 Dec → Deluxe: 3 left', pc: ['POST /reservations'],
      title: 'Search reads the cache',
      caption: 'Search results come from a cache that may be a few seconds old. That is fine for browsing, and it keeps millions of searches off the database.',
      text: [],
      payloadKind: 'Search result',
      payload: { hotel_id: 211, check_in: '2026-12-23', check_out: '2026-12-25', room_types: [{ type: 'deluxe', left: 3, price_eur: 189 }] }
    },
    {
      from: 'guest', to: 'res', label: 'POST /reservations (Idempotency-Key r_7f3c)', pc: ['POST /reservations', 'if reservations.exists(key)'],
      title: 'Book with an idempotency key',
      caption: 'The page generated a key when it rendered the form. The service first checks whether a reservation with this key already exists.',
      text: [],
      payloadKind: 'Request',
      payload: { headers: { 'Idempotency-Key': 'r_7f3c' }, body: { hotel_id: 211, room_type: 'deluxe', check_in: '2026-12-23', check_out: '2026-12-25', guest: 'Swampi' } },
      branch: { q: 'Key seen before?', options: [ { label: 'no: reserve', goto: 'tx' }, { label: 'yes: double click', goto: 'dbl' } ] }
    },
    {
      id: 'dbl', path: 'dbl', from: 'res', to: 'guest', reply: true, label: '200: same reservation r_7f3c', pc: ['return existing'],
      title: 'Other outcome: a double click',
      caption: 'The second click carries the same key. The service returns the reservation it already made instead of booking a second room.',
      text: [],
      payloadKind: 'Response',
      payload: { status: 200, reservation_id: 'r_7f3c', state: 'PENDING', duplicate: true },
      next: 'tx'
    },
    {
      id: 'tx', from: 'res', to: 'db', label: 'UPDATE 2 nights + INSERT, one transaction', pc: ['BEGIN', 'UPDATE room_type_inventory', 'INSERT reservations'],
      title: 'Reserve every night atomically',
      caption: 'A two-night stay touches two inventory rows. Both are incremented and the reservation row inserted in one transaction: either all happen or none.',
      text: ['The CHECK constraint (reserved <= total × 1.10) allows 10% overbooking, a common hotel practice because some guests cancel or do not show.'],
      payloadKind: 'Rows',
      payload: { inventory: [{ date: '2026-12-23', total: 20, reserved: '19 → 20' }, { date: '2026-12-24', total: 20, reserved: '21 → 22' }], max_allowed: 22, reservation: { id: 'r_7f3c', status: 'PENDING', expires_at: '15:52' } },
      branch: { q: 'Room left on every night?', options: [ { label: 'yes: commit', goto: 'payit' }, { label: 'no: sold out', goto: 'race' } ] }
    },
    {
      id: 'race', path: 'race', from: 'db', to: 'res', label: 'CHECK violated on 12-24 → ROLLBACK', pc: ['CHECK (reserved <= total * 1.10)'],
      title: 'Other outcome: someone took the last room',
      caption: 'Another guest committed a millisecond earlier and 24 Dec is at 22. The constraint fails, the whole transaction rolls back (23 Dec is untouched), and the guest sees "sold out" even though the cache said 3 left.',
      text: [],
      payloadKind: 'Error',
      payload: { error: 'check_violation', constraint: 'reserved_le_cap', date: '2026-12-24', http: 409 },
      next: 'exp'
    },
    {
      id: 'payit', from: 'res', to: 'pay', label: 'charge €378 for r_7f3c', pc: ['pay(key)'],
      title: 'Pay for the held room',
      caption: 'The reservation id is also the payment idempotency key, so a retried charge is not taken twice.',
      text: [],
      payloadKind: 'Charge',
      payload: { amount_eur: 378, idempotency_key: 'r_7f3c', result: 'succeeded' }
    },
    {
      from: 'res', to: 'mail', label: 'CONFIRMED → send confirmation', pc: ["status='CONFIRMED'"],
      title: 'Confirm',
      caption: 'The reservation becomes CONFIRMED and the guest gets an email.',
      text: [],
      payloadKind: 'Email',
      payload: { to: 'guest@example.com', subject: 'Your stay at Hôtel 211, 23–25 Dec, is confirmed', reservation_id: 'r_7f3c' }
    },
    {
      id: 'exp', from: 'timer', to: 'db', label: 'PENDING > 15 min → reserved − 1 per night', pc: ['expiry job'],
      title: 'Unpaid holds give the room back',
      caption: 'If a guest abandons payment, the expiry job cancels the reservation and decrements the nights again, so the room returns to sale.',
      text: [],
      payloadKind: 'Release',
      payload: { reservation_id: 'r_8a01', status: 'PENDING → EXPIRED', nights_released: ['2026-12-23', '2026-12-24'] }
    }
  ],
  decisions: [
    { q: 'How to prevent overselling?', options: [
      { name: 'DB constraint / conditional UPDATE in a transaction', verdict: 'good', why: 'The database enforces the rule even under races; simple to reason about.' },
      { name: 'Check in cache, then write', verdict: 'bad', why: 'Two requests read "1 left" at the same time and both book.' },
      { name: 'Distributed lock per hotel', verdict: 'ok', why: 'Works but adds a component and contention; not needed at this write rate.' } ] }
  ],
  refs: [
    { label: 'PostgreSQL docs: Constraints (CHECK)', url: 'https://www.postgresql.org/docs/current/ddl-constraints.html' },
    { label: 'Stripe docs: Idempotent requests', url: 'https://docs.stripe.com/api/idempotent_requests' },
    { label: 'ByteByteGo: System Design Interview Vol. 2, chapter "Hotel Reservation System" (book)', url: 'https://bytebytego.com/courses/system-design-interview/hotel-reservation-system' }
  ],
  verify: {
    checked: ['CHECK constraints reject rows that break the condition: PostgreSQL constraints docs.', 'Idempotency keys return the original result on retry: Stripe idempotent requests docs.'],
    uncertain: ['Hotel ids, counts, prices, the 10% overbooking and the 15-minute hold are illustrative.']
  }
});
