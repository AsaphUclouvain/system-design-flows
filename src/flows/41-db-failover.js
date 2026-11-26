flow({
  id: 'db-failover',
  title: 'Automatic database failover (leader lock + promotion)',
  category: 'Databases & replication',
  tags: ['Leader lock with TTL', 'etcd / DCS', 'Replica promotion', 'Fencing', 'Split brain', 'Lost async writes'],
  summary: 'The primary\'s machine dies at 03:12. How does the cluster notice, pick a replica that is not too far behind, promote it, and move clients over, without ending up with two primaries? Follows the Patroni-style design: a leader key with a TTL in etcd, a race to acquire it, and fencing of the old leader.',
  requirements: {
    functional: ['Detect a dead primary without a human.', 'Promote the most up-to-date healthy replica.', 'Point clients at the new primary.'],
    nonFunctional: ['Never two writable primaries at once (split brain).', 'Failover in well under a minute; bounded data loss (async) or none (sync).']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'app', label: 'Order API', sub: 'connects via VIP', kind: 'client', icon: 'laptop', x: 0, y: 1, desc: 'Connects to a stable address (virtual IP, DNS name or proxy) that always points to whoever holds the leader key.' },
    { id: 'proxy', label: 'HAProxy', sub: 'checks /primary', kind: 'edge', icon: 'split', x: 1, y: 1, desc: 'Health-checks each node\'s Patroni REST endpoint and only routes writes to the node that answers 200 on /primary.' },
    { id: 'p', label: 'pg-1 (primary)', sub: 'Patroni + PostgreSQL', kind: 'db', icon: 'db', x: 2, y: 0, desc: 'Current leader. Its Patroni agent renews the leader key every loop (default 10 s). If it cannot renew, it demotes itself.' },
    { id: 'r1', label: 'pg-2 (replica)', sub: 'lag 0 MB', kind: 'db', icon: 'db', x: 2, y: 2, desc: 'Streaming replica with an agent that watches the leader key.' },
    { id: 'r2', label: 'pg-3 (replica)', sub: 'lag 40 MB', kind: 'db', icon: 'db', x: 3, y: 2, desc: 'A replica that fell behind during a backup. Too far behind to be a safe leader.' },
    { id: 'dcs', label: 'etcd', sub: '3-node consensus store', kind: 'cache', icon: 'lock', x: 3, y: 0, desc: 'Distributed configuration store. Holds /service/shop/leader with a TTL. Uses Raft itself, so it stays correct as long as a majority of its nodes are up.' }
  ],
  pseudo: `
# every agent, every loop_wait (10 s)
def ha_loop(me):
    leader = dcs.get("/leader")
    if leader == me:
        if not dcs.update("/leader", me, ttl=30, prev=me):
            demote_to_replica(me)                 # lost the lock: stop writes
        return
    if leader is None:                            # key expired: race
        if my_lag() > maximum_lag_on_failover: return
        if not am_healthiest(): return            # ask the other members
        if dcs.create("/leader", me, ttl=30):     # atomic: only one wins
            pg_promote()                          # replica -> read-write
    else:
        follow(leader)                            # replicate from the leader`,
  steps: [
    {
      from: 'p', to: 'dcs', label: 'PUT /leader=pg-1 ttl=30 (renew)', pc: ['def ha_loop', 'leader == me', 'dcs.update'],
      title: 'Normal life: the leader renews its lock',
      caption: 'Every 10 seconds pg-1\'s agent renews the leader key in etcd with a 30-second TTL, using compare-and-set so it only succeeds if pg-1 still owns it.',
      text: ['The lock is the single source of truth for "who is primary". PostgreSQL itself has no built-in leader election; Patroni adds it by using a consensus store (etcd, Consul or ZooKeeper).'],
      payloadKind: 'etcd write',
      payload: { key: '/service/shop/leader', value: 'pg-1', ttl: 30, prev_value: 'pg-1', loop_wait: 10 }
    },
    {
      from: 'app', to: 'p', label: '03:12:04 INSERT … → connection refused', pc: ['dcs.update'],
      title: 'The primary\'s host dies; writes fail',
      caption: 'pg-1 loses power. It stops renewing the key. Writes from the Order API start failing with connection errors.',
      text: ['Nothing happens instantly: the cluster cannot tell a dead primary from a slow network, so it waits for the TTL to run out. That wait is the price of not flapping on a short glitch.'],
      payloadKind: 'Event',
      payload: { node: 'pg-1', last_renewal: '03:12:01', key_expires: '03:12:31', client_errors: 'connection refused' }
    },
    {
      from: 'dcs', to: 'r1', label: '03:12:31  /leader expired', pc: ['leader is None'],
      title: 'The lock expires; replicas notice',
      caption: 'At 03:12:31 the TTL runs out and etcd deletes the key. On their next loop, pg-2 and pg-3 see that there is no leader.',
      text: ['Detection time is roughly ttl plus up to one loop_wait. Lower values fail over faster but risk unnecessary failovers on short network blips.'],
      payloadKind: 'Watch event',
      payload: { key: '/service/shop/leader', event: 'DELETE (ttl expired)', at: '03:12:31' },
      branch: { q: 'Which replica tries to take the lock?', options: [ { label: 'pg-2 (caught up)', goto: 'good' }, { label: 'pg-3 (40 MB behind)', goto: 'lagging' } ] }
    },
    {
      id: 'lagging', path: 'lagging replica', from: 'r2', to: 'r2', label: 'lag 40 MB > 1 MB: stand down', pc: ['maximum_lag_on_failover'],
      title: 'A lagging replica refuses to run',
      caption: 'pg-3 is 40 MB of WAL behind, more than maximum_lag_on_failover allows. Promoting it would throw away those writes, so it does not enter the race.',
      text: ['Agents also ask each other over their REST APIs and only race if no healthier member exists. pg-2 is ahead, so pg-3 will follow whoever wins.'],
      payloadKind: 'Eligibility check',
      payload: { node: 'pg-3', received_lsn: '0/9F000000', best_known_lsn: '0/A1800000', lag_bytes: 41943040, maximum_lag_on_failover: 1048576, eligible: false },
      next: 'good'
    },
    {
      id: 'good', from: 'r1', to: 'dcs', label: 'CREATE /leader=pg-2 (if absent)', pc: ['am_healthiest', 'dcs.create'],
      title: 'pg-2 wins the race for the lock',
      caption: 'pg-2 is caught up and the healthiest member. It atomically creates the leader key; etcd\'s create-if-absent guarantees that only one node can succeed.',
      text: ['This is where consensus matters: etcd\'s Raft log orders the competing requests, so two replicas can never both believe they created the key.'],
      payloadKind: 'etcd transaction',
      payload: { if: 'version(/service/shop/leader) == 0', then: 'PUT /service/shop/leader = pg-2 ttl=30', result: 'succeeded' }
    },
    {
      from: 'r1', to: 'r1', label: 'pg_promote()', pc: ['pg_promote'],
      title: 'pg-2 promotes itself',
      caption: 'Holding the lock, pg-2 tells PostgreSQL to leave recovery and accept writes. It starts a new timeline so its WAL history can be told apart from pg-1\'s.',
      text: ['With asynchronous replication, any commits pg-1 acknowledged after pg-2\'s last received LSN are lost here. With synchronous mode, Patroni only lets a synchronous standby take over, so nothing acknowledged is lost.'],
      payloadKind: 'Promotion',
      payload: { node: 'pg-2', action: 'pg_promote()', new_timeline: 4, last_replayed_lsn: '0/A1800000', possibly_lost_async_commits: '0–a few' }
    },
    {
      from: 'r2', to: 'r1', async: true, label: 'follow pg-2 (timeline 4)', pc: ['follow(leader)'],
      title: 'The other replica follows the new leader',
      caption: 'pg-3 sees pg-2 in the leader key, repoints its replication connection, and catches up on timeline 4.',
      text: [],
      payloadKind: 'Reconfigure',
      payload: { node: 'pg-3', primary_conninfo: 'host=pg-2 port=5432', recovery_target_timeline: 'latest' }
    },
    {
      from: 'proxy', to: 'r1', label: 'GET :8008/primary → 200', pc: ['follow(leader)'],
      title: 'The proxy moves traffic',
      caption: 'HAProxy\'s health check now gets 200 from pg-2 and 503 from the others, so new connections go to pg-2. The Order API retries and its writes succeed again: about 35 seconds of write downtime.',
      text: ['Clients should retry idempotently: a write that failed during failover may or may not have committed on pg-1.'],
      payloadKind: 'Health checks',
      payload: { 'pg-1': 'timeout', 'pg-2': '200 primary', 'pg-3': '503 replica', write_downtime_s: 35 }
    },
    {
      from: 'p', to: 'dcs', label: '03:20 pg-1 back: GET /leader = pg-2', pc: ['leader = dcs.get', 'follow(leader)'],
      title: 'The old primary comes back and is fenced',
      caption: 'When pg-1 boots, its agent reads the lock, sees pg-2 owns it, and starts PostgreSQL as a replica (rewinding divergent WAL with pg_rewind) instead of as a primary.',
      text: ['This is what prevents split brain: a node may only accept writes while it holds the lock. A primary cut off from etcd also demotes itself when it cannot renew, so an isolated old primary stops taking writes.'],
      payloadKind: 'Rejoin',
      payload: { node: 'pg-1', leader_key: 'pg-2', action: ['pg_rewind --source-server=pg-2', 'start as replica'], writable: false },
      failure: ['**No fencing (naive script):** pg-1 restarts as a primary, both nodes take writes, and their data diverges. Repairing that by hand is one of the worst outages a database team can have.']
    }
  ],
  decisions: [
    { q: 'Who decides that the primary is dead?', options: [
      { name: 'A consensus store (etcd / ZooKeeper / Consul)', verdict: 'great', why: 'A majority decides, so a network partition cannot produce two leaders. What Patroni and Kubernetes operators use.' },
      { name: 'The replicas ping the primary', verdict: 'bad', why: 'A replica that is cut off from the primary cannot tell "primary dead" from "I am isolated", and promotes itself: split brain.' } ] }
  ],
  refs: [
    { label: 'Patroni docs: dynamic configuration (ttl, loop_wait, maximum_lag_on_failover, synchronous_mode)', url: 'https://patroni.readthedocs.io/en/latest/dynamic_configuration.html' },
    { label: 'Patroni: a template for PostgreSQL HA with ZooKeeper, etcd or Consul', url: 'https://patroni.readthedocs.io/en/latest/' },
    { label: 'PostgreSQL docs: failover', url: 'https://www.postgresql.org/docs/current/warm-standby-failover.html' },
    { label: 'ByteByteGo, System Design Interview Vol. 1: Scale from zero to millions of users', url: 'https://bytebytego.com/courses/system-design-interview/scale-from-zero-to-millions-of-users', note: 'replica promoted when the primary goes offline.' }
  ],
  verify: {
    checked: ['ttl (default 30 s, "time before automatic failover"), loop_wait (default 10 s), maximum_lag_on_failover, synchronous_mode: Patroni dynamic configuration docs.', 'Replica promotion when the primary fails: ByteByteGo Vol. 1 chapter 1; PostgreSQL ships no failure detection of its own, and the old primary must be told it is no longer primary (STONITH): PostgreSQL failover docs.'],
    uncertain: ['The exact sequence inside Patroni\'s HA loop is simplified to its essentials; the real loop has more states (paused, failsafe mode, standby clusters).', 'The 35 s downtime is an estimate from the defaults, not a measurement.']
  }
});
