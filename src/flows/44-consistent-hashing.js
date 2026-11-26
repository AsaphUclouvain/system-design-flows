flow({
  id: 'consistent-hashing',
  title: 'Consistent hashing: adding a cache server without a reshuffle',
  category: 'Databases & replication',
  tags: ['Hash ring', 'Clockwise lookup', 'Virtual nodes', 'Minimal key movement', 'hash mod N problem'],
  summary: 'With hash(key) mod N, adding a fifth cache server remaps about 80% of keys and the database gets flooded. Consistent hashing places servers and keys on the same ring so a new server only takes keys from its neighbours. Follow a lookup, the scale-out, and the virtual nodes that keep load even.',
  requirements: {
    functional: ['Map each key to a cache server.', 'Add or remove servers while running.'],
    nonFunctional: ['Only about k/n keys move when a server joins or leaves (k keys, n servers).', 'Load spread evenly even with few servers.']
  },
  estimates: [
    { label: 'Keys moved with mod N, 4 → 5', value: '≈ 80%', note: 'A key stays only if hash mod 4 = hash mod 5: one key in five.' },
    { label: 'Keys moved with a ring, 4 → 5', value: '≈ 20%', note: 'Only the keys in the new server\'s ranges, about 1/5 of all keys.' }
  ],
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'app', label: 'Web server', sub: 'cache client', kind: 'client', icon: 'server', x: 0, y: 1, desc: 'Needs the cached value for a key and must know which cache server holds it.' },
    { id: 'ring', label: 'Hash ring', sub: '0 … 2³²−1', kind: 'cache', icon: 'ring', x: 1, y: 1, desc: 'Keys and servers hashed into the same space, joined end to end. A key belongs to the first server clockwise from it.' },
    { id: 's1', label: 'cache-1', sub: '3 virtual nodes', kind: 'cache', icon: 'cache', x: 2, y: 0, desc: 'Owns the ring ranges ending at its virtual nodes.' },
    { id: 's2', label: 'cache-2', sub: '3 virtual nodes', kind: 'cache', icon: 'cache', x: 3, y: 0, desc: 'Another cache server.' },
    { id: 's4', label: 'cache-4', sub: '3 virtual nodes', kind: 'cache', icon: 'cache', x: 3, y: 2, desc: 'Another cache server.' },
    { id: 's5', label: 'cache-5 (new)', sub: 'joins at 14:00', kind: 'cache', icon: 'cache', x: 2, y: 2, desc: 'Added during a traffic spike. Takes over some ranges from its clockwise neighbours only.' },
    { id: 'db', label: 'Database', sub: 'source of truth', kind: 'db', icon: 'db', x: 1, y: 2, desc: 'Every cache miss lands here. A mass remap would turn into a wave of misses.' }
  ],
  pseudo: `
ring = SortedMap()                               # position -> server
def add_server(s, vnodes=3):
    for i in range(vnodes):
        ring[hash(f"{s}#{i}")] = s              # many points per server

def server_for(key):
    h = hash(key)
    pos = ring.ceiling(h) or ring.first()       # first point clockwise, wrap
    return ring[pos]

def get(key):
    s = server_for(key)
    if (v := s.get(key)) is not None: return v
    v = db.load(key); s.set(key, v); return v   # miss: fill from DB`,
  steps: [
    {
      from: 's4', to: 'ring', label: 'cache-1#0..#2, cache-2#0..#2, cache-4#0..#2', pc: ['def add_server', 'ring[hash'],
      title: 'Servers are hashed onto the ring',
      caption: 'At startup every cache server is hashed three times (cache-1#0, cache-1#1, \u2026) onto a ring of 2\u00b3\u00b2 positions. Four servers give 12 points; cache-4 is shown, cache-3 is omitted from the drawing.',
      text: ['Each server owns the arcs that end at its points. Many points per server (virtual nodes) make the arcs small and evenly mixed, so no server gets one huge range.'],
      payloadKind: 'Ring',
      payload: { points: 12, sample: [{ pos: 412000000, server: 'cache-1#2' }, { pos: 2701100000, server: 'cache-4#2' }, { pos: 3020551000, server: 'cache-2#1' }] }
    },
    {
      from: 'app', to: 'ring', label: 'hash("user:8812") = 2,914,031,442', pc: ['def server_for', 'h = hash(key)'],
      title: 'Hash the key onto the ring',
      caption: 'The web server needs user:8812\'s profile. It hashes the key into the same 32-bit space the servers were hashed into.',
      text: ['The ring is just a sorted list of server positions; "clockwise" means "the next larger position, wrapping around to the smallest".'],
      payloadKind: 'Lookup',
      payload: { key: 'user:8812', hash: 2914031442, ring_size: '2^32' }
    },
    {
      from: 'ring', to: 's2', label: 'next point clockwise: cache-2#1', pc: ['ring.ceiling', 'return ring[pos]'],
      title: 'Walk clockwise to the first server',
      caption: 'The first server point after 2,914,031,442 is cache-2#1 at 3,020,551,000, so cache-2 owns this key.',
      text: ['With 4 servers and 3 virtual nodes each, the ring has 12 points. Each server owns 3 small arcs spread around the ring instead of one big arc.'],
      payloadKind: 'Ring segment',
      payload: { points_near: [{ pos: 2701100000, server: 'cache-4#2' }, { pos: 3020551000, server: 'cache-2#1' }], owner: 'cache-2' }
    },
    {
      from: 'app', to: 's2', label: 'GET user:8812 → hit', pc: ['def get', 's.get(key)'],
      title: 'Read from the owning cache',
      caption: 'cache-2 has the profile. Every web server computes the same ring, so they all agree on the owner without asking anyone.',
      text: [],
      payloadKind: 'Cache hit',
      payload: { server: 'cache-2', key: 'user:8812', value: { name: 'Ana', plan: 'pro' }, ms: 0.4 }
    },
    {
      from: 's5', to: 'ring', label: 'add cache-5#0..#2', pc: ['def add_server', 'ring[hash'],
      title: '14:00 — a fifth server joins',
      caption: 'Traffic spikes and cache-5 is added. Its three virtual nodes land at three spots on the ring. Each takes over only the arc between it and the previous point counter-clockwise.',
      text: ['With hash mod N, changing N from 4 to 5 would send about 80% of keys to a different server at once. ByteByteGo calls this the rehashing problem: a storm of cache misses on the database.'],
      payloadKind: 'Ring change',
      payload: { added: [{ pos: 2850000000, server: 'cache-5#0' }, { pos: 1120400000, server: 'cache-5#1' }, { pos: 410700000, server: 'cache-5#2' }], keys_moving: '≈ 1/5 of all keys', from_servers: ['cache-2', 'cache-1', 'cache-4'] },
      branch: { q: 'Does user:8812 fall in one of cache-5\'s new arcs?', options: [ { label: 'yes: it moved', goto: 'moved' }, { label: 'no: unaffected', goto: 'stay' } ] }
    },
    {
      id: 'moved', path: 'key moved', from: 'ring', to: 's5', label: 'user:5190 @2.80e9 → cache-5#0', pc: ['ring.ceiling'],
      title: 'Keys in the new arc now belong to cache-5',
      caption: 'Take user:5190 at 2,801,000,000: the next point clockwise is now cache-5#0 at 2,850,000,000, not cache-2#1. That key moved from cache-2 to cache-5.',
      text: ['user:8812 at 2,914,031,442 is past cache-5#0, so it still goes to cache-2. Only keys between cache-4#2 and cache-5#0 changed owner.'],
      payloadKind: 'Owner change',
      payload: { key: 'user:5190', hash: 2801000000, before: 'cache-2', after: 'cache-5' }
    },
    {
      path: 'key moved', from: 's1', to: 's5', async: true, label: 'arc just before cache-1#2 → cache-5', pc: ['ring.ceiling'],
      title: 'Each neighbour gives up one small arc',
      caption: 'cache-5#2 at 410,700,000 lands just before cache-1#2, so keys in that thin arc move from cache-1 to cache-5. The same happens next to cache-2 and cache-4. Each existing server loses a little; none loses much.',
      text: ['Nothing is copied ahead of time in a plain cache: the moved keys simply miss once on cache-5. A database built on a ring (Cassandra, Dynamo) streams the moved ranges to the new node before it serves them.'],
      payloadKind: 'Ownership change',
      payload: { 'cache-1': '-1 thin arc', 'cache-2': '-1 thin arc', 'cache-4': '-1 thin arc', 'cache-5': '+3 arcs (≈1/5 of keys)' }
    },
    {
      path: 'key moved', from: 'app', to: 'db', label: 'miss on cache-5 → SELECT user 5190', pc: ['db.load(key)'],
      title: 'One miss, then cached again',
      caption: 'cache-5 starts empty, so the first read of user:5190 misses and loads from the database. Only about a fifth of keys do this, spread over time, which the database absorbs.',
      text: ['Some systems pre-warm the new server or copy its ranges first. A distributed cache usually just accepts the brief misses.'],
      payloadKind: 'Miss + fill',
      payload: { server: 'cache-5', key: 'user:5190', db_query: 'SELECT * FROM users WHERE id = 5190', then: 'SET user:5190 ttl=3600' },
      end: true
    },
    {
      id: 'stay', path: 'unaffected', from: 'app', to: 's2', label: 'user:8812 still → cache-2 (hit)', pc: ['def get'],
      title: 'Most keys keep their server',
      caption: 'user:8812 is not in any of cache-5\'s arcs, so it still maps to cache-2 and still hits. About 4 in 5 keys are like this.',
      text: ['Virtual nodes matter here: with one point per server, cache-5 would take one big arc from a single neighbour. With many points it takes small arcs from several, so load and moved keys are spread. ByteByteGo notes real systems use far more virtual nodes than 3.'],
      payloadKind: 'Cache hit',
      payload: { key: 'user:8812', owner_before: 'cache-2', owner_after: 'cache-2', hit: true }
    }
  ],
  refs: [
    { label: 'ByteByteGo, System Design Interview Vol. 1: Design consistent hashing', url: 'https://bytebytego.com/courses/system-design-interview/design-consistent-hashing', note: 'rehashing problem, ring, virtual nodes.' },
    { label: 'Apache Cassandra docs: consistent hashing using a token ring, vnodes', url: 'https://cassandra.apache.org/doc/latest/cassandra/architecture/dynamo.html' },
    { label: 'Amazon Dynamo paper (SOSP 2007)', url: 'https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf' }
  ],
  verify: {
    checked: ['Rehashing problem with mod N, clockwise lookup, k/n keys remapped, virtual nodes: ByteByteGo chapter.', 'Tokens and vnodes in practice: Cassandra docs.'],
    uncertain: ['Ring positions are made up for the example. The 80% / 20% figures assume uniform hashing.']
  }
});
