flow({
  id: 'video-streaming',
  title: 'Video transcoding and adaptive streaming',
  category: 'Product systems',
  tags: ['HLS', 'ffmpeg', 'Adaptive bitrate', 'CDN', 'Job DAG'],
  summary: 'A 4K upload becomes six HLS renditions cut into 4-second segments, transcoded in parallel, and played on a phone that drops from 1080p to 480p in a tunnel without stopping. Chunked transcoding, manifests, CDN caching and the player\'s bitrate logic.',
  requirements: {
    functional: [
      'Uploaded videos are converted into several qualities and play on web, iOS and Android.',
      'Playback starts fast and adapts to the viewer\'s bandwidth without rebuffering.',
      'Creators see processing progress; viewers see a poster and a seek-preview strip.'
    ],
    nonFunctional: [
      'A 10-minute video is playable within a few minutes of upload.',
      'Delivery cost is dominated by bandwidth, so cache hit ratio at the CDN must be very high (over 95%).',
      'A failed transcode chunk is retried alone, not the whole video.'
    ]
  },
  estimates: [
    { label: 'Uploads', value: '500 hours of video / min', note: 'Assumption at very large scale; scale down linearly for your case.' },
    { label: 'Segments per rendition', value: '184', note: 'A 12:14 video (734 s) ÷ 4 s segments.' },
    { label: 'Storage per video', value: '≈ 2.1 GB', note: 'Sum of six renditions at about 0.4 + 0.8 + 1.4 + 2.8 + 5 + 12 Mbit/s × 734 s ÷ 8.' },
    { label: 'Egress', value: 'Viewers × bitrate', note: '1M concurrent viewers at 3 Mbit/s = 3 Tbit/s: only a CDN can serve that.' }
  ],
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'src', label: 'Original upload', sub: 'S3', kind: 'storage', x: 0, y: 0, desc: 'The clean, scanned original from the upload flow.' },
    { id: 'orch', label: 'Transcode orchestrator', sub: 'FastAPI + DB', kind: 'service', icon: 'clock', x: 1, y: 1, desc: 'Plans the job as a DAG: split, transcode each chunk × rendition, then package. Tracks every task.' },
    { id: 'q', label: 'Task queue', sub: 'SQS / Celery', kind: 'queue', x: 1, y: 0, desc: 'Holds one task per (chunk, rendition). Thousands can run in parallel.' },
    { id: 'workers', label: 'Transcode workers', sub: 'ffmpeg, GPU/CPU', kind: 'worker', icon: 'video', x: 2, y: 0, desc: 'Autoscaled on queue depth. Each task encodes one chunk at one rendition.' },
    { id: 'pack', label: 'Packager', sub: 'HLS manifests', kind: 'worker', x: 2, y: 1, desc: 'Writes the master playlist and one media playlist per rendition once all chunks are done.' },
    { id: 'out', label: 'Renditions', sub: 'S3', kind: 'storage', x: 3, y: 1, desc: 'Segments and playlists under one prefix per video.' },
    { id: 'cdn', label: 'CDN', sub: 'edge cache', kind: 'edge', icon: 'cdn', x: 2, y: 2, desc: 'Caches segments near viewers. Segments never change, so they cache forever.' },
    { id: 'api', label: 'Video API', sub: 'FastAPI', kind: 'service', x: 0, y: 1, desc: 'Returns video metadata and a signed playback URL.' },
    { id: 'player', label: 'Player', sub: 'hls.js in Next.js', kind: 'client', icon: 'play', x: 1, y: 2, desc: 'Downloads playlists and segments, measures bandwidth, switches quality.' },
    { id: 'viewer', label: 'Viewer', sub: 'phone', kind: 'client', icon: 'phone', x: 0, y: 2, desc: 'Watching on a train, bandwidth swinging between 0.8 and 12 Mbit/s.' }
  ],
  steps: [
    {
      from: 'src', to: 'orch', label: 'transcode.requested', async: true,
      title: 'A transcode job is requested',
      caption: 'The preview worker from the upload flow emits transcode.requested. The orchestrator probes the file and plans the work.',
      text: ['Probing first (codec, resolution, frame rate, duration) lets the orchestrator skip renditions above the source: a 720p upload gets no 1080p or 4K rendition.'],
      payloadKind: 'Event + ffprobe',
      payload: { event: { type: 'transcode.requested', file_id: 'f_01JDQ7A2', key: 'u/usr_maya/f_01JDQ7A2/original' }, probe: { duration_s: 734.2, width: 3840, height: 2160, fps: 29.97, video_codec: 'hevc', audio_codec: 'aac', rotation: 0 } }
    },
    {
      from: 'orch', to: 'q', label: 'enqueue chunk tasks',
      title: 'Split into chunks and fan out tasks',
      caption: 'The orchestrator plans 13 chunks of about 60 s (cut on keyframes) × 6 renditions = 78 encode tasks, plus one audio task, and enqueues them all.',
      text: ['Chunked encoding turns one 40-minute job into dozens of 1-minute jobs running at once, so a 12-minute video can be ready in a few minutes. Chunks are cut at {{keyframe}}s so each can be decoded on its own.', 'The plan is a small DAG stored in the database: package depends on all 79 tasks. Each task row has a status, an attempt count and an output key.'],
      payloadKind: 'Job plan (excerpt)',
      payload: { job_id: 'tj_8841', video_id: 'v_01JDQ7A2', ladder: [{ name: '240p', w: 426, h: 240, kbps: 400 }, { name: '360p', w: 640, h: 360, kbps: 800 }, { name: '480p', w: 854, h: 480, kbps: 1400 }, { name: '720p', w: 1280, h: 720, kbps: 2800 }, { name: '1080p', w: 1920, h: 1080, kbps: 5000 }, { name: '2160p', w: 3840, h: 2160, kbps: 12000 }], chunks: 13, tasks: 79, example_task: { task_id: 'tt_8841_c07_720p', chunk: 7, start_s: 360.36, end_s: 420.42, rendition: '720p', attempt: 0 } },
      fields: { ladder: 'The bitrate ladder. Each step roughly doubles the bitrate so the player always has a sensible step up or down.', 'example_task.start_s': 'Aligned to a keyframe found by ffprobe, not exactly 360.0.' },
      code: [{ lang: 'python', title: 'Plan the DAG', src: String.raw`
LADDER = [("240p", 426, 240, 400), ("360p", 640, 360, 800), ("480p", 854, 480, 1400),
          ("720p", 1280, 720, 2800), ("1080p", 1920, 1080, 5000), ("2160p", 3840, 2160, 12000)]

async def plan(job: Job, probe: Probe):
    rungs = [r for r in LADDER if r[2] <= probe.height]        # never upscale
    cuts = keyframe_cuts(probe.keyframes, target_s=60)          # [(0, 60.06), (60.06, 120.12), ...]
    tasks = [Task(job.id, f"c{i:02}_{name}", start, end, name)
             for i, (start, end) in enumerate(cuts) for (name, *_ ) in rungs]
    tasks.append(Task(job.id, "audio", 0, probe.duration, "aac_128k"))
    async with db.transaction():
        await db.insert_many("tasks", tasks)                    # status = 'queued'
        await db.execute("UPDATE jobs SET total=$2, status='running' WHERE id=$1", job.id, len(tasks))
    for t in tasks:
        await queue.send(t.model_dump())` }]
    },
    {
      from: 'q', to: 'workers', label: 'receive task',
      title: 'Workers encode chunks in parallel',
      caption: 'Each worker pulls a task, reads its byte range of the original with a ranged GET, and runs ffmpeg for one chunk at one rendition with fixed 4-second keyframes.',
      text: ['Forcing a keyframe every 4 s (`-g`, `-keyint_min`, `-sc_threshold 0`) at the same timestamps in every rendition is what lets the player switch quality at any segment boundary without a glitch.', 'Workers scale with queue depth. Spot or preemptible machines are a good fit because a killed task simply reappears in the queue after its {{visibility timeout}}.'],
      payloadKind: 'ffmpeg command (chunk 7, 720p)',
      payloadLang: 'bash',
      payload: String.raw`
ffmpeg -ss 360.36 -to 420.42 -i "$SIGNED_SOURCE_URL" \
  -map 0:v:0 -c:v libx264 -preset medium -profile:v high \
  -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2" \
  -b:v 2800k -maxrate 3000k -bufsize 5600k \
  -g 120 -keyint_min 120 -sc_threshold 0 -an \
  -f mp4 c07_720p.mp4                 # 120 frames = 4 s at 29.97 fps`,
      code: [{ lang: 'python', title: 'Worker loop with idempotent output', src: String.raw`
async def run_task(t: dict):
    out_key = f"v/{t['video_id']}/work/{t['task_id']}.mp4"
    if await s3_exists(out_key):                       # retried after a crash post-upload
        return await mark_done(t, out_key)
    await mark_running(t)                              # attempt += 1
    with tempfile.TemporaryDirectory() as d:
        await ffmpeg(chunk_args(t, src=signed_url(t["source_key"]), out=f"{d}/o.mp4"), timeout=900)
        await s3_upload(f"{d}/o.mp4", out_key)
    await mark_done(t, out_key)                        # may trigger packaging (next step)` }],
      failure: ['**ffmpeg fails on a corrupt chunk:** retried up to 3 times; then the job is marked failed with the ffmpeg log and the creator sees "We could not process this video".', '**Worker killed (spot instance):** the task reappears in the queue and runs again; the `s3_exists` check makes a finished-but-unacknowledged task cost nothing.']
    },
    {
      from: 'workers', to: 'orch', label: 'task done (78/79…)',
      title: 'Progress is tracked per task',
      caption: 'Each finished task updates its row. A counter on the job tells the creator "Processing 64%". When the last task finishes, the orchestrator enqueues packaging.',
      text: ['The "am I the last one?" check must be atomic, or two workers finishing at the same moment could both trigger packaging (or neither). One SQL statement with `RETURNING` does it.'],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
UPDATE tasks SET status = 'done', output_key = 'v/v_01JDQ7A2/work/tt_8841_c07_720p.mp4'
WHERE id = 'tt_8841_c07_720p' AND status = 'running';

UPDATE jobs SET done = done + 1 WHERE id = 'tj_8841'
RETURNING done, total;               -- → 79, 79  ⇒ enqueue package step`
    },
    {
      from: 'orch', to: 'pack', label: 'package job',
      title: 'Package the chunks into HLS',
      caption: 'The packager concatenates the chunks of each rendition (no re-encoding), cuts them into 4-second fMP4 segments and writes one media playlist per rendition plus the master playlist.',
      text: ['{{hls}} is just files over HTTP: a master playlist listing renditions, a media playlist per rendition listing segments, and the segments. Any CDN can serve it, which is why it won over streaming servers.', 'fMP4 (CMAF) segments can be shared with DASH players, so one set of files serves both formats.'],
      payloadKind: 'master.m3u8',
      payloadLang: 'text',
      payload: String.raw`
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,URI="audio/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=540000,RESOLUTION=426x240,CODECS="avc1.64001e,mp4a.40.2",AUDIO="aac"
240p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="aac"
360p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1650000,RESOLUTION=854x480,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aac"
480p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3200000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aac"
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5600000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aac"
1080p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=13500000,RESOLUTION=3840x2160,CODECS="avc1.640033,mp4a.40.2",AUDIO="aac"
2160p/index.m3u8`,
      fields: { BANDWIDTH: 'Peak bits per second for that rendition, including audio. The player compares it with the measured throughput.', CODECS: 'Lets a device skip renditions it cannot decode before downloading any segment.' }
    },
    {
      from: 'pack', to: 'out', label: 'write segments + playlists',
      title: 'Segments and playlists land in storage',
      caption: 'Each rendition gets 184 segments and an index. The playlists reference segments by relative path, so the whole tree can move between buckets or CDNs.',
      payloadKind: '720p/index.m3u8 (start)',
      payloadLang: 'text',
      payload: String.raw`
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.004,
seg_00000.m4s
#EXTINF:4.004,
seg_00001.m4s
… 182 more …
#EXT-X-ENDLIST`,
      text: ['Segment names never change and their content never changes, so they get `Cache-Control: public, max-age=31536000, immutable`. Playlists of finished videos are also immutable; only live streams have playlists that change.', 'The job is marked `ready`, the work/ chunks are deleted, and a seek-preview sprite (one thumbnail every 10 s in a grid) is generated as a last small task.']
    },
    {
      from: 'viewer', to: 'player', label: 'tap play',
      title: 'A viewer opens the video page',
      caption: 'The Next.js page renders title, poster and description on the server. The player component loads hls.js in the browser (Safari plays HLS natively).',
      payloadKind: 'Page data',
      payload: { video_id: 'v_01JDQ7A2', title: 'Ardennes trip', duration_s: 734.2, poster: 'https://media.example-cdn.com/v/v_01JDQ7A2/poster_1920.webp', storyboard: 'https://media.example-cdn.com/v/v_01JDQ7A2/sprite.jpg' },
      code: [{ lang: 'ts', title: 'Player component (Next.js client component)', src: String.raw`
'use client';
import Hls from 'hls.js';
import { useEffect, useRef } from 'react';

export function Player({ src, poster }: { src: string; poster: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current!;
    if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = src; return; } // Safari
    const hls = new Hls({ capLevelToPlayerSize: true, maxBufferLength: 30 });
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(Hls.Events.LEVEL_SWITCHED, (_, d) => console.debug('quality', hls.levels[d.level].height));
    hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal && d.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad(); });
    return () => hls.destroy();
  }, [src]);
  return <video ref={ref} poster={poster} controls playsInline className="w-full aspect-video" />;
}` }],
      text: ['`capLevelToPlayerSize` stops a phone with a 400-pixel-wide player from downloading 4K just because the network allows it.']
    },
    {
      from: 'player', to: 'api', label: 'GET /v1/videos/v_…/play',
      title: 'Get a signed playback URL',
      caption: 'The API checks the viewer may watch (private, unlisted, region rules) and returns the master playlist URL with a signed cookie or token valid for the video\'s prefix.',
      text: ['Signing the prefix (`/v/v_01JDQ7A2/*`) rather than each file means one signature covers 1,100 segments. Short expiry plus prefix scope keeps links from being shared widely.'],
      payloadKind: 'HTTP response',
      payload: { manifest: 'https://media.example-cdn.com/v/v_01JDQ7A2/master.m3u8', set_cookies: ['CloudFront-Policy=eyJTdGF0ZW1lbnQiOlt7IlJlc291cmNlIjoiaHR0cHM6Ly9tZWRpYS4uLi92L3ZfMDFKRFE3QTIvKiIs…', 'CloudFront-Signature=Hk1…', 'CloudFront-Key-Pair-Id=K2JCJMDEHXQW5F'], expires_in: 21600 },
      fields: { 'set_cookies[0]': 'A policy allowing any URL under the video\'s prefix until the expiry time.' }
    },
    {
      from: 'player', to: 'cdn', label: 'GET master, 720p seg_00000',
      title: 'Start with a safe rendition',
      caption: 'The player fetches the master playlist, starts at a middle rendition (or the last one that worked for this device), and downloads the first segments to fill a small buffer.',
      text: ['Starting low makes playback start fast (under a second for a 4-second 720p segment on a decent connection); the player then measures how fast segments actually arrive and climbs.', 'On a CDN miss, the edge fetches from S3 once, then serves every later viewer in that region from cache. Popular videos reach hit ratios close to 100%.'],
      payloadKind: 'Requests (first second)',
      payloadLang: 'http',
      payload: String.raw`
GET /v/v_01JDQ7A2/master.m3u8          → 200  1.1 KB  X-Cache: Hit
GET /v/v_01JDQ7A2/720p/index.m3u8      → 200  9.8 KB  X-Cache: Hit
GET /v/v_01JDQ7A2/720p/init.mp4        → 200  1.2 KB  X-Cache: Hit
GET /v/v_01JDQ7A2/720p/seg_00000.m4s   → 200  1.4 MB  X-Cache: Miss from cloudfront  (82 ms)
GET /v/v_01JDQ7A2/audio/seg_00000.m4s  → 200   64 KB  X-Cache: Hit`
    },
    {
      from: 'cdn', to: 'player', label: 'segments → ABR switches', reply: true,
      title: 'The player adapts to the network',
      caption: 'Each segment download is a bandwidth sample. In a tunnel the estimate falls to 1.1 Mbit/s, so the next segment comes from 480p; out of the tunnel it climbs back to 1080p, one rung at a time.',
      text: ['{{adaptive bitrate}} logic in hls.js uses an exponentially weighted moving average of throughput and picks the highest rendition whose BANDWIDTH fits under a safety margin. Other players also look at the buffer level: with 25 s buffered, it is safe to try a higher rung.', 'Switches only happen at segment boundaries, which is why every rendition needed keyframes at the same 4-second marks.'],
      payloadKind: 'Player decisions over time',
      payload: [{ t: '0:00', estimate_mbps: 6.2, buffer_s: 4, picked: '720p' }, { t: '0:12', estimate_mbps: 7.9, buffer_s: 14, picked: '1080p' }, { t: '2:40', estimate_mbps: 1.1, buffer_s: 22, picked: '480p', note: 'tunnel' }, { t: '2:56', estimate_mbps: 0.6, buffer_s: 9, picked: '240p' }, { t: '3:30', estimate_mbps: 8.4, buffer_s: 18, picked: '720p → 1080p' }],
      failure: ['**A segment request fails or stalls:** hls.js retries it, then tries the same segment at a lower rendition. Playback continues from the buffer meanwhile, so the viewer sees a quality dip instead of a spinner.']
    }
  ],
  api: [
    { verb: 'POST', path: '/v1/videos', desc: 'Register an uploaded file as a video; starts transcoding.' },
    { verb: 'GET', path: '/v1/videos/{id}', desc: 'Metadata, status and progress (processing 64%).' },
    { verb: 'GET', path: '/v1/videos/{id}/play', desc: 'Signed master playlist URL (cookies scoped to the video prefix).' }
  ],
  schema: String.raw`
CREATE TABLE videos (
  id TEXT PRIMARY KEY, file_id TEXT NOT NULL, owner_id TEXT NOT NULL,
  title TEXT, duration_s REAL, status TEXT NOT NULL,     -- processing | ready | failed
  renditions TEXT[], created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE jobs  (id TEXT PRIMARY KEY, video_id TEXT, total INT, done INT DEFAULT 0, status TEXT);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, job_id TEXT REFERENCES jobs, kind TEXT,  -- encode | audio | package
  chunk INT, rendition TEXT, start_s REAL, end_s REAL,
  status TEXT, attempt INT DEFAULT 0, output_key TEXT, error TEXT
);
-- S3 layout: v/{video_id}/master.m3u8, v/{video_id}/{rendition}/index.m3u8, …/seg_00000.m4s`,
  decisions: [
    { q: 'How do you transcode long videos quickly?', options: [
      { verdict: 'bad', name: 'One ffmpeg process per video, all renditions', why: 'A 2-hour film takes hours; a crash restarts from zero.' },
      { verdict: 'great', name: 'Split on keyframes, encode chunk × rendition in parallel, then concatenate', why: 'Minutes instead of hours, and retries are per chunk.' }
    ] },
    { q: 'How do you deliver to many devices?', options: [
      { verdict: 'bad', name: 'Progressive MP4 download', why: 'One quality; a slow network means constant rebuffering.' },
      { verdict: 'great', name: 'HLS/DASH with a bitrate ladder over a CDN', why: 'Plain HTTP files, cacheable everywhere, and the player adapts.' }
    ] }
  ],
  refs: [
    { label: 'RFC 8216: HTTP Live Streaming', url: 'https://www.rfc-editor.org/rfc/rfc8216' },
    { label: 'hls.js API documentation', url: 'https://github.com/video-dev/hls.js/blob/master/docs/API.md' },
    { label: 'Netflix: High quality video encoding at scale', url: 'https://netflixtechblog.com/high-quality-video-encoding-at-scale-d159db052746', note: 'Chunked parallel encoding in production.' },
    { label: 'Apple: HLS authoring specification', url: 'https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices' }
  ]
});
