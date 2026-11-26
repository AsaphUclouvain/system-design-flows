flow({
  id: 'storage-engines',
  title: 'Inside a database write: B-tree vs LSM-tree storage engines',
  category: 'Databases & replication',
  tags: ['Write-ahead log', 'B-tree pages', 'Memtable', 'SSTables', 'Compaction', 'Bloom filters'],
  summary: 'Two families of storage engines sit under almost every database. PostgreSQL and InnoDB update sorted pages in place (B-trees); RocksDB, Cassandra and LevelDB append to a memtable and merge sorted files later (LSM-trees). Follow one write and one read through each path, and see where each pays its cost.',
  requirements: {
    functional: ['Durably store key → value and find it again.', 'Support range scans in key order.'],
    nonFunctional: ['Survive a crash at any instant (write-ahead log).', 'Choose between read-optimised (B-tree) and write-optimised (LSM) behaviour.']
  },
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'q', label: 'Query executor', sub: 'PUT / GET', kind: 'client', icon: 'api', x: 0, y: 1, desc: 'Receives a write or read for one key from the SQL layer or API.' },
    { id: 'wal', label: 'Write-ahead log', sub: 'append-only file', kind: 'queue', icon: 'log', x: 1, y: 0, desc: 'Every change is appended and flushed here first, so it can be replayed after a crash. Both engine types use one.' },
    { id: 'bt', label: 'B-tree', sub: '8 KB pages: root → leaf', kind: 'db', icon: 'tree', x: 2, y: 0, desc: 'A balanced tree of fixed-size pages. Finding a key reads one page per level (3–4 levels for millions of rows). Writes modify the leaf page in place.' },
    { id: 'mem', label: 'Memtable', sub: 'sorted, in memory', kind: 'cache', icon: 'cache', x: 1, y: 2, desc: 'LSM engines insert writes into an in-memory sorted structure (a skip list in RocksDB). Fast: no disk seek per write.' },
    { id: 'sst', label: 'SSTables L0…Ln', sub: 'immutable sorted files', kind: 'db', icon: 'db', x: 3, y: 2, desc: 'When the memtable fills, it is written out as a sorted, immutable file. Background compaction merges files and drops overwritten or deleted values.' },
    { id: 'bloom', label: 'Bloom filters', sub: 'one per file', kind: 'cache', icon: 'filter', x: 2, y: 2, desc: 'A compact bit set that answers "definitely not in this file" or "maybe". Lets reads skip most SSTables.' }
  ],
  pseudo: `
def put(key, value):
    wal.append(key, value); wal.fsync()        # durability first
    if ENGINE == "btree":
        leaf = btree.descend(key)              # root -> inner -> leaf
        leaf.insert(key, value)                # in place; split if full
    else:  # LSM
        memtable.insert(key, value)
        if memtable.full(): flush_to_sstable(memtable)  # sorted, immutable

def get(key):
    if ENGINE == "btree": return btree.descend(key).find(key)
    if v := memtable.get(key): return v
    for f in sstables_newest_first():
        if f.bloom.might_contain(key) and (v := f.find(key)): return v
    return None`,
  steps: [
    {
      from: 'q', to: 'wal', label: 'append PUT user:8812 → fsync', pc: ['def put', 'wal.append'],
      title: 'Every engine logs the write first',
      caption: 'The executor gets PUT user:8812 = {plan: "pro"}. Before touching any data structure, the change is appended to the write-ahead log and flushed to disk.',
      text: ['Appending is sequential and fast. If the machine crashes a moment later, replaying the log rebuilds the change. This is the same WAL that replication streams (see the primary–replica flow).'],
      payloadKind: 'WAL record',
      payload: { lsn: 88231, op: 'PUT', key: 'user:8812', value: { plan: 'pro' }, fsync: true },
      branch: { q: 'Which storage engine is underneath?', options: [ { label: 'B-tree (PostgreSQL, InnoDB)', goto: 'btw' }, { label: 'LSM-tree (RocksDB, Cassandra)', goto: 'lsmw' } ] }
    },
    {
      id: 'btw', path: 'B-tree', from: 'q', to: 'bt', label: 'descend root → inner → leaf #4471', pc: ['btree.descend', 'leaf.insert'],
      title: 'B-tree: find the leaf page and update it in place',
      caption: 'The engine walks from the root page down to the leaf that covers user:8812 (3 page reads, usually cached) and writes the new value into that page.',
      text: ['If the leaf is full, it splits into two and the parent gets a new pointer. The modified page is written back to disk later by a checkpoint; the WAL covers the gap. Cost: random page writes, and a whole 8 KB page rewritten for a small change.'],
      payloadKind: 'Page access',
      payload: { path: ['root p1', 'inner p212', 'leaf p4471'], leaf_fill: '71%', split: false, dirty_page: 'p4471 (flushed at next checkpoint)' }
    },
    {
      path: 'B-tree', from: 'bt', to: 'q', reply: true, label: 'GET: 3 page reads → value', pc: ['return btree.descend(key).find'],
      title: 'B-tree read: one path, one place',
      caption: 'A later GET walks the same three pages and finds exactly one copy of the key. Read cost is predictable: one page per tree level.',
      text: ['ByteByteGo\'s comparison in one line: B-trees keep data sorted on disk so reads are fast but pay on every write; LSM-trees buffer writes in memory and flush in bulk, making writes cheap and reads more expensive. Range scans work in both because keys are stored in order.'],
      payloadKind: 'Read',
      payload: { key: 'user:8812', pages_read: 3, copies_of_key: 1, value: { plan: 'pro' } },
      end: true
    },
    {
      id: 'lsmw', path: 'LSM', from: 'q', to: 'mem', label: 'insert into memtable (skip list)', pc: ['memtable.insert'],
      title: 'LSM: just insert into the in-memory memtable',
      caption: 'No page is read or rewritten. The write lands in a sorted in-memory structure and is done: the WAL already made it durable.',
      text: ['This is why LSM engines accept very high write rates: every disk write is sequential (log appends and whole-file flushes).'],
      payloadKind: 'Memtable',
      payload: { key: 'user:8812', value: { plan: 'pro' }, memtable_size_mb: 63.8, limit_mb: 64 }
    },
    {
      path: 'LSM', from: 'mem', to: 'sst', async: true, label: 'full → flush as L0 SSTable #9132', pc: ['flush_to_sstable'],
      title: 'Memtable full: flush to an immutable sorted file',
      caption: 'The memtable reaches 64 MB. It becomes read-only, a new one takes writes, and the old one is written out in key order as a new SSTable. Its WAL segment can then be deleted.',
      text: ['Files are never modified. An update writes a newer version of the key in a newer file; a delete writes a tombstone. Compaction later merges files, keeps the newest version and drops the rest.'],
      payloadKind: 'Flush',
      payload: { new_file: 'L0/009132.sst', keys: 412000, sorted: true, bloom_filter: '10 bits/key', wal_segment_deleted: true }
    },
    {
      path: 'LSM', from: 'q', to: 'bloom', label: 'GET user:5190: memtable miss → check blooms', pc: ['def get', 'memtable.get', 'bloom.might_contain'],
      title: 'LSM read: newest first, skip files with Bloom filters',
      caption: 'A read checks the memtable, then SSTables from newest to oldest. Bloom filters say "definitely not here" for most files, so only one or two are actually read.',
      text: ['Without compaction the number of files grows and reads slow down; with it, the same data is rewritten several times (write amplification). Tuning compaction is the main LSM trade-off.'],
      payloadKind: 'Read path',
      payload: { memtable: 'miss', files_checked: 7, bloom_says_maybe: 1, files_read: 1, found_in: 'L2/007004.sst' }
    },
    {
      path: 'LSM', from: 'sst', to: 'sst', async: true, label: 'compaction: merge L0 + L1, drop old versions', pc: ['flush_to_sstable'],
      title: 'Compaction keeps reads fast',
      caption: 'In the background, overlapping files are merge-sorted into the next level. Old versions and tombstoned keys disappear, and each level holds fewer, larger, non-overlapping files.',
      text: ['RocksDB, LevelDB and Cassandra all work this way, with different compaction strategies (levelled, tiered, time-window).'],
      payloadKind: 'Compaction job',
      payload: { inputs: ['L0/009131.sst', 'L0/009132.sst', 'L1/008870.sst'], output: ['L1/009140.sst', 'L1/009141.sst'], versions_dropped: 58210, tombstones_purged: 1204 }
    }
  ],
  decisions: [
    { q: 'Which engine for which workload?', options: [
      { name: 'B-tree', verdict: 'good', why: 'Read-heavy OLTP with predictable lookups and in-place updates: PostgreSQL, MySQL InnoDB.' },
      { name: 'LSM-tree', verdict: 'good', why: 'Write-heavy, append-like data (events, time series, messages): RocksDB, Cassandra, ScyllaDB. Reads rely on Bloom filters and compaction.' } ] }
  ],
  refs: [
    { label: 'ByteByteGo newsletter: B-trees vs LSM-trees comparison', url: 'https://blog.bytebytego.com/p/b-trees-vs-lsm-trees-comparison-and', note: 'subscriber post; the free intro states the trade-off.' },
    { label: 'RocksDB wiki: overview (memtable, logfile, sstfile, compaction)', url: 'https://github.com/facebook/rocksdb/wiki/RocksDB-Overview' },
    { label: 'PostgreSQL docs: B-tree indexes', url: 'https://www.postgresql.org/docs/current/btree.html' },
    { label: 'ByteByteGo, System Design Interview Vol. 1: Design a key-value store (write and read paths)', url: 'https://bytebytego.com/courses/system-design-interview/design-a-key-value-store' }
  ],
  verify: {
    checked: ['Memtable → logfile → flush to sorted sstfile, compaction: RocksDB overview.', 'Write path (commit log, memory cache, SSTables) and read path with Bloom filters: ByteByteGo key-value store chapter.'],
    uncertain: ['Page numbers, sizes and file names are illustrative; 64 MB is RocksDB\'s common default write buffer size but configurations vary.']
  }
});
