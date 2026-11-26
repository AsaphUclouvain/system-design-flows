flow({
  id: 'file-sync',
  title: 'File sync service (Google Drive / Dropbox)',
  category: 'Product systems',
  tags: ['Block-level chunking', 'Content hashing / dedup', 'Metadata DB', 'Upload only changed blocks', 'Sync notifications', 'Conflict copies'],
  summary: 'You edit a 40 MB file on your laptop and it appears on your phone a few seconds later. The client splits the file into blocks, uploads only the blocks that changed, commits a new version in the metadata database, and every other device is told to pull the new block list. Follow an edit, the dedup shortcut, and a conflict when two devices edit offline.',
  requirements: {
    functional: ['Add, edit and delete files; changes show up on every device of the user.', 'Keep a version history.', 'Share a folder with other users.'],
    nonFunctional: ['Never lose data: a block is durable before the version that uses it is committed.', 'Save bandwidth: send only changed blocks.', 'A change reaches other online devices in a few seconds.']
  },
  estimates: ['Illustrative: 50 M users, 10 M daily active, 2 edits/day each ≈ 230 edits/s average.', '4 MB blocks: a one-line change in a 40 MB file re-sends one block, not ten.'],
  grid: { cols: 5, rows: 3 },
  nodes: [
    { id: 'laptop', label: 'Laptop client', sub: 'watcher + chunker', kind: 'client', icon: 'laptop', x: 0, y: 1, desc: 'Watches the sync folder, splits changed files into blocks, hashes them and uploads what the server does not have.' },
    { id: 'api', label: 'Sync API', sub: 'metadata service', kind: 'service', icon: 'server', x: 2, y: 1, desc: 'Answers "which blocks do you need?", commits new file versions and tells other devices.' },
    { id: 'block', label: 'Block service', sub: 'upload / download', kind: 'service', icon: 'box', x: 1, y: 0, desc: 'Receives block bytes, checks the hash matches, writes them to object storage.' },
    { id: 's3', label: 'Block storage', sub: 'object store, by hash', kind: 'storage', icon: 'storage', x: 2, y: 0, desc: 'Immutable blocks keyed by their SHA-256. Two users with the same block store it once.' },
    { id: 'meta', label: 'Metadata DB', sub: 'files, versions, blocks', kind: 'db', icon: 'db', x: 3, y: 1, desc: 'Strongly consistent (relational). file_id → version → ordered list of block hashes.' },
    { id: 'notify', label: 'Notification service', sub: 'long poll / websocket', kind: 'service', icon: 'bell', x: 3, y: 2, desc: 'Holds an open connection per online device and pushes "namespace changed, cursor 812".' },
    { id: 'phone', label: 'Phone client', sub: 'same account', kind: 'client', icon: 'phone', x: 4, y: 1, desc: 'Gets the change signal, asks for the new block list and downloads only the blocks it lacks.' }
  ],
  pseudo: `
# client
blocks = split(file, 4*MB); hashes = [sha256(b) for b in blocks]
need = api.commit_request(file_id, base_rev=7, hashes)
for h in need.missing: block_service.put(h, blocks[h])
res = api.commit(file_id, base_rev=7, hashes)
if res.conflict: save_as("report (laptop's conflicted copy).docx")
# server
def commit(file_id, base_rev, hashes):
    if any(not s3.exists(h) for h in hashes): return {missing: ...}
    with tx: if meta.rev(file_id) != base_rev: return CONFLICT
             meta.insert_version(file_id, base_rev+1, hashes)
    notify.publish(namespace, cursor+1)
# other device
on_signal: changes = api.list_changes(cursor); download(missing_blocks)`,
  steps: [
    {
      from: 'laptop', to: 'laptop', label: 'report.docx → 10 blocks, 1 changed', pc: ['blocks = split'],
      title: 'The client notices an edit and chunks the file',
      caption: 'A file watcher sees report.docx change. The client splits it into 4 MB blocks and hashes each one. Only block 3 has a new hash.',
      text: ['Fixed-size blocks are the simple version. Content-defined chunking (cut where a rolling hash hits a pattern) keeps boundaries stable when bytes are inserted at the start of a file.'],
      payloadKind: 'Local block list',
      payload: { file: 'report.docx', size_mb: 38.2, block_size_mb: 4, hashes: ['a91f…', '0c3e…', '77d2… (new)', '…'], base_rev: 7 }
    },
    {
      from: 'laptop', to: 'api', label: 'POST /commit_request {base_rev 7, 10 hashes}', pc: ['need = api.commit_request'],
      title: 'Ask which blocks the server is missing',
      caption: 'The client sends the full new block list. The server answers with the hashes it does not have yet: just 77d2….',
      text: [],
      payloadKind: 'Request / response',
      payload: { request: { file_id: 'f_5521', base_rev: 7, hashes: 10 }, response: { missing: ['77d2…'] } },
      branch: { q: 'Is any block missing?', options: [ { label: 'yes: upload it', goto: 'up' }, { label: 'no: dedup, commit directly', goto: 'dedup' } ] }
    },
    {
      id: 'up', from: 'laptop', to: 'block', label: 'PUT /block/77d2… (4 MB, gzip)', pc: ['block_service.put'],
      title: 'Upload only the changed block',
      caption: 'One 4 MB block goes up instead of 38 MB. The block service recomputes the hash; if it does not match, the upload is rejected.',
      text: [],
      payloadKind: 'Block upload',
      payload: { hash: '77d2…', bytes: 4194304, compressed: 1310720, verified: true }
    },
    {
      from: 'block', to: 's3', label: 'put blocks/77/d2… (immutable)', pc: ['block_service.put'],
      title: 'Store the block by its hash',
      caption: 'The key is the hash, so the same bytes are never stored twice and a block never changes after it is written.',
      text: [],
      payloadKind: 'Object write',
      payload: { bucket: 'blocks', key: 'blocks/77/d2…', storage_class: 'standard', replicas: 3 }
    },
    {
      id: 'dedup', path: 'dedup', from: 'api', to: 's3', label: 'all 10 hashes already exist', pc: ['if any(not s3.exists(h)'],
      title: 'Other outcome: nothing to upload',
      caption: 'You copy a 2 GB video someone already uploaded (or you renamed a file). Every hash already exists, so the commit is instant and zero bytes move.',
      text: [],
      payloadKind: 'Existence check',
      payload: { hashes_checked: 512, missing: 0, bytes_uploaded: 0 }
    },
    {
      from: 'api', to: 'meta', label: 'BEGIN; rev 7 → 8; COMMIT', pc: ['if meta.rev(file_id) != base_rev', 'meta.insert_version'],
      title: 'Commit the new version',
      caption: 'Inside one transaction the server checks the file is still at rev 7, then writes rev 8 with the new block list. Blocks first, metadata second: a version never points at a missing block.',
      text: [],
      payloadKind: 'Version row',
      payload: { file_id: 'f_5521', rev: 8, parent_rev: 7, blocks: ['a91f…', '0c3e…', '77d2…', '…'], modified_by: 'laptop', ts: '2026-11-26T15:02:11Z' },
      branch: { q: 'Is the file still at rev 7?', options: [ { label: 'yes: commit rev 8', goto: 'push' }, { label: 'no: another device won', goto: 'conflict' } ] }
    },
    {
      id: 'conflict', path: 'conflict', from: 'api', to: 'laptop', reply: true, label: '409 conflict: current rev is 8 (from phone)', pc: ['return CONFLICT', 'save_as'],
      title: 'Other outcome: both devices edited offline',
      caption: 'The phone already committed rev 8 while the laptop was on a plane. The server refuses rev 7 → 8 from the laptop; the laptop keeps its edit as a separate "conflicted copy" file so nothing is lost.',
      text: ['Dropbox describes exactly this behaviour: it creates a conflicted copy rather than trying to merge arbitrary binary files.'],
      payloadKind: 'Conflict',
      payload: { status: 409, current_rev: 8, your_base: 7, action: "save as report (laptop's conflicted copy 2026-11-26).docx" },
      next: 'end'
    },
    {
      id: 'push', from: 'api', to: 'notify', label: 'namespace ns_88 changed, cursor 812', pc: ['notify.publish'],
      title: 'Tell the other devices',
      caption: 'The commit bumps the namespace cursor. The notification service pushes a tiny signal to every connected device of the user (and of people the folder is shared with).',
      text: [],
      payloadKind: 'Signal',
      payload: { namespace: 'ns_88', cursor: 812 }
    },
    {
      id: 'end', from: 'notify', to: 'phone', label: 'changed → list_changes(811) → GET 77d2…', pc: ['on_signal'],
      title: 'The phone pulls the change',
      caption: 'The signal carries no file data. The phone asks for changes since its cursor, sees the new block list, and downloads only block 77d2…. Offline devices catch up the same way when they reconnect.',
      text: [],
      payloadKind: 'Change list',
      payload: { since: 811, changes: [{ file_id: 'f_5521', rev: 8, blocks_to_fetch: ['77d2…'] }], cursor: 812 }
    }
  ],
  decisions: [
    { q: 'Where does metadata live?', options: [
      { name: 'Relational DB (sharded by user/namespace)', verdict: 'good', why: 'Versions and folder moves need transactions and strong consistency.' },
      { name: 'Eventually consistent NoSQL', verdict: 'bad', why: 'Two devices can see different "latest" versions; conflicts become silent overwrites.' } ] },
    { q: 'How do clients learn about changes?', options: [
      { name: 'Long poll / websocket signal + pull', verdict: 'good', why: 'Seconds of delay, tiny messages, works for offline catch-up via cursor.' },
      { name: 'Clients poll every few seconds', verdict: 'bad', why: 'Huge wasted load for millions of idle devices.' } ] }
  ],
  refs: [
    { label: 'Dropbox Tech: Streaming file synchronization', url: 'https://dropbox.tech/infrastructure/streaming-file-synchronization' },
    { label: 'Dropbox Tech: Rewriting the heart of our sync engine', url: 'https://dropbox.tech/infrastructure/rewriting-the-heart-of-our-sync-engine' },
    { label: 'Dropbox Help: Conflicted copies', url: 'https://help.dropbox.com/organize/conflicted-copy' },
    { label: 'ByteByteGo: System Design Interview Vol. 1, chapter "Design Google Drive" (book)', url: 'https://bytebytego.com/courses/system-design-interview/design-google-drive' }
  ],
  verify: {
    checked: ['4 MB blocks, hashing, uploading only blocks the server lacks, and a separate notification channel: Dropbox Tech sync posts.', 'Conflicted copies instead of merges: Dropbox Help.'],
    uncertain: ['User counts, edit rates, cursor numbers and timings are illustrative.', 'The commit API is a simplified model, not Dropbox\'s or Google\'s real API.']
  }
});
