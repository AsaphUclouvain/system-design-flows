flow({
  id: 'file-upload',
  title: 'Large file upload (presigned multipart)',
  category: 'Product systems',
  tags: ['S3', 'Presigned URLs', 'Multipart', 'Virus scan', 'Thumbnails'],
  summary: 'A 2.4 GB video goes from the browser straight to object storage in parallel 16 MB parts, resumes after Wi-Fi drops, and is scanned and thumbnailed before anyone else can see it. The API never touches the bytes.',
  requirements: {
    functional: [
      'Users upload files up to 5 GB from the browser, with a progress bar.',
      'An interrupted upload resumes where it stopped instead of starting over.',
      'Files are scanned for malware, and images and videos get previews, before they become visible.'
    ],
    nonFunctional: [
      'Upload bandwidth must not go through the API servers.',
      'Only the owner can upload to a given key; links expire quickly.',
      'Abandoned uploads do not cost storage forever.'
    ]
  },
  estimates: [
    { label: 'Uploads', value: '≈ 115 / s', note: 'Assumption: 10M uploads a day.' },
    { label: 'Ingress', value: '≈ 2.3 GB / s', note: '115 × average 20 MB. Absorbed by object storage, not by your servers.' },
    { label: 'Parts for 2.4 GB', value: '150', note: '2.4 GB ÷ 16 MB. S3 allows up to 10,000 parts, each 5 MB to 5 GB (the last part may be smaller).' },
    { label: 'API work per upload', value: '≈ 3 requests', note: 'Create, sign parts (batched), complete. The bytes themselves bypass the API.' }
  ],
  grid: { cols: 5, rows: 2 },
  nodes: [
    { id: 'browser', label: 'Browser', sub: 'Next.js', kind: 'client', x: 0, y: 0, desc: 'Splits the file with File.slice() and uploads parts in parallel with fetch.' },
    { id: 'api', label: 'Upload API', sub: 'FastAPI', kind: 'service', x: 1, y: 0, desc: 'Creates the multipart upload, signs part URLs, completes the upload. Never sees file bytes.' },
    { id: 'db', label: 'Files DB', sub: 'PostgreSQL', kind: 'db', x: 2, y: 0, desc: 'One row per file with its status: uploading, scanning, ready, rejected.' },
    { id: 's3', label: 'Object storage', sub: 'S3', kind: 'storage', x: 1, y: 1, desc: 'Receives parts directly from the browser and stitches them together on complete.' },
    { id: 'events', label: 'Storage events', sub: 'SQS', kind: 'queue', x: 2, y: 1, desc: 'S3 sends an ObjectCreated event here when the upload completes.' },
    { id: 'scan', label: 'Scanner', sub: 'ClamAV worker', kind: 'worker', icon: 'lock', x: 3, y: 1, desc: 'Downloads the object, scans it, tags it clean or infected.' },
    { id: 'media', label: 'Preview worker', sub: 'ffmpeg / libvips', kind: 'worker', icon: 'video', x: 3, y: 0, desc: 'Makes thumbnails (and starts transcoding for videos).' },
    { id: 'cdn', label: 'CDN', sub: 'signed URLs', kind: 'edge', icon: 'cdn', x: 4, y: 0, desc: 'Serves ready files with short-lived signed URLs; the bucket itself stays private.' },
    { id: 'viewer', label: 'Viewer', sub: 'browser', kind: 'client', icon: 'user', x: 4, y: 1, desc: 'Someone the file is shared with.' }
  ],
  steps: [
    {
      from: 'browser', to: 'api', label: 'POST /v1/uploads',
      title: 'The browser announces the upload',
      caption: 'Before sending bytes, the browser sends the file\'s name, size, type and a checksum of its first megabyte. The API decides the part size and the storage key.',
      text: ['The API checks quotas and the allowed types first: refusing a 5 GB upload after it has been sent wastes the user\'s time and bandwidth.', 'The declared `content_type` is only a claim. The scanner checks the real type from the bytes later.'],
      payloadKind: 'HTTP request',
      payload: { method: 'POST', path: '/v1/uploads', headers: { Authorization: 'Bearer eyJ…(sub=usr_maya)' }, body: { filename: 'ardennes-trip.mp4', size: 2516582400, content_type: 'video/mp4', sha256_first_mb: '9c1f…4be2' } },
      fields: { size: '2.4 GB in bytes. Used to compute the number of parts and to check the quota.', sha256_first_mb: 'A cheap fingerprint so the client can find this upload again to resume it.' }
    },
    {
      from: 'api', to: 's3', label: 'CreateMultipartUpload',
      title: 'Start a multipart upload in S3',
      caption: 'The API asks S3 for an UploadId under a key it chose (never the user\'s filename), then records the file as uploading.',
      text: ['The key contains a random id, not the filename: filenames collide, can contain path tricks, and leak information. The original name is kept in the database and sent back in `Content-Disposition` on download.'],
      payloadKind: 'S3 call + DB row',
      payload: { s3: { op: 'CreateMultipartUpload', Bucket: 'uploads-private', Key: 'u/usr_maya/f_01JDQ7A2/original', ContentType: 'video/mp4', ServerSideEncryption: 'aws:kms' }, s3_response: { UploadId: 'VXBsb2FkSWQ…ZXhhbXBsZQ' }, db_row: { id: 'f_01JDQ7A2', owner_id: 'usr_maya', status: 'uploading', size: 2516582400, part_size: 16777216, parts: 150 } },
      fields: { 's3_response.UploadId': 'Identifies this multipart upload. Every part upload and the final complete call must include it.', 'db_row.part_size': '16 MB: large enough to keep the part count low, small enough that a failed part is cheap to resend.' },
      code: [{ lang: 'python', title: 'Create upload (FastAPI + boto3)', src: String.raw`
PART = 16 * 1024 * 1024

@router.post("/v1/uploads", status_code=201)
async def create_upload(body: UploadIn, user=Depends(current_user), db=Depends(get_db)):
    if body.size > 5 * 1024**3 or body.content_type not in ALLOWED_TYPES:
        raise HTTPException(422, "file too large or type not allowed")
    await check_quota(user.id, body.size)
    file_id = new_id("f")
    key = f"u/{user.id}/{file_id}/original"
    mpu = await run_in_threadpool(s3.create_multipart_upload, Bucket=BUCKET, Key=key,
                                  ContentType=body.content_type, ServerSideEncryption="aws:kms")
    parts = math.ceil(body.size / PART)
    await db.execute(
        "INSERT INTO files (id, owner_id, s3_key, upload_id, filename, size, part_size, status)"
        " VALUES ($1,$2,$3,$4,$5,$6,$7,'uploading')",
        file_id, user.id, key, mpu["UploadId"], body.filename, body.size, PART)
    return {"file_id": file_id, "part_size": PART, "parts": parts}` }]
    },
    {
      from: 'api', to: 'browser', label: 'presigned part URLs', reply: true,
      title: 'The browser gets signed URLs for the parts',
      caption: 'The API signs one PUT URL per part (in batches of 50 so a huge file does not need a giant response). Each URL works only for that key, that part number and 15 minutes.',
      text: ['A {{presigned url}} carries an HMAC signature computed with the server\'s credentials over the method, bucket, key, part number, upload id and expiry. S3 recomputes it; changing anything breaks the signature. No credentials ever reach the browser.'],
      payloadKind: 'HTTP response',
      payload: { file_id: 'f_01JDQ7A2', part_size: 16777216, parts: [{ n: 1, url: 'https://uploads-private.s3.eu-west-1.amazonaws.com/u/usr_maya/f_01JDQ7A2/original?partNumber=1&uploadId=VXBs…&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=900&X-Amz-Signature=7d1c…' }, { n: 2, url: '…partNumber=2…' }, '… up to n=50; next batch on request'] },
      fields: { 'parts[].url': 'Signature V4 over method + path + query. Valid 900 s.' },
      code: [{ lang: 'python', title: 'Sign a batch of part URLs', src: String.raw`
@router.post("/v1/uploads/{file_id}/parts")
async def sign_parts(file_id: str, body: PartsIn, user=Depends(current_user), db=Depends(get_db)):
    f = await owned_file(db, file_id, user.id, status="uploading")
    return {"parts": [
        {"n": n, "url": s3.generate_presigned_url(
            "upload_part", ExpiresIn=900,
            Params={"Bucket": BUCKET, "Key": f.s3_key, "UploadId": f.upload_id, "PartNumber": n})}
        for n in body.part_numbers[:50]
    ]}` }]
    },
    {
      from: 'browser', to: 's3', label: 'PUT parts × 4 in parallel',
      title: 'Parts go straight to S3, four at a time',
      caption: 'The browser slices the file and PUTs parts in parallel. S3 answers each with an ETag; the browser keeps the list of finished parts in IndexedDB.',
      text: ['Four to six parallel parts saturate most home connections; more just compete with each other. Each failed part is retried alone with {{exponential backoff}}, so a flaky network costs at most 16 MB of resending.', 'The bucket needs a CORS rule that allows PUT from your site and exposes the `ETag` header, or the browser cannot read it.'],
      payloadKind: 'HTTP request / response (one part)',
      payloadLang: 'http',
      payload: String.raw`
PUT /u/usr_maya/f_01JDQ7A2/original?partNumber=37&uploadId=VXBs…&X-Amz-Signature=… HTTP/1.1
Host: uploads-private.s3.eu-west-1.amazonaws.com
Content-Length: 16777216

<16 MB of bytes 603979776–620756991>

HTTP/1.1 200 OK
ETag: "b54357faf0632cce46e942fa68356b38"`,
      code: [{ lang: 'ts', title: 'Browser: parallel, resumable part upload', src: String.raw`
async function uploadParts(file: File, up: Upload, signed: Map<number, string>) {
  const done = await idb.getDoneParts(up.fileId);              // resume support
  const todo = range(1, up.parts).filter(n => !done.has(n));
  let sent = [...done.values()].length * up.partSize;
  await pool(todo, 4, async n => {                            // 4 in flight
    const blob = file.slice((n - 1) * up.partSize, n * up.partSize);
    const res = await retry(() => fetch(signed.get(n)!, { method: 'PUT', body: blob }), {
      tries: 5, backoffMs: i => 500 * 2 ** i + Math.random() * 250,
    });
    if (!res.ok) throw new Error('part ' + n + ' failed: ' + res.status);
    await idb.markDone(up.fileId, n, res.headers.get('ETag')!);
    sent += blob.size;
    onProgress(sent / file.size);
  });
}` }],
      failure: ['**Signed URL expired mid-upload (slow connection):** S3 answers 403; the browser asks the API for fresh URLs for the remaining parts and continues.', '**Wi-Fi drops:** finished parts are recorded in IndexedDB. After reconnecting (or reloading the page), the app calls ListParts through the API, skips the parts S3 already has, and resumes.']
    },
    {
      from: 'browser', to: 'api', label: 'POST /complete {etags}',
      title: 'The browser asks to complete the upload',
      caption: 'With all 150 parts uploaded, the browser sends the part numbers and their ETags. The API passes them to S3, which assembles the object.',
      payloadKind: 'HTTP request',
      payload: { method: 'POST', path: '/v1/uploads/f_01JDQ7A2/complete', body: { parts: [{ n: 1, etag: '"a1f0…"' }, { n: 2, etag: '"7c3e…"' }, '…', { n: 150, etag: '"e9d4…"' }] } },
      text: ['The API does not trust the list blindly: it calls ListParts and checks that the sizes add up to the declared size. A client that lied about the size to pass the quota check is caught here.'],
      code: [{ lang: 'python', title: 'Complete', src: String.raw`
@router.post("/v1/uploads/{file_id}/complete")
async def complete(file_id: str, body: CompleteIn, user=Depends(current_user), db=Depends(get_db)):
    f = await owned_file(db, file_id, user.id, status="uploading")
    listed = await run_in_threadpool(list_all_parts, f.s3_key, f.upload_id)
    if sum(p["Size"] for p in listed) != f.size:
        raise HTTPException(409, "size mismatch")
    await run_in_threadpool(s3.complete_multipart_upload, Bucket=BUCKET, Key=f.s3_key,
        UploadId=f.upload_id,
        MultipartUpload={"Parts": [{"PartNumber": p.n, "ETag": p.etag} for p in body.parts]})
    await db.execute("UPDATE files SET status='scanning' WHERE id=$1 AND status='uploading'", file_id)
    return {"file_id": file_id, "status": "scanning"}` }],
      failure: ['**Complete called twice (retry):** the second S3 call fails with NoSuchUpload because the upload is already finished; the API sees status `scanning` and returns the same answer.']
    },
    {
      from: 's3', to: 'events', label: 'ObjectCreated', async: true,
      title: 'S3 announces the new object',
      caption: 'When the multipart upload completes, S3 sends an ObjectCreated:CompleteMultipartUpload event to an SQS queue. Workers react to events instead of trusting the client to call them.',
      payloadKind: 'S3 event notification',
      payload: { Records: [{ eventName: 'ObjectCreated:CompleteMultipartUpload', eventTime: '2026-11-25T11:03:44.902Z', s3: { bucket: { name: 'uploads-private' }, object: { key: 'u/usr_maya/f_01JDQ7A2/original', size: 2516582400, eTag: '3858f62230ac3c915f300c664312c11f-150', sequencer: '0065A1B2C3D4E5F601' } } }] },
      fields: { 'object.eTag': 'For multipart objects the ETag is not an MD5 of the file: it is an MD5 of the part MD5s, followed by -<number of parts>.', 'object.sequencer': 'Orders events for the same key, since delivery order is not guaranteed.' },
      text: ['S3 event delivery is {{at-least-once}}, and an event can arrive twice. Workers make their work idempotent by checking the file status before acting.']
    },
    {
      from: 'events', to: 'scan', label: 'receive message',
      title: 'The scanner checks the file',
      caption: 'A worker receives the event, streams the object through ClamAV and checks the real file type from its first bytes. It tags the object and updates the database.',
      text: ['The SQS {{visibility timeout}} is set longer than the slowest scan (say 15 minutes). If the worker dies mid-scan, the message reappears and another worker retries; after 5 failed receives it goes to a {{dead-letter queue}}.', 'Never trust the extension: a file named .mp4 whose bytes start with `MZ` is a Windows executable.'],
      payloadKind: 'Scan result',
      payload: { file_id: 'f_01JDQ7A2', detected_type: 'video/mp4 (ftyp isom)', clamav: 'OK', scanned_bytes: 2516582400, duration_s: 41.7, s3_tags: { scan: 'clean' }, db_update: "UPDATE files SET status='processing' WHERE id='f_01JDQ7A2' AND status='scanning'" },
      code: [{ lang: 'python', title: 'Scan worker', src: String.raw`
async def handle(event: dict):
    key = event["s3"]["object"]["key"]
    f = await files.by_key(key)
    if f.status != "scanning":
        return                                          # duplicate event, already done
    body = s3.get_object(Bucket=BUCKET, Key=key)["Body"]
    head = body.read(4096)
    kind = magic.from_buffer(head, mime=True)
    verdict = await clamd_instream(itertools.chain([head], iter(lambda: body.read(1 << 20), b"")))
    if verdict != "OK" or kind not in ALLOWED_TYPES:
        await files.set_status(f.id, "rejected", reason=verdict if verdict != "OK" else f"type {kind}")
        s3.put_object_tagging(Bucket=BUCKET, Key=key, Tagging={"TagSet": [{"Key": "scan", "Value": "infected"}]})
        return
    s3.put_object_tagging(Bucket=BUCKET, Key=key, Tagging={"TagSet": [{"Key": "scan", "Value": "clean"}]})
    await files.set_status(f.id, "processing")
    await preview_queue.send({"file_id": f.id, "key": key, "type": kind})` }],
      failure: ['**Infected file:** status `rejected`, the object is tagged and a lifecycle rule deletes it; the owner sees "This file was blocked" and it can never be shared.']
    },
    {
      from: 'scan', to: 'media', label: 'preview job',
      title: 'Make previews',
      caption: 'For a video, the preview worker grabs a frame at 10% of the duration for the poster, writes three thumbnail sizes, and hands the original to the transcoding pipeline.',
      text: ['Thumbnails are written under the same file prefix, so deleting a file deletes everything with one prefix delete. The video-streaming flow covers transcoding into HLS renditions.'],
      payloadKind: 'Preview job + output',
      payload: { job: { file_id: 'f_01JDQ7A2', key: 'u/usr_maya/f_01JDQ7A2/original', type: 'video/mp4' }, ffprobe: { duration_s: 734.2, width: 3840, height: 2160, codec: 'hevc' }, written: ['u/usr_maya/f_01JDQ7A2/thumb_320.webp', 'u/usr_maya/f_01JDQ7A2/thumb_960.webp', 'u/usr_maya/f_01JDQ7A2/poster_1920.webp'], next: 'transcode.requested' },
      code: [{ lang: 'bash', title: 'ffmpeg: poster frame at 10%', src: String.raw`
ffmpeg -ss 73.4 -i original.mp4 -frames:v 1 -vf "scale=1920:-2" -q:v 80 poster_1920.webp
ffmpeg -i poster_1920.webp -vf "scale=320:-2" thumb_320.webp` }]
    },
    {
      from: 'media', to: 'db', label: 'status = ready',
      title: 'The file becomes visible',
      caption: 'The worker records the preview keys and sets the status to ready. Only now do share links and listings include the file.',
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
UPDATE files
SET status = 'ready', duration_s = 734.2, width = 3840, height = 2160,
    previews = '{"poster":"…/poster_1920.webp","thumb":"…/thumb_320.webp"}'
WHERE id = 'f_01JDQ7A2' AND status = 'processing';`,
      text: ['The browser learns about it by polling `GET /v1/files/f_01JDQ7A2` every few seconds, or through the app\'s existing WebSocket/SSE channel. The `AND status = ...` guard makes each transition happen exactly once even if two workers race.']
    },
    {
      from: 'viewer', to: 'cdn', label: 'GET signed URL',
      title: 'A viewer downloads through the CDN',
      caption: 'The API gives the viewer a CDN URL signed for 10 minutes. The CDN fetches from the private bucket (with its own origin credentials) and caches the bytes near the viewer.',
      text: ['The bucket blocks all public access; the CDN reaches it with an origin access identity. The signed URL proves the API authorised this viewer, without the CDN needing to call the API.', '`Content-Disposition` restores the original filename, and `X-Content-Type-Options: nosniff` stops browsers from reinterpreting an uploaded file as HTML ({{xss}}).'],
      payloadKind: 'Signed download',
      payloadLang: 'http',
      payload: String.raw`
GET /u/usr_maya/f_01JDQ7A2/original?Expires=1764069000&Key-Pair-Id=K2JCJMDEHXQW5F&Signature=Nq3… HTTP/2
Host: files.example-cdn.com
Range: bytes=0-1048575

HTTP/2 206
Content-Type: video/mp4
Content-Disposition: inline; filename="ardennes-trip.mp4"
X-Content-Type-Options: nosniff
Cache-Control: private, max-age=600
Content-Range: bytes 0-1048575/2516582400`,
      fields: { Range: 'Video players ask for byte ranges; the CDN serves 206 Partial Content so seeking does not download the whole file.' }
    }
  ],
  api: [
    { verb: 'POST', path: '/v1/uploads', desc: 'Start an upload. Returns file_id, part_size and part count.' },
    { verb: 'POST', path: '/v1/uploads/{id}/parts', desc: 'Sign up to 50 part URLs.' },
    { verb: 'GET', path: '/v1/uploads/{id}/parts', desc: 'Parts S3 already has (for resume).' },
    { verb: 'POST', path: '/v1/uploads/{id}/complete', desc: 'Complete with part numbers and ETags.' },
    { verb: 'DELETE', path: '/v1/uploads/{id}', desc: 'Abort: AbortMultipartUpload frees the stored parts.' }
  ],
  schema: String.raw`
CREATE TYPE file_status AS ENUM ('uploading','scanning','processing','ready','rejected');

CREATE TABLE files (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  s3_key      TEXT NOT NULL UNIQUE,
  upload_id   TEXT,                       -- multipart UploadId while uploading
  filename    TEXT NOT NULL,              -- original name, display only
  size        BIGINT NOT NULL,
  part_size   INT NOT NULL,
  status      file_status NOT NULL,
  reason      TEXT,
  previews    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- S3 lifecycle rule: AbortIncompleteMultipartUpload after 2 days
-- (otherwise abandoned parts are billed forever and invisible in listings)`,
  decisions: [
    { q: 'How do the bytes reach storage?', options: [
      { verdict: 'bad', name: 'Through the API (multipart/form-data to FastAPI)', why: 'Ties up API workers and memory for minutes per upload; the API becomes the bandwidth bottleneck.' },
      { verdict: 'good', name: 'Single presigned PUT', why: 'Direct to S3, but limited to 5 GB, no parallelism, and a drop means starting over.' },
      { verdict: 'great', name: 'Presigned multipart upload', why: 'Parallel, resumable, and the API only signs.' }
    ] },
    { q: 'When is the file usable?', options: [
      { verdict: 'bad', name: 'As soon as the browser says it finished', why: 'Unscanned files could be shared and served.' },
      { verdict: 'great', name: 'A status machine driven by storage events', why: 'uploading → scanning → processing → ready, each step idempotent.' }
    ] }
  ],
  refs: [
    { label: 'AWS: Uploading an object using multipart upload', url: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html' },
    { label: 'AWS: Amazon S3 multipart upload limits', url: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html' },
    { label: 'AWS: Sharing objects with presigned URLs', url: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/ShareObjectPreSignedURL.html' },
    { label: 'AWS: Event notification message structure', url: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-content-structure.html' }
  ]
});
