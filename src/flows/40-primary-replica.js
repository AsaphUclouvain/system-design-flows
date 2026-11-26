flow({
  id: 'primary-replica',
  title: 'Primary–replica ("master–slave") replication',
  category: 'Databases & replication',
  tags: ['Single leader', 'WAL streaming', 'Sync vs async commit', 'Read/write split', 'Read-your-writes'],
  summary: 'One database takes every write and streams its write-ahead log to read-only copies. Follow an order INSERT through a query router to the primary, then choose: an asynchronous commit that answers immediately, or a synchronous commit that waits for a replica to flush the log. Then see why a read sent to a lagging replica can miss the order you just placed.',
  requirements: {
    functional: [
      'All writes (INSERT, UPDATE, DELETE) go to one primary.',
      'Reads can be spread over several read-only replicas.',
      'A user who just placed an order can see it on the next page load.'
    ],
    nonFunctional: [
      'Read capacity grows by adding replicas, without touching the primary.',
      'Losing a replica never loses data; losing the primary loses at most the last few hundred milliseconds of writes (async), or nothing that was acknowledged (sync).',
      'Replication lag is measured and alarmed on (target under 1 s).'
    ]
  },
  estimates: [
    { label: 'Read : write', value: '9 : 1', note: 'Typical of shops and feeds; the reason a read/write split pays off.' },
    { label: 'Writes', value: '1,200 / s', note: 'All on the primary. Replicas replay the same WAL, so they need similar disk throughput.' },
    { label: 'Reads', value: '11,000 / s', note: 'Split over 2 replicas plus the primary.' },
    { label: 'Sync commit cost', value: '+1 round trip', note: 'PostgreSQL: the minimum extra wait is the primary↔standby round trip (≈0.5 ms same zone, 1–2 ms across zones).' }
  ],
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'app', label: 'Order API', sub: 'FastAPI', kind: 'client', icon: 'laptop', x: 0, y: 1, desc: 'The application. It does not know which database is which: it talks to the router.' },
    { id: 'router', label: 'Query router', sub: 'proxy / driver', kind: 'edge', icon: 'split', x: 1, y: 1, desc: 'Sends writes and transactions to the primary, plain reads to a replica. Can be a proxy (ProxySQL, Pgpool-II) or logic in the app\'s data layer.' },
    { id: 'primary', label: 'Primary', sub: 'PostgreSQL, read-write', kind: 'db', icon: 'db', x: 2, y: 1, desc: 'The single leader. The only node that accepts writes. Every change is first appended to its write-ahead log (WAL).' },
    { id: 'wal', label: 'WAL sender', sub: 'streams log records', kind: 'worker', icon: 'log', x: 2, y: 0, desc: 'One process per connected standby. Reads new WAL from the primary and streams it over a replication connection.' },
    { id: 'r1', label: 'Replica 1', sub: 'hot standby, zone b', kind: 'db', icon: 'db', x: 3, y: 0, desc: 'Read-only copy. Receives WAL, writes it to disk, replays it. Can be the synchronous standby.' },
    { id: 'r2', label: 'Replica 2', sub: 'hot standby, zone c', kind: 'db', icon: 'db', x: 3, y: 2, desc: 'Second read-only copy, asynchronous. Usually a few milliseconds behind; more under load.' }
  ],
  pseudo: `
def handle(sql, session):
    if is_write(sql) or session.in_transaction:
        return primary.execute(sql)          # one leader
    return pick_replica(session).execute(sql)

# on the primary, at COMMIT
def commit(tx):
    lsn = wal.append(tx.records)             # write-ahead log first
    wal.flush_to_disk(lsn)
    if synchronous_standby_names:            # sync mode
        wait_until(standby_flushed_lsn >= lsn)
    return "COMMIT", lsn                     # async: no wait

# on each replica, forever
def replay_loop():
    for rec in stream_from(primary, start=my_lsn):
        write_and_flush(rec); reply(flushed=rec.lsn)
        apply(rec)                           # now visible to reads

def pick_replica(session):
    for r in replicas:                       # read-your-writes
        if r.replay_lsn >= session.last_write_lsn:
            return r
    return primary`,
  steps: [
    {
      from: 'app', to: 'router', label: 'INSERT INTO orders …', pc: ['def handle', 'if is_write'],
      title: 'The API places an order',
      caption: 'Ana checks out. The Order API sends one INSERT to the query router, exactly as it would to a single database.',
      text: ['The router looks at the statement. An INSERT is a write, so only one machine may take it: the primary. Keeping one writer is what makes single-leader replication simple: there is never a conflict between two writers.'],
      payloadKind: 'SQL',
      payload: { sql: "INSERT INTO orders (id, user_id, total_cents, status) VALUES ('ord_8812', 'usr_ana', 4599, 'paid')", session: 'sess_ana_41', in_transaction: false }
    },
    {
      from: 'router', to: 'primary', label: 'write → primary:5432', pc: ['return primary.execute'],
      title: 'Writes always go to the primary',
      caption: 'The router forwards the INSERT to the primary at 10.0.1.10:5432. Replicas would reject it: they are read-only hot standbys.',
      text: ['ByteByteGo\'s first scaling chapter describes the same split: the primary ("master") takes data-modifying commands; replicas ("slaves") get copies and serve reads. Newer documentation says primary and standby or replica.'],
      payloadKind: 'Routed query',
      payload: { target: 'primary 10.0.1.10:5432', reason: 'is_write(INSERT)', sql: 'INSERT INTO orders …' }
    },
    {
      from: 'primary', to: 'primary', label: 'WAL append + flush, LSN 0/3A41F28', pc: ['def commit', 'wal.append', 'flush_to_disk'],
      title: 'The primary writes its log first',
      caption: 'Before the change counts as committed, the primary appends it to the write-ahead log and flushes the log to disk. The position in the log is the LSN.',
      text: ['The WAL is the single source of truth for replication: replicas do not re-run SQL, they replay the same log records byte for byte (physical replication).'],
      payloadKind: 'WAL record',
      payload: { lsn: '0/3A41F28', xid: 918244, records: ['INSERT heap orders', 'INSERT index orders_pkey', 'COMMIT'], flushed_locally: true },
      fields: { lsn: 'Log sequence number: a byte position in the WAL. Replicas report how far they have received, flushed and replayed in LSNs.' },
      branch: { q: 'Is a synchronous standby configured?', options: [ { label: 'no: async (default)', goto: 'async1' }, { label: 'yes: sync commit', goto: 'sync1' } ] }
    },
    {
      id: 'async1', path: 'async', from: 'primary', to: 'router', reply: true, label: 'COMMIT ok (0.9 ms)', pc: ['return "COMMIT"'],
      title: 'Async: answer now, replicate after',
      caption: 'With no synchronous standby, the primary acknowledges as soon as its own WAL is on disk. Ana sees "Order placed" in under a millisecond of database time.',
      text: ['PostgreSQL\'s docs say it plainly: with asynchronous shipping, WAL records are sent after commit, so a crash of the primary in that window loses those transactions.'],
      payloadKind: 'Response',
      payload: { result: 'COMMIT', lsn: '0/3A41F28', waited_for_standby: false, db_time_ms: 0.9 },
      failure: ['**Primary dies 50 ms later:** the order was acknowledged to Ana but may not be on any replica. After failover it is gone. This is the price of async replication; see the failover flow.']
    },
    {
      path: 'async', from: 'wal', to: 'r2', async: true, label: 'stream WAL from 0/3A41F28', pc: ['for rec in stream_from', 'write_and_flush', 'apply(rec)'],
      title: 'The log streams to the replicas',
      caption: 'The WAL sender pushes the new records to each replica over a replication connection. Replica 2 is busy with a large report and is 400 ms behind.',
      text: ['Each replica writes the records to its own WAL, replies with how far it has flushed, then replays them so the rows become visible to queries.'],
      payloadKind: 'Replication status',
      payload: { replica: 'r2', sent_lsn: '0/3A41F28', flush_lsn: '0/3A41F28', replay_lsn: '0/3A40B10', replay_lag_ms: 400 },
      fields: { replay_lag_ms: 'Time between the primary writing the record and this replica applying it. PostgreSQL shows it in pg_stat_replication.replay_lag.' }
    },
    {
      path: 'async', from: 'app', to: 'router', label: 'SELECT … WHERE id=ord_8812', pc: ['return pick_replica', 'def pick_replica'],
      title: 'Ana reloads her orders page',
      caption: 'The confirmation page immediately reads the order back. It is a plain SELECT, so the router may send it to a replica.',
      text: ['If the router picked Replica 2 blindly, the row would not be there yet: Ana would see "order not found" for her own order. This is replication lag made visible.'],
      payloadKind: 'SQL',
      payload: { sql: "SELECT * FROM orders WHERE id = 'ord_8812'", session: 'sess_ana_41', last_write_lsn: '0/3A41F28' },
      fields: { last_write_lsn: 'The router remembered the LSN of Ana\'s last write in her session. It is the key to read-your-writes.' }
    },
    {
      path: 'async', from: 'router', to: 'r1', label: 'read → replica 1 (caught up)', pc: ['for r in replicas', 'if r.replay_lsn', '        return r'],
      title: 'Read-your-writes: pick a replica that has caught up',
      caption: 'The router compares Ana\'s last write LSN with each replica\'s replay LSN. Replica 2 is behind; Replica 1 has replayed past it, so the read goes there and finds the order.',
      text: ['If no replica had caught up, the router would send this one read to the primary. Other common fixes: pin a user to the primary for a few seconds after a write, or accept staleness for pages where it does not matter.'],
      payloadKind: 'Routing decision',
      payload: { candidates: [{ replica: 'r1', replay_lsn: '0/3A41F30', ok: true }, { replica: 'r2', replay_lsn: '0/3A40B10', ok: false }], chosen: 'r1', rows: 1 },
      end: true
    },
    {
      id: 'sync1', path: 'sync', from: 'wal', to: 'r1', label: 'WAL 0/3A41F28, wait for flush', pc: ['if synchronous_standby_names', 'wait_until'],
      title: 'Sync: the commit waits for a standby',
      caption: 'Replica 1 is listed in synchronous_standby_names. The primary sends it the commit record and holds Ana\'s COMMIT until Replica 1 confirms it is on its disk.',
      text: ['PostgreSQL\'s synchronous_commit setting chooses what "confirmed" means: remote_write (in the standby\'s OS), on (flushed to its disk, the default with a sync standby), or remote_apply (replayed and visible to reads there).'],
      payloadKind: 'Replication',
      payload: { to: 'r1 (synchronous)', lsn: '0/3A41F28', synchronous_commit: 'on', waits_for: 'flush_lsn >= 0/3A41F28' }
    },
    {
      path: 'sync', from: 'r1', to: 'wal', reply: true, label: 'flushed 0/3A41F28', pc: ['write_and_flush'],
      title: 'Replica 1 confirms the flush',
      caption: 'Replica 1 writes the record to its WAL, flushes it, and replies. About 1.4 ms passed: one round trip to zone b plus a disk flush.',
      text: ['Now the order exists on two disks in two zones. Losing it requires both machines to fail at once.'],
      payloadKind: 'Standby reply',
      payload: { standby: 'r1', write_lsn: '0/3A41F28', flush_lsn: '0/3A41F28', apply_lsn: '0/3A41F00', rtt_ms: 1.4 }
    },
    {
      path: 'sync', from: 'primary', to: 'router', reply: true, label: 'COMMIT ok (2.3 ms)', pc: ['return "COMMIT"'],
      title: 'Only now does Ana get her confirmation',
      caption: 'The primary releases the commit. Ana\'s order is durable on two machines, at the cost of extra latency on every write transaction.',
      text: ['Read-only transactions do not wait for the standby, only commits that wrote something. If the only synchronous standby goes down, commits block until it returns or another standby is named: plan for at least two candidates (for example ANY 1 (r1, r2)).'],
      payloadKind: 'Response',
      payload: { result: 'COMMIT', lsn: '0/3A41F28', waited_for_standby: 'r1', db_time_ms: 2.3 },
      failure: ['**Sync standby down, no other candidate:** every write commit hangs. That is why setups use a quorum like ANY 1 (r1, r2), or MySQL\'s semi-sync, which falls back to async after a timeout (trading safety for availability).'],
      end: true
    }
  ],
  decisions: [
    {
      q: 'Synchronous or asynchronous replication?',
      options: [
        { name: 'Asynchronous', verdict: 'good', why: 'Fastest writes, primary never blocked by a slow replica. Risk: the last moments of acknowledged writes can be lost on failover. The default in PostgreSQL and MySQL.' },
        { name: 'Synchronous to one of several (quorum)', verdict: 'great', why: 'No acknowledged write is lost if the primary dies, and one slow standby does not block commits. Costs one round trip per commit.' },
        { name: 'Synchronous to all replicas', verdict: 'bad', why: 'Any single replica failure stops all writes. Availability gets worse as you add replicas.' }
      ]
    },
    {
      q: 'Where does the read/write routing live?',
      options: [
        { name: 'In the app\'s data layer', verdict: 'good', why: 'Knows about sessions and transactions, so read-your-writes is easy. Every service has to implement it.' },
        { name: 'In a database proxy', verdict: 'good', why: 'Apps stay unchanged; the proxy parses SQL. It cannot know about user sessions unless told, so stale reads after writes need care.' }
      ]
    }
  ],
  refs: [
    { label: 'ByteByteGo, System Design Interview Vol. 1: Scale from zero to millions of users', url: 'https://bytebytego.com/courses/system-design-interview/scale-from-zero-to-millions-of-users', note: 'database replication section (master/slave, read/write split).' },
    { label: 'ByteByteGo newsletter: Read replica pattern', url: 'https://blog.bytebytego.com/p/read-replica-pattern' },
    { label: 'ByteByteGo newsletter: How to implement read replica pattern', url: 'https://blog.bytebytego.com/p/how-to-implement-read-replica-pattern', note: 'app-side vs middleware routing.' },
    { label: 'PostgreSQL docs: Log-shipping standby servers (streaming and synchronous replication)', url: 'https://www.postgresql.org/docs/current/warm-standby.html' },
    { label: 'PostgreSQL docs: synchronous_commit (remote_write, on, remote_apply)', url: 'https://www.postgresql.org/docs/current/runtime-config-wal.html' }
  ],
  verify: {
    checked: ['Async commit window, sync commit wait and "read-only transactions do not wait": PostgreSQL docs, sections 26.2 and 19.5.', 'Primary takes writes, replicas take reads: ByteByteGo Vol. 1 chapter 1 and the two read-replica newsletter posts.'],
    uncertain: ['Latencies (0.9 ms, 1.4 ms, 2.3 ms) are illustrative, not measured.', 'The LSN-based replica choice is one technique (used by some proxies and ORMs); many routers only offer "stick to primary after a write".']
  }
});
