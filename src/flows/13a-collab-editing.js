flow({
  id: 'collab-editing',
  title: 'Collaborative editing (CRDT document sync)',
  category: 'Real-time',
  tags: ['CRDT (Yjs)', 'WebSocket rooms', 'Awareness / cursors', 'Offline edits', 'Snapshots + update log'],
  summary: 'Two people edit the same document at once, one of them on a train with a flaky connection. Follow a keystroke as a CRDT update through a WebSocket room, see it merge without conflicts with an edit made offline, and see how the server stores updates and snapshots so a document of a million edits still opens instantly.',
  requirements: {
    functional: [
      'Several people edit one document at once and see each other\'s changes and cursors live.',
      'Edits made offline merge automatically when the connection returns, never lost.',
      'Documents open quickly and keep a version history.'
    ],
    nonFunctional: [
      'Keystroke to remote screen under 150 ms in the same region.',
      'All replicas converge to the same text, regardless of message order.',
      'One server node can host thousands of active documents.'
    ]
  },
  estimates: [
    { label: 'Active documents', value: '50,000', note: 'At peak, each with 1–5 editors connected.' },
    { label: 'Updates', value: '≈ 120,000 / s', note: 'Typing produces ~5 updates/s per active editor (batched per animation frame).' },
    { label: 'Update size', value: '20–60 bytes', note: 'Yjs binary encoding of an insert: client id, clock, position reference and the characters.' },
    { label: 'Log growth', value: '≈ 1 GB / h', note: 'Before compaction into snapshots every 500 updates.' }
  ],
  grid: { cols: 4, rows: 3 },
  nodes: [
    { id: 'ana', label: 'Ana\'s editor', sub: 'Next.js + Yjs', kind: 'client', icon: 'pen', x: 0, y: 0, desc: 'Rich-text editor (TipTap/ProseMirror) bound to a Yjs document.' },
    { id: 'ben', label: 'Ben\'s editor', sub: 'on a train', kind: 'client', icon: 'pen', x: 0, y: 2, desc: 'Same document; keeps editing while offline, stored in IndexedDB.' },
    { id: 'gw', label: 'Sync gateway', sub: 'WebSocket', kind: 'edge', icon: 'plug', x: 1, y: 1, desc: 'Authenticates and routes each document to the server node that owns its room.' },
    { id: 'room', label: 'Doc room', sub: 'FastAPI node', kind: 'service', x: 2, y: 1, desc: 'Holds the live Yjs document in memory, merges and rebroadcasts updates.' },
    { id: 'redis', label: 'Room directory', sub: 'Redis', kind: 'cache', x: 2, y: 0, desc: 'Which node owns which document room, with a lease.' },
    { id: 'log', label: 'Update log', sub: 'PostgreSQL', kind: 'db', x: 3, y: 1, desc: 'Every update appended durably before it is acknowledged.' },
    { id: 'snap', label: 'Snapshots', sub: 'S3', kind: 'storage', x: 3, y: 2, desc: 'Compacted document state every 500 updates; version history points here.' },
    { id: 'compactor', label: 'Compactor', sub: 'worker', kind: 'worker', x: 2, y: 2, desc: 'Merges the update log into a snapshot and trims old updates.' }
  ],
  steps: [
    {
      from: 'ana', to: 'gw', label: 'WS /docs/d_42 (JWT)',
      title: 'Ana opens the document',
      caption: 'Ana\'s browser opens a WebSocket to the sync gateway for document d_42. The gateway checks her token and that she has edit rights on this document.',
      text: ['Permissions are checked when the socket opens and again every few minutes, so removing someone\'s access disconnects them without waiting for them to reload.'],
      payloadKind: 'WebSocket handshake',
      payload: { url: 'wss://sync.docs.example/docs/d_42', headers: { 'Sec-WebSocket-Protocol': 'yjs-v1, bearer.eyJhbGciOi…' }, auth: { sub: 'usr_ana', doc: 'd_42', role: 'editor' } },
      fields: { 'Sec-WebSocket-Protocol': 'Browsers cannot set Authorization on WebSockets, so the token rides in the subprotocol header (or a short-lived ticket in the URL).' }
    },
    {
      from: 'gw', to: 'redis', label: 'who owns d_42?',
      title: 'Find the node that owns the room',
      caption: 'All editors of one document must meet in one place. The gateway looks up the room directory: d_42 is owned by node room-3, whose lease is valid for 9 more seconds.',
      text: ['Keeping one owner per document makes merging simple and keeps the document in one process\'s memory. If no owner exists, the gateway picks a node by {{consistent hashing}} and that node takes the {{lease}}.'],
      payloadKind: 'Redis',
      payloadLang: 'redis',
      payload: String.raw`
> GET room:d_42
"room-3"
> PTTL room:d_42
(integer) 9120                    -- owner renews every 3 s

-- no owner yet? the chosen node runs:
> SET room:d_42 room-3 NX PX 10000`,
      failure: ['**Owner node crashes:** its lease expires within 10 s; the next connection makes another node the owner, which loads the snapshot plus log tail. Clients reconnect and resync automatically.']
    },
    {
      from: 'gw', to: 'room', label: 'sync step 1: state vector',
      title: 'Sync: "here is what I already have"',
      caption: 'Ana\'s client sends its state vector: for each client that ever edited, how many operations it has seen. The room replies with exactly the operations Ana is missing, and its own state vector.',
      text: ['This two-step exchange is how Yjs syncs any two replicas, whether a fresh browser, a reconnecting one, or two servers. Nobody sends the whole document unless the other side has nothing.', 'A {{state vector}} is tiny: one pair of numbers per editor who ever touched the document.'],
      payloadKind: 'Sync messages',
      payload: { 'client → room': { type: 'sync-step-1', stateVector: { '1938402': 4120, '77120': 851 } }, 'room → client': { type: 'sync-step-2', update: '<binary, 312 bytes: ops 4121–4133 from client 1938402>', stateVector: { '1938402': 4133, '77120': 851, '502811': 60 } } },
      fields: { stateVector: 'Map of client id → next expected clock. Comparing two vectors tells exactly which operations each side lacks.' }
    },
    {
      from: 'ana', to: 'gw', label: 'update → room',
      title: 'Ana types a word',
      caption: 'Ana types "quickly " after "The fox jumped ". Yjs records an insert that references the character it follows by its unique id, not by a numeric index, then sends the encoded update over the socket; the gateway forwards it to the room.',
      text: ['This is the core idea of a {{crdt}}: positions are identities (client id + clock), not indexes. "After character (1938402, 88)" stays meaningful even if other people insert text before it in the meantime.', 'Updates are batched per animation frame, so fast typing sends a few messages per second, not one per key.'],
      payloadKind: 'Yjs update (decoded)',
      payload: { type: 'update', struct: { id: { client: 502811, clock: 60 }, origin: { client: 1938402, clock: 88 }, rightOrigin: { client: 1938402, clock: 89 }, content: 'quickly ', parent: 'prosemirror/paragraph[2]' }, encoded_bytes: 31 },
      fields: { origin: 'The character this insert comes after. Together with rightOrigin it pins the insert between two specific characters.', clock: 'Counts operations from this client. 60 characters typed by Ana so far in this document.' },
      code: [{ lang: 'ts', title: 'Editor binding (Next.js client component)', src: String.raw`
"use client";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { IndexeddbPersistence } from "y-indexeddb";
import { useEditor, EditorContent } from "@tiptap/react";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";

export function DocEditor({ docId, token, me }: Props) {
  const [{ ydoc, provider }] = useState(() => {
    const ydoc = new Y.Doc();
    new IndexeddbPersistence("doc-" + docId, ydoc);           // offline copy
    const provider = new WebsocketProvider(SYNC_URL, "docs/" + docId, ydoc,
                                           { protocols: ["yjs-v1", "bearer." + token] });
    return { ydoc, provider };
  });
  const editor = useEditor({ extensions: [
    StarterKit.configure({ history: false }),                // undo is per-user via Yjs
    Collaboration.configure({ document: ydoc }),
    CollaborationCursor.configure({ provider, user: { name: me.name, color: me.color } }),
  ] });
  return <EditorContent editor={editor} />;
}` }]
    },
    {
      from: 'room', to: 'log', label: 'append update',
      title: 'Persist before acknowledging',
      caption: 'The room applies the update to its in-memory document and appends the raw bytes to the update log in the same request. Only after the insert commits does it broadcast and acknowledge.',
      text: ['Appending raw updates is cheap and safe: updates are commutative and idempotent, so the log can be replayed in any order and still produce the same document.', 'Writes are grouped: the room flushes all updates received in the last 20 ms in one multi-row INSERT.'],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
INSERT INTO doc_updates (doc_id, seq, client_id, update, created_at)
VALUES ('d_42', 18233, 502811, '\x0101abd61e3c00…'::bytea, now()),
       ('d_42', 18234, 1938402, '\x0101e2a77600…'::bytea, now());   -- batched 20 ms`,
      code: [{ lang: 'python', title: 'Room (pycrdt on FastAPI)', src: String.raw`
from pycrdt import Doc

class Room:
    def __init__(self, doc_id: str):
        self.doc, self.id, self.peers = Doc(), doc_id, set[WebSocket]()
        self.pending: list[tuple[int, bytes]] = []

    async def on_update(self, sender: WebSocket, client_id: int, upd: bytes):
        self.doc.apply_update(upd)                     # merge (commutative, idempotent)
        self.pending.append((client_id, upd))
        await self.flush_soon()                        # batched INSERT every 20 ms
        for ws in self.peers - {sender}:
            await ws.send_bytes(MSG_UPDATE + upd)       # rebroadcast as-is

@app.websocket("/docs/{doc_id}")
async def ws_doc(ws: WebSocket, doc_id: str):
    user = await authorize_ws(ws, doc_id, need="editor")
    room = await rooms.get_or_load(doc_id)              # snapshot + log tail
    await ws.accept(subprotocol="yjs-v1")
    room.peers.add(ws)
    try:
        async for msg in ws.iter_bytes():
            await room.handle(ws, user, msg)            # sync, update or awareness
    finally:
        room.peers.discard(ws)` }],
      failure: ['**Database write fails:** the room does not broadcast and the client keeps the update as pending; the provider resends it on the next sync. Because updates are idempotent, a duplicate is harmless.']
    },
    {
      from: 'room', to: 'gw', label: 'rebroadcast + awareness', reply: true,
      title: 'Other editors receive it; cursors move',
      caption: 'The room forwards the same bytes to every other connected editor. Separately, "awareness" messages carry each person\'s cursor and selection; they are never stored.',
      text: ['Awareness is ephemeral presence: name, colour, cursor position. It is resent every few seconds and expires after 30 s without updates, so a closed laptop\'s cursor disappears.'],
      payloadKind: 'Awareness',
      payload: { type: 'awareness', clients: [{ clientID: 502811, user: { name: 'Ana', color: '#2563eb' }, cursor: { anchor: { client: 502811, clock: 67 }, head: { client: 502811, clock: 67 } } }, { clientID: 1938402, user: { name: 'Chloé', color: '#db2777' }, cursor: { anchor: { client: 1938402, clock: 210 }, head: { client: 1938402, clock: 214 } } }] },
      fields: { cursor: 'Also expressed as character ids, so a cursor stays on the right word while others type above it.' }
    },
    {
      from: 'ben', to: 'ben', label: 'offline edits (IndexedDB)',
      title: 'Ben edits the same sentence while offline',
      caption: 'Ben\'s train enters a tunnel. He keeps typing: he deletes "jumped" and writes "leapt" in the same sentence Ana just edited. His Yjs document stores the updates locally in IndexedDB.',
      text: ['The editor stays fully usable offline. A small banner says "Offline: changes will sync". Nothing is lost if he closes the tab; IndexedDB keeps the updates.'],
      payloadKind: 'Local updates',
      payload: { stored_in: 'IndexedDB: doc-d_42', pending_updates: 3, ops: [{ delete: { client: 1938402, clock: 89, len: 6 }, note: 'deletes "jumped"' }, { insert: { id: { client: 77120, clock: 852 }, origin: { client: 1938402, clock: 88 }, content: 'leapt' } }] }
    },
    {
      from: 'ben', to: 'gw', label: 'reconnect + sync',
      title: 'Ben reconnects: the edits merge',
      caption: 'Back online, Ben\'s provider sends its state vector. Each side sends the other what it lacks. Both inserts referenced the same neighbouring character; Yjs orders them deterministically by client id, so every replica gets the same text.',
      text: ['Result everywhere: "The fox quickly leapt over…". Nobody resolved a conflict by hand, and no replica\'s result depends on which message arrived first.', 'A CRDT guarantees convergence, not intent. If two people rewrite the same sentence differently, both versions\' characters survive in a deterministic order, and a human may still want to tidy it. Version history makes that easy.'],
      payloadKind: 'Merge result',
      payload: { before_ana: 'The fox jumped over the fence.', ana_edit: 'insert "quickly " after "fox "', ben_edit: 'delete "jumped", insert "leapt" after "fox "', concurrent_inserts_after: { client: 1938402, clock: 88 }, ordering_rule: 'YATA: same origin → order by client id (77120 vs 502811)', converged_text: 'The fox quickly leapt over the fence.' },
      fields: { ordering_rule: 'Yjs\'s algorithm (YATA) gives every replica the same total order for concurrent inserts at the same spot.' }
    },
    {
      from: 'compactor', to: 'log', label: 'read 500 updates',
      title: 'Compact the log into a snapshot',
      caption: 'The document now has 500 updates since its last snapshot. The compactor loads the last snapshot, applies the 500 updates, and encodes the whole state as one binary blob.',
      text: ['Without compaction, opening a document with a year of history means replaying a million updates. With it, opening means one snapshot plus at most a few hundred updates.', 'Yjs garbage-collects deleted content in the snapshot (unless history is needed), so the snapshot is often much smaller than the sum of updates.'],
      payloadKind: 'Compaction',
      payload: { doc_id: 'd_42', from_snapshot: 'snap_36', updates_applied: 500, seq_range: [17735, 18234], bytes_in: 21890, snapshot_bytes: 14112, took_ms: 9 }
    },
    {
      from: 'compactor', to: 'snap', label: 'PUT snapshot',
      title: 'Store the snapshot, then trim',
      caption: 'The snapshot is written to S3 and recorded in the database with the last sequence number it covers. Only then are older updates deleted, except those kept for version history.',
      text: ['The order matters: write snapshot, record it, then delete. If the compactor crashes in between, the worst case is a few duplicated updates, which are harmless.'],
      payloadKind: 'SQL',
      payloadLang: 'sql',
      payload: String.raw`
-- after PUT s3://docs-snapshots/d_42/snap_37.ybin succeeds
INSERT INTO doc_snapshots (doc_id, snap_id, upto_seq, s3_key, bytes, created_at)
VALUES ('d_42', 'snap_37', 18234, 'd_42/snap_37.ybin', 14112, now());

DELETE FROM doc_updates WHERE doc_id = 'd_42' AND seq <= 18234
  AND created_at < now() - interval '30 days';    -- keep a month for fine-grained history`
    },
    {
      from: 'snap', to: 'room', label: 'cold open: snapshot + tail',
      title: 'A cold open is fast',
      caption: 'Next morning nobody has d_42 open; its room was unloaded. The first editor triggers a load: the newest snapshot from S3 plus the 12 updates logged after it. Ready in about 40 ms.',
      payloadKind: 'Room load',
      payload: { doc_id: 'd_42', snapshot: 'snap_37 (14 KB)', tail_updates: 12, load_ms: 38, owner: 'room-5 (new lease)' },
      text: ['Rooms with no connected editors are unloaded after 5 minutes, freeing memory for active documents. That is how one node can serve thousands of documents.']
    }
  ],
  api: [
    { verb: 'WS', path: '/docs/{doc_id}', desc: 'Yjs sync protocol: sync-step-1/2, update, awareness messages.' },
    { verb: 'GET', path: '/v1/docs/{doc_id}/versions', desc: 'Named versions and snapshots for history.' },
    { verb: 'POST', path: '/v1/docs/{doc_id}/restore', desc: 'Restore a version as a new update (history is never rewritten).' }
  ],
  schema: String.raw`
CREATE TABLE docs (id TEXT PRIMARY KEY, title TEXT, owner_id TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE doc_updates (
  doc_id TEXT NOT NULL, seq BIGINT NOT NULL, client_id BIGINT NOT NULL,
  update BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, seq)
);
CREATE TABLE doc_snapshots (
  doc_id TEXT NOT NULL, snap_id TEXT NOT NULL, upto_seq BIGINT NOT NULL,
  s3_key TEXT NOT NULL, bytes INT, label TEXT, created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (doc_id, snap_id)
);

-- Redis
-- room:{doc_id}  owner node, PX 10000 (renewed every 3 s)`,
  decisions: [
    { q: 'How do concurrent edits merge?', options: [
      { verdict: 'bad', name: 'Last write wins on the whole document', why: 'Someone\'s work silently disappears.' },
      { verdict: 'good', name: 'Operational transformation (OT) with a central server', why: 'Proven (Google Docs), but needs the server for every merge and is hard to get right offline.' },
      { verdict: 'great', name: 'CRDT (Yjs) with a relay server', why: 'Merges anywhere, in any order, including after long offline periods.' }
    ] },
    { q: 'How do you store the document?', options: [
      { verdict: 'ok', name: 'Save the full document on every change', why: 'Simple but heavy writes and no fine-grained history.' },
      { verdict: 'great', name: 'Append-only update log + periodic snapshots', why: 'Cheap writes, fast opens, history for free.' }
    ] }
  ],
  refs: [
    { label: 'Yjs documentation', url: 'https://docs.yjs.dev/' },
    { label: 'Kleppmann et al.: Local-first software', url: 'https://www.inkandswitch.com/local-first/' },
    { label: 'Yjs on GitHub (implements the YATA algorithm; links the paper)', url: 'https://github.com/yjs/yjs' }
  ]
});
