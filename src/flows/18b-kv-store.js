flow({
  id: 'kv-store',
  title: 'Distributed key-value store (Dynamo-style)',
  category: 'Databases & replication',
  tags: ['Consistent hashing', 'Replication N=3', 'Quorum R/W', 'Vector clocks', 'Hinted handoff', 'Anti-entropy'],
  summary: 'A shopping-cart store must accept writes even while machines fail. Follow a PUT through a consistent-hash ring to three replicas, a quorum write that succeeds while one node is down, a hint that heals it later, a read that finds two versions and repairs the stale one, and background Merkle-tree sync.',
  requirements: {
    functional: [
      'GET and PUT values by key (a cart per user).',
      'Writes are accepted even when some replicas are unreachable.',
      'Concurrent writes to the same cart are never silently lost.'
    ],
    nonFunctional: [
      'p99 under 10 ms for reads and writes inside one region.',
      'No single point of failure; nodes can be added or removed without downtime.',
      'Survives the loss of any one node, and of one availability zone.'
    ]
  },
  estimates: [
    { label: 'Keys', value: '400 million', note: 'Carts and sessions, ~2 KB each: ~800 GB, × 3 replicas = 2.4 TB.' },
    { label: 'Nodes', value: '24', note: '~100 GB of data per node, with room for growth and rebalancing.' },
    { label: 'Traffic', value: '150,000 ops / s', note: '~60% reads.' },
    { label: 'Virtual nodes', value: '256 per node', note: 'Spreads each node\'s share of the ring into many small ranges for even load.' }
  ],
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'api', label: 'Cart API', sub: 'FastAPI', kind: 'service', icon: 'cart', x: 0, y: 1, desc: 'Reads and writes carts through the store\'s client.' },
    { id: 'coord', label: 'Entry node', sub: 'node A', kind: 'service', icon: 'ring', x: 1, y: 1, desc: 'Any node can receive a request. A write for a key it does not own is forwarded to the key\'s first owner, which coordinates it (Dynamo §4.5). Reads can be coordinated by any node.' },
    { id: 'b', label: 'Node B', sub: 'replica 1, coordinator', kind: 'db', icon: 'server', x: 2, y: 0, desc: 'First owner of the key on the ring (zone a). It coordinates writes to this key: it increments the vector clock, stores the version and sends it to the other owners.' },
    { id: 'c', label: 'Node C', sub: 'replica 2, zone b', kind: 'db', icon: 'server', x: 3, y: 0, desc: 'Second owner.' },
    { id: 'd', label: 'Node D', sub: 'replica 3, zone c', kind: 'db', icon: 'server', x: 3, y: 1, desc: 'Third owner; about to be unreachable.' },
    { id: 'e', label: 'Node E', sub: 'next on ring', kind: 'db', icon: 'server', x: 2, y: 2, desc: 'Next healthy node after D; holds a hint while D is down.' },
    { id: 'gossip', label: 'Membership', sub: 'gossip', kind: 'worker', icon: 'pulse', x: 1, y: 0, desc: 'Every node shares who is alive and who owns which ranges.' },
    { id: 'ae', label: 'Anti-entropy', sub: 'Merkle trees', kind: 'worker', icon: 'hash', x: 3, y: 2, desc: 'Background comparison of replicas to fix any remaining differences.' }
  ],
  steps: [
    {
      from: 'api', to: 'coord', label: 'PUT cart:usr_ana',
      title: 'The API writes a cart',
      caption: 'Ana adds trail socks to her cart. The Cart API sends PUT with the new cart and the version context it read earlier, to any node; node A receives it.',
      text: ['The context (a vector clock) tells the store which version this write is based on. It is what lets the store tell "newer" apart from "concurrent".'],
      payloadKind: 'Request',
      payload: { op: 'PUT', key: 'cart:usr_ana', value: { items: [{ sku: 'SPG6-42-BLU', qty: 1 }, { sku: 'SOCK-TRL-M', qty: 2 }] }, context: { vclock: { B: 4 } }, consistency: { N: 3, W: 2, R: 2 } },
      fields: { context: 'The version Ana\'s session last read: B had written 4 updates.', consistency: 'N replicas, W acks needed for a write, R replies needed for a read. With strict quorums, R + W > N makes every read overlap the latest write\'s replicas. This store uses a sloppy quorum with hinted handoff (step 5): while an owner is down, an ack can come from a fallback node, so a read can miss the latest write until the hint is handed back (Dynamo §4.6).' },
      code: [{ lang: 'python', title: 'Cart API using the store client', src: String.raw`
@router.post("/v1/cart/items")
async def add_item(item: CartItem, user=Depends(current_user)):
    key = f"cart:{user.id}"
    got = await kv.get(key, r=2)                      # may return several siblings
    cart = merge_siblings([v.value for v in got.versions]) if got else Cart()
    cart.add(item.sku, item.qty)
    await kv.put(key, cart.model_dump(), context=got.context if got else None, w=2)
    return cart` }]
    },
    {
      from: 'coord', to: 'coord', label: 'hash → ring position',
      title: 'Find the key\'s replicas on the ring',
      caption: 'The key is hashed onto a ring of 2^128 positions. Walking clockwise from that point, the first three distinct physical nodes in different zones own it: B, C and D.',
      text: ['{{consistent hashing}} means adding a node moves only the keys in the ranges it takes over, about 1/24 of the data, instead of reshuffling everything.', 'Virtual nodes: each physical node appears at 256 random points on the ring, so load spreads evenly and a failed node\'s ranges are picked up by many others.'],
      payloadKind: 'Ring lookup',
      payload: { key: 'cart:usr_ana', md5: '7c9e1f0a…', ring_position: '0x7c9e1f0a…', walk: [{ vnode: 'B#118', zone: 'a' }, { vnode: 'B#201', note: 'same node, skip' }, { vnode: 'C#77', zone: 'b' }, { vnode: 'D#12', zone: 'c' }], preference_list: ['B', 'C', 'D'], fallbacks: ['E', 'F'] },
      fields: { preference_list: 'The N owners of this key. Fallbacks are used when an owner is down (sloppy quorum).' }
    },
    {
      from: 'coord', to: 'b', label: 'forward → B: v{B:5}',
      title: 'B coordinates the write to all three owners',
      caption: 'A is not one of the key\'s owners, so it forwards the write to B, the first owner, which coordinates it. B increments its own entry in the vector clock ({B:4} → {B:5}), stores the version locally and sends it to C and D in parallel. It needs 2 acknowledgements, its own included.',
      text: ['The vector clock entry belongs to the node that coordinates the write, not to whoever wrote last: B increments B\'s counter because B is coordinating (Dynamo §4.4–4.5).', 'Each replica appends to its commit log, updates its memtable, and acknowledges. Writing to an in-memory table plus an append-only log is what makes writes so fast (an LSM tree).'],
      payloadKind: 'Replica write',
      payload: { forwarded_by: 'A', coordinator: 'B', key: 'cart:usr_ana', vclock: { before: { B: 4 }, after: { B: 5 } }, targets: ['B', 'C', 'D'], acks_needed: 2, replies: { B: 'local write 1.1 ms', C: 'ack 1.4 ms', D: 'timeout (no answer)' } }
    },
    {
      from: 'c', to: 'b', label: 'ack 2/2 → success',
      title: 'Quorum reached with one node down',
      caption: 'B\'s own write and C\'s ack make W = 2, so B reports success and the API gets OK, through A, in about 2 ms. D did not answer: it is in the middle of a network problem.',
      text: ['A {{quorum}} write tolerates a minority of replicas failing. The API does not wait for D, so one sick node does not make writes slow.'],
      payloadKind: 'Response',
      payload: { status: 'OK', key: 'cart:usr_ana', vclock: { B: 5 }, acks: ['B', 'C'], latency_ms: 2.1 },
      failure: ['**Only one ack before the timeout:** the write returns an error to the API (it may still exist on one replica). The API retries; vector clocks make the retry safe.']
    },
    {
      from: 'b', to: 'e', label: 'hinted write for D',
      title: 'Hinted handoff: E keeps D\'s copy',
      caption: 'To keep three copies, B (the coordinator) writes D\'s copy to the next healthy node on the ring, E, with a hint saying "this belongs to D". E stores it separately.',
      text: ['{{hinted handoff}} with a {{sloppy quorum}} keeps writes durable on N machines even when an owner is down. The hint is not used for normal reads of E\'s own data.'],
      payloadKind: 'Hint',
      payload: { stored_on: 'E', intended_for: 'D', key: 'cart:usr_ana', vclock: { B: 5 }, hint_created: '2026-11-25T11:41:44Z', hint_ttl_hours: 3 }
    },
    {
      from: 'gossip', to: 'e', label: 'D is back',
      title: 'D returns; the hint is delivered',
      caption: 'Through gossip, every node learns that D is reachable again 4 minutes later. E sends D the hinted write and deletes the hint once D acknowledges.',
      text: ['Each node gossips with a few random peers every second, exchanging heartbeats and ring membership. News of a failure or recovery reaches all 24 nodes in a few seconds without a central coordinator.'],
      payloadKind: 'Gossip + handoff',
      payload: { gossip: { node: 'D', status: 'UP', heartbeat: 88123, seen_by: '24/24 within 3 s' }, handoff: { from: 'E', to: 'D', hints_sent: 1882, including: 'cart:usr_ana {B:5}', result: 'acked, hints deleted' } }
    },
    {
      from: 'api', to: 'coord', label: 'GET cart (R=2)',
      title: 'Concurrent writes from two devices',
      caption: 'Meanwhile Ana\'s phone, working from an older read ({B:4}), wrote "remove socks, add bottle" through node C. Both writes descend from {B:4} but not from each other: they are concurrent. Now a GET asks 2 replicas.',
      text: ['Last-write-wins by timestamp would keep one and silently drop the other: Ana would lose an item. {{vector clock}}s detect the concurrency so nothing is lost.'],
      payloadKind: 'Versions on replicas',
      payload: { key: 'cart:usr_ana', on_B: { vclock: { B: 5 }, items: ['SPG6 ×1', 'SOCK ×2'] }, on_C: [{ vclock: { B: 5 }, items: ['SPG6 ×1', 'SOCK ×2'] }, { vclock: { B: 4, C: 1 }, items: ['SPG6 ×1', 'BOTTLE ×1'] }], comparison: '{B:5} vs {B:4,C:1}: neither dominates → concurrent' }
    },
    {
      from: 'coord', to: 'api', label: '2 siblings + context', reply: true,
      title: 'The read returns both versions',
      caption: 'Node A coordinates this read: it gets replies from B and C and finds two versions that are concurrent. It returns both as siblings, with a combined context {B:5, C:1}, and lets the application merge.',
      text: ['For a cart, the merge is a union of items (with removals tracked so a deleted item does not come back). Amazon\'s Dynamo paper describes exactly this: a deleted item can occasionally reappear, which is better than losing an added one.'],
      payloadKind: 'Response',
      payload: { key: 'cart:usr_ana', siblings: [{ items: ['SPG6 ×1', 'SOCK ×2'] }, { items: ['SPG6 ×1', 'BOTTLE ×1'], removed: ['SOCK'] }], context: { B: 5, C: 1 } },
      code: [{ lang: 'python', title: 'Merging siblings (app side)', src: String.raw`
def merge_siblings(versions: list[dict]) -> Cart:
    adds: dict[str, int] = {}
    removed: set[str] = set()
    for v in versions:
        removed |= set(v.get("removed", []))
        for it in v["items"]:
            adds[it["sku"]] = max(adds.get(it["sku"], 0), it["qty"])
    return Cart(items=[{"sku": s, "qty": q} for s, q in adds.items() if s not in removed])
# -> SPG6 x1, BOTTLE x1   (the phone removed the socks after seeing them)` }]
    },
    {
      from: 'coord', to: 'b', label: 'merged write → B',
      title: 'Read repair fixes stale replicas',
      caption: 'The API writes back the merged cart with context {B:5, C:1}. A forwards it to B, which coordinates again and issues {B:6, C:1}; that dominates both siblings. Replicas replace their old versions, so the conflict disappears.',
      text: ['{{read repair}} also fixes simpler cases: if one replica returns an older version during a read, the coordinator writes the newest one back to it in the background.'],
      payloadKind: 'Repair write',
      payload: { key: 'cart:usr_ana', new_vclock: { B: 6, C: 1 }, items: ['SPG6 ×1', 'BOTTLE ×1'], replaced_on: ['B', 'C', 'D'] }
    },
    {
      from: 'ae', to: 'd', label: 'Merkle tree compare',
      title: 'Anti-entropy catches anything left over',
      caption: 'Hints can expire and nodes can lose disks. Every hour, replicas of each range compare Merkle trees: if the root hashes differ, they descend only into differing branches and exchange the few keys that differ.',
      text: ['A {{merkle tree}} of a range with a million keys lets two nodes find 12 differing keys by exchanging a few dozen hashes instead of a million values.'],
      payloadKind: 'Merkle sync',
      payload: { range: '0x7c00…–0x7d00…', pair: 'C ↔ D', root_match: false, levels_descended: 8, hashes_exchanged: 34, keys_differing: 12, repaired: 12, took_ms: 41 }
    }
  ],
  api: [
    { verb: 'GET', path: 'get(key, r=2) -> versions + context', desc: 'Returns one value or several concurrent siblings.' },
    { verb: 'PUT', path: 'put(key, value, context, w=2)', desc: 'Context from the last read; the store increments the vector clock.' },
    { verb: 'DEL', path: 'delete(key, context)', desc: 'Writes a tombstone so the delete replicates like any write.' }
  ],
  schemaLang: 'text',
  schemaNote: 'What each node stores (LSM tree per node).',
  schema: String.raw`
commit log      append-only, fsync batched every 10 ms
memtable        in-memory sorted map, flushed to an SSTable at 64 MB
SSTables        immutable sorted files + Bloom filter + index; compacted in the background
record          key -> [ (vclock, value | tombstone, write_ts) ... siblings ]
hints           separate store: (intended_node, key, vclock, value, expires_at)
merkle trees    one per owned range, rebuilt incrementally

ring            24 nodes x 256 vnodes, N=3 across zones, R=2, W=2`,
  decisions: [
    { q: 'How do you handle concurrent writes?', options: [
      { verdict: 'bad', name: 'Last write wins by wall-clock timestamp', why: 'Clock skew decides which cart survives; additions are silently lost.' },
      { verdict: 'good', name: 'Single leader per key range', why: 'No conflicts, but writes stop for a range while its leader fails over.' },
      { verdict: 'great', name: 'Vector clocks + siblings + app-level merge (for carts)', why: 'Always writable, and no update is lost.' }
    ] },
    { q: 'How many replicas must answer?', options: [
      { verdict: 'ok', name: 'W=1, R=1', why: 'Fastest, but reads can miss the latest write.' },
      { verdict: 'great', name: 'N=3, W=2, R=2', why: 'Survives one node down for reads and writes, and R + W > N gives overlapping quorums while all three owners are reachable; under a sloppy quorum that overlap is not guaranteed.' }
    ] }
  ],
  refs: [
    { label: 'DeCandia et al.: Dynamo: Amazon\'s Highly Available Key-value Store (2007)', url: 'https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf' },
    { label: 'Apache Cassandra: Dynamo architecture', url: 'https://cassandra.apache.org/doc/latest/cassandra/architecture/dynamo.html' }
  ],
  verify: {
    checked: ['The node that coordinates a write increments its own vector-clock entry, and a write for a key is coordinated by one of its first N owners: Dynamo paper §4.4–4.5 (step 3).', 'Sloppy quorum with hinted handoff, and why R + W > N then no longer guarantees overlap: Dynamo paper §4.6 (step 1, glossary).', 'The test suite checks that step 3 increments only the coordinator\'s entry.'],
    uncertain: ['The other steps have not been checked line by line against the sources yet. Latencies, node names and payload values are illustrative.']
  },
});
