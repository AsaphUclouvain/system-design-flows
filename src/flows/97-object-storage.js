flow({
  id: 'object-storage',
  title: 'S3-like object storage',
  category: 'Data at scale',
  tags: ['Buckets and keys', 'Metadata vs data path', 'Erasure coding 8+4', 'Placement across zones', 'Strong read-after-write', 'Multipart upload'],
  summary: 'Object storage keeps trillions of immutable blobs. A PUT goes through an API layer that authenticates, a placement service picks storage nodes in different zones, the data is split into erasure-coded fragments, and only then is the key recorded in the metadata store. Follow an upload, a GET while a disk is dead, and a multipart upload.',
  requirements: {
    functional: ['PUT / GET / DELETE objects by bucket + key.', 'List keys by prefix.', 'Multipart upload for large files.'],
    nonFunctional: ['Very high durability (designed for 11 nines at AWS).', 'A GET right after a successful PUT returns the new object.', 'Cost per GB as low as possible.']
  },
  estimates: ['Erasure coding 8 data + 4 parity fragments: 1.5× storage overhead and survives any 4 lost fragments. Three full copies cost 3× and survive 2.'],
  grid: { cols: 5, rows: 3 },
  nodes: [
    { id: 'cli', label: 'Client', sub: 'SDK', kind: 'client', icon: 'laptop', x: 0, y: 1, desc: 'Signs requests with its access key (SigV4-style).' },
    { id: 'api', label: 'API service', sub: 'auth + routing', kind: 'service', icon: 'server', x: 1, y: 1, desc: 'Checks signature and bucket policy, then coordinates the write or read.' },
    { id: 'place', label: 'Placement service', sub: 'cluster map', kind: 'service', icon: 'split', x: 2, y: 0, desc: 'Knows every storage node, its zone and free space; picks 12 nodes for the fragments.' },
    { id: 'ec', label: 'Data service', sub: 'erasure coder', kind: 'worker', icon: 'cpu', x: 2, y: 1, desc: 'Splits the object into 8 data fragments, computes 4 parity fragments, writes all 12.' },
    { id: 'nodes', label: 'Storage nodes', sub: '3 zones', kind: 'storage', icon: 'storage', x: 3, y: 1, desc: 'Disks that store fragments in large append-only files.' },
    { id: 'meta', label: 'Metadata store', sub: 'bucket/key → fragments', kind: 'db', icon: 'db', x: 2, y: 2, desc: 'Strongly consistent map from (bucket, key, version) to fragment locations, size, ETag.' },
    { id: 'repair', label: 'Repair service', sub: 'background', kind: 'worker', icon: 'tool', x: 4, y: 1, desc: 'Finds missing fragments (dead disks) and rebuilds them elsewhere from the survivors.' }
  ],
  pseudo: `
PUT /madgate-pages/static-bloom/050/01.webp  (auth: SigV4)
nodes = placement.pick(12, spread_across=3 zones)
frags = reed_solomon.encode(object, k=8, m=4)
write frags[i] -> nodes[i] in parallel; wait for all 12 (or quorum + repair)
meta.put(bucket, key, version, frag_locations, etag)   # commit point
return 200 ETag
GET: locs = meta.get(bucket, key); read any 8 of 12; decode
background: if fragment missing: rebuild from 8 survivors`,
  steps: [
    {
      from: 'cli', to: 'api', label: 'PUT /madgate-pages/static-bloom/050/01.webp', pc: ['PUT /madgate-pages'],
      title: 'An object is uploaded',
      caption: 'The key looks like a path, but it is just a string: there are no real folders. The API checks the signature and the bucket policy.',
      text: [],
      payloadKind: 'PUT',
      payload: { bucket: 'madgate-pages', key: 'static-bloom/050/01.webp', bytes: 412000, content_type: 'image/webp', auth: 'AWS4-HMAC-SHA256 Credential=AKIA…' }
    },
    {
      from: 'api', to: 'place', label: 'pick 12 nodes across 3 zones', pc: ['nodes = placement.pick'],
      title: 'Choose where the fragments go',
      caption: 'Four fragments per zone: losing a whole zone (4 fragments) still leaves 8, enough to read the object.',
      text: [],
      payloadKind: 'Placement',
      payload: { zone_a: ['n12', 'n31', 'n44', 'n58'], zone_b: ['n103', 'n118', 'n121', 'n150'], zone_c: ['n207', 'n219', 'n233', 'n240'] }
    },
    {
      from: 'api', to: 'ec', label: 'encode 412 KB → 8 + 4 fragments', pc: ['frags = reed_solomon.encode'],
      title: 'Erasure-code the data',
      caption: 'Reed–Solomon coding splits the object into 8 pieces and computes 4 parity pieces. Any 8 of the 12 are enough to rebuild it.',
      text: ['Backblaze describes the same idea with 17 data + 3 parity shards in its Vaults.'],
      payloadKind: 'Fragments',
      payload: { k: 8, m: 4, fragment_bytes: 51500, overhead: '1.5×' }
    },
    {
      from: 'ec', to: 'nodes', label: 'write 12 fragments in parallel', pc: ['write frags[i]'],
      title: 'Write the fragments',
      caption: 'Each node appends its fragment to a large file and fsyncs. Small objects are packed together so the disk does not hold billions of tiny files.',
      text: [],
      payloadKind: 'Writes',
      payload: { acked: 12, slowest_ms: 18 }
    },
    {
      from: 'api', to: 'meta', label: 'commit key → fragment list (version v3)', pc: ['meta.put'],
      title: 'Commit the metadata last',
      caption: 'Only after the data is safe is the key written. That metadata write is the moment the object exists; a crash before it leaves orphan fragments that garbage collection removes.',
      text: ['Amazon S3 gives strong read-after-write consistency: after a successful write, overwrite or delete, any later read gets the latest version, and listings reflect it too.'],
      payloadKind: 'Metadata row',
      payload: { bucket: 'madgate-pages', key: 'static-bloom/050/01.webp', version: 'v3', size: 412000, etag: '"9b2cf535f27731c974343645a3985328"', fragments: 12 }
    },
    {
      from: 'api', to: 'cli', reply: true, label: '200 OK, ETag "9b2c…"', pc: ['return 200 ETag'],
      title: 'Success, and immediately readable',
      caption: 'A GET from anywhere right now returns this version.',
      text: [],
      payloadKind: 'Response',
      payload: { status: 200, ETag: '"9b2cf535f27731c974343645a3985328"' },
      branch: { q: 'What can happen next?', options: [ { label: 'a disk with a fragment dies', goto: 'dead' }, { label: 'a 3.2 GB file is uploaded', goto: 'multi' } ] }
    },
    {
      id: 'dead', path: 'dead', from: 'nodes', to: 'repair', label: 'n118 disk failed → rebuild fragment 6', pc: ['GET: locs = meta.get', 'background: if fragment missing'],
      title: 'Other outcome: a dead disk',
      caption: 'A GET still works: it reads any 8 of the 11 remaining fragments and decodes. In the background the repair service rebuilds fragment 6 on a new node so the object is back to full protection.',
      text: [],
      payloadKind: 'Repair',
      payload: { failed_node: 'n118', fragment: 6, rebuilt_on: 'n162', read_latency_ms: 31, durability_restored: true },
      next: 'end'
    },
    {
      id: 'multi', path: 'multi', from: 'cli', to: 'api', label: 'multipart: 3.2 GB in 100 MB parts', pc: ['PUT /madgate-pages'],
      title: 'Other outcome: a big file uses multipart upload',
      caption: 'A 3.2 GB video is uploaded as 33 parts in parallel; a failed part is retried alone. CompleteMultipartUpload stitches the part list into one object.',
      text: [],
      payloadKind: 'Multipart',
      payload: { upload_id: 'u_7Qx…', parts: 33, part_size_mb: 100, complete: { parts: [{ n: 1, etag: '"a1…"' }, '…'] } }
    },
    {
      id: 'end', from: 'cli', to: 'api', label: 'GET …/050/01.webp → 412 KB', pc: ['read any 8 of 12; decode'],
      title: 'Reads use the metadata, then the fastest 8',
      caption: 'The API looks up the fragment list and reads from the fastest 8 nodes; slow ones are ignored.',
      text: [],
      payloadKind: 'GET',
      payload: { status: 200, bytes: 412000, fragments_read: 8, ms: 24 }
    }
  ],
  decisions: [
    { q: 'Replication or erasure coding?', options: [
      { name: 'Erasure coding', verdict: 'good', why: '1.5× cost and tolerates more failures; reads cost some CPU.' },
      { name: '3 full copies', verdict: 'ok', why: 'Simpler and faster to read, but 3× the disks.' } ] }
  ],
  refs: [
    { label: 'Amazon S3: Strong read-after-write consistency', url: 'https://aws.amazon.com/s3/consistency/' },
    { label: 'Amazon S3 User Guide: Data protection (11 nines, 3 Availability Zones)', url: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/DataDurability.html' },
    { label: 'Amazon S3 User Guide: Multipart upload', url: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html' },
    { label: 'Backblaze: Reed-Solomon erasure coding explained', url: 'https://www.backblaze.com/blog/reed-solomon/' },
    { label: 'ByteByteGo: System Design Interview Vol. 2, chapter "S3-like Object Storage" (book)', url: 'https://bytebytego.com/courses/system-design-interview/s3-like-object-storage' }
  ],
  verify: {
    checked: ['Strong read-after-write and list consistency: AWS S3 consistency page.', 'Designed for 99.999999999% durability, stored across at least three Availability Zones: S3 data protection docs.', 'Erasure coding idea and Backblaze 17+3: Backblaze post.', 'Multipart upload and CompleteMultipartUpload: S3 multipart docs.'],
    uncertain: ['The 8+4 scheme, node names and timings are illustrative; AWS does not publish S3\'s internal coding scheme.']
  }
});
