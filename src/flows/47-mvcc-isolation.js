flow({
  id: 'mvcc-isolation',
  title: 'Transactions, MVCC and isolation levels (two concurrent seat bookings)',
  category: 'Databases & replication',
  tags: ['ACID', 'MVCC snapshots', 'Read Committed', 'Repeatable Read', 'Lost update', 'Serialization failure + retry'],
  summary: 'Two people try to book the last seat at the same moment. With PostgreSQL\'s multi-version concurrency control, readers and writers do not block each other, but what each transaction sees depends on the isolation level. Watch the default Read Committed level, then Repeatable Read raising a serialization failure that the app retries.',
  requirements: {
    functional: ['Book a seat: decrement available seats and insert a booking, atomically.', 'Never sell the same last seat twice.'],
    nonFunctional: ['Readers never wait for writers.', 'The app handles retryable errors.']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'ana', label: 'Ana\'s request', sub: 'transaction T1', kind: 'client', icon: 'laptop', x: 0, y: 0, desc: 'Booking API worker handling Ana\'s checkout.' },
    { id: 'ben', label: 'Ben\'s request', sub: 'transaction T2', kind: 'client', icon: 'phone', x: 0, y: 2, desc: 'Another worker handling Ben, a few milliseconds later.' },
    { id: 'pg', label: 'PostgreSQL', sub: 'MVCC', kind: 'db', icon: 'db', x: 2, y: 1, desc: 'Keeps several versions of each row, tagged with the transaction that created and deleted them. Each statement or transaction reads from a snapshot.' },
    { id: 'row', label: 'Row: show 77', sub: 'seats_left versions', kind: 'cache', icon: 'layers', x: 3, y: 0, desc: 'The physical versions of the row. An UPDATE writes a new version; the old one stays until no snapshot needs it, then VACUUM removes it.' },
    { id: 'lock', label: 'Row lock', sub: 'one writer at a time', kind: 'worker', icon: 'lock', x: 3, y: 2, desc: 'Two transactions updating the same row still serialise on a row-level lock; the second waits for the first to commit or roll back.' }
  ],
  pseudo: `
def book(show_id, user):
    for attempt in range(3):
        try:
            with db.transaction(isolation=LEVEL):
                seats = db.one("SELECT seats_left FROM shows WHERE id=%s", show_id)
                if seats < 1: return "sold out"
                db.run("UPDATE shows SET seats_left = seats_left - 1 WHERE id=%s", show_id)
                db.run("INSERT INTO bookings(show_id, user_id) VALUES (%s, %s)", show_id, user)
            return "booked"                              # COMMIT
        except SerializationFailure:                    # SQLSTATE 40001
            continue                                    # retry from the start
    return "try again"`,
  steps: [
    {
      from: 'ana', to: 'pg', label: 'BEGIN; SELECT seats_left → 1', pc: ['def book', 'with db.transaction', 'SELECT seats_left'],
      title: 'Ana\'s transaction reads: 1 seat left',
      caption: 'T1 begins and reads the show row from its snapshot: seats_left = 1. No lock is taken for a plain read.',
      text: ['PostgreSQL\'s docs: with MVCC, reading never blocks writing and writing never blocks reading. Each statement sees a snapshot of committed data.'],
      payloadKind: 'T1 snapshot',
      payload: { tx: 'T1 (xid 5001)', sql: 'SELECT seats_left FROM shows WHERE id = 77', result: 1 }
    },
    {
      from: 'ben', to: 'pg', label: 'BEGIN; SELECT seats_left → 1', pc: ['SELECT seats_left'],
      title: 'Ben\'s transaction also reads 1',
      caption: 'T2 starts 3 ms later. T1 has not written yet, so T2 also sees seats_left = 1. Both think they can book.',
      text: ['This is the classic setup for a lost update: two read-modify-write cycles interleaved.'],
      payloadKind: 'T2 snapshot',
      payload: { tx: 'T2 (xid 5002)', result: 1 }
    },
    {
      from: 'ana', to: 'row', label: 'UPDATE seats_left = seats_left - 1  (new version: 0)', pc: ['UPDATE shows'],
      title: 'Ana updates: a new row version, plus a row lock',
      caption: 'T1 decrements. PostgreSQL writes a new version of the row (seats_left = 0, created by xid 5001) and marks the old one as deleted by 5001. T1 holds the row lock.',
      text: ['Until T1 commits, other transactions still see the old version (1). That is MVCC: versions, not overwrites.'],
      payloadKind: 'Row versions',
      payload: { versions: [{ seats_left: 1, xmin: 4870, xmax: 5001 }, { seats_left: 0, xmin: 5001, xmax: null }], locked_by: 'T1' }
    },
    {
      from: 'ben', to: 'lock', label: 'UPDATE … waits for T1\'s row lock', pc: ['UPDATE shows'],
      title: 'Ben\'s update has to wait',
      caption: 'T2 tries the same UPDATE. The row is locked by T1, so T2 blocks until T1 finishes. Meanwhile Ana\'s transaction inserts her booking and commits.',
      text: ['Readers do not wait, but two writers to the same row do. What happens when T2 wakes up depends on the isolation level.'],
      payloadKind: 'Lock wait',
      payload: { waiting: 'T2', holder: 'T1', then: 'T1 INSERT booking; COMMIT' },
      branch: { q: 'Which isolation level does the transaction use?', options: [ { label: 'Read Committed (default)', goto: 'rc' }, { label: 'Repeatable Read', goto: 'rr' } ] }
    },
    {
      id: 'rc', path: 'Read Committed', from: 'lock', to: 'row', label: 're-check row: seats_left=0 → 0-1 = -1', pc: ['UPDATE shows'],
      title: 'Read Committed: the update re-reads the new version',
      caption: 'When T1 commits, T2\'s UPDATE re-evaluates on the newest row version and applies seats_left - 1 to 0, giving -1. T2 already decided based on its stale SELECT. Two bookings, minus one seats.',
      text: ['The fix in Read Committed is to make the check part of the write: UPDATE … SET seats_left = seats_left - 1 WHERE id = 77 AND seats_left > 0, and check that one row was updated; or lock the row up front with SELECT … FOR UPDATE. A CHECK (seats_left >= 0) constraint is a good last line of defence.'],
      payloadKind: 'Outcome',
      payload: { T2_update: 'applied to newest version', seats_left: -1, bookings: 2, bug: 'oversold', fix: 'UPDATE … WHERE seats_left > 0  (or SELECT … FOR UPDATE)' },
      end: true
    },
    {
      id: 'rr', path: 'Repeatable Read', from: 'pg', to: 'ben', reply: true, label: 'ERROR 40001 could not serialize access', pc: ['except SerializationFailure'],
      title: 'Repeatable Read: T2 gets a serialization failure',
      caption: 'At Repeatable Read, T2 must keep seeing its snapshot, but the row it wants to update was changed by a transaction that committed after that snapshot. PostgreSQL refuses: "could not serialize access due to concurrent update".',
      text: ['PostgreSQL\'s docs say applications using Repeatable Read or Serializable must be ready to retry transactions on serialization failures. The error is safe: T2 is rolled back and nothing it did is kept.'],
      payloadKind: 'Error',
      payload: { sqlstate: '40001', message: 'could not serialize access due to concurrent update', T2: 'rolled back' }
    },
    {
      path: 'Repeatable Read', from: 'ben', to: 'pg', label: 'retry: BEGIN; SELECT → 0 → "sold out"', pc: ['continue', 'if seats < 1'],
      title: 'The app retries and sees the truth',
      caption: 'Ben\'s worker catches 40001 and runs the whole transaction again with a fresh snapshot. It now reads seats_left = 0 and returns "sold out". Exactly one booking exists.',
      text: ['Retrying the whole function, not just the failed statement, is the important part: the decision must be made again on fresh data.'],
      payloadKind: 'Retry',
      payload: { attempt: 2, seats_left: 0, result: 'sold out', bookings: 1 }
    }
  ],
  decisions: [
    { q: 'How to prevent overselling?', options: [
      { name: 'Conditional UPDATE (WHERE seats_left > 0)', verdict: 'great', why: 'One statement, works at Read Committed, no retries for the common case.' },
      { name: 'SELECT … FOR UPDATE then UPDATE', verdict: 'good', why: 'Pessimistic: the second transaction waits, then sees the new value. Simple; holds locks longer.' },
      { name: 'Repeatable Read / Serializable + retry loop', verdict: 'good', why: 'Protects complex multi-row logic you cannot express in one statement. Every caller must retry on 40001.' } ] }
  ],
  refs: [
    { label: 'PostgreSQL docs: Transaction isolation', url: 'https://www.postgresql.org/docs/current/transaction-iso.html', note: 'Read Committed re-evaluation, serialization failures, retries.' },
    { label: 'PostgreSQL docs: MVCC introduction', url: 'https://www.postgresql.org/docs/current/mvcc-intro.html' },
    { label: 'ByteByteGo, System Design Interview Vol. 2: Hotel reservation system (concurrency, double booking)', url: 'https://bytebytego.com/courses/system-design-interview/hotel-reservation-system' }
  ],
  verify: {
    checked: ['Reading never blocks writing, snapshots per statement, Read Committed re-checks updated rows, Repeatable Read error text and retry advice: PostgreSQL docs.'],
    uncertain: ['xid numbers and timing are illustrative.']
  }
});
