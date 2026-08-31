/* ============================================================
   FileBeam — Drag-and-Drop P2P File Sharing  v0.3.0
   ============================================================
   Architecture
     • One PeerJS Peer per browser session, created on page load.
       Its broker-assigned ID is the "room". When the page closes
       or the user clicks "Stop sharing", the Peer is destroyed —
       every outstanding share link instantly stops working.
     • Each file the user shares gets a random fileId and lives in
       a Map alongside its (optionally pre-compressed) Blob. The
       share link is:  <location>#share=<peerId>.<fileId>

   ICE / connectivity
     • STUN alone cannot traverse symmetric NAT or most corporate
       firewalls, so a TURN relay is configured by default. The
       bundled credentials are a free best-effort public service —
       bring your own for anything you care about (see NETWORK
       SETTINGS below, or the "Network" panel in the UI).
     • On boot the sender probes ICE and reports whether a relay
       candidate could actually be gathered, so a doomed network
       is visible up front instead of as a mystery failure later.

   Memory / streaming
     • Nothing is buffered whole in the JS heap. Outgoing files are
       gzipped through CompressionStream into a disk-backed Blob,
       and sent by slicing that Blob chunk by chunk.
     • Incoming files are piped straight through
       DecompressionStream into a destination WritableStream. On
       browsers with the File System Access API that destination is
       the user's chosen file on disk, so transfer size is bounded
       by disk, not RAM. Elsewhere we fold chunks into a Blob every
       few MB, which lets the browser spill to disk and keeps the
       heap flat.

   Wire protocol (v2)
     receiver → {type:'request', fileId, proto:2}
     sender   → {type:'file-meta', ...meta}
     receiver → {type:'start'}                 // proto 2 only
     sender   → ArrayBuffer chunks…
     sender   → {type:'file-end', id, size}
     sender   → {type:'reject', reason}        // not-found | no-request | no-start

     A proto-1 receiver omits `proto`, and the sender streams
     immediately after the meta rather than waiting for 'start'.
     A proto-2 receiver tolerates a proto-1 sender by buffering any
     chunks that arrive before its destination is ready.
   ============================================================ */

'use strict';

/* No service worker — keep iteration simple. */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(regs => {
    regs.forEach(reg => reg.unregister());
  });
}
if ('caches' in window) {
  caches.keys().then(names => names.forEach(n => caches.delete(n)));
}

/* DOM */
const $ = (id) => document.getElementById(id);

const screens = {
  share:   $('screen-share'),
  receive: $('screen-receive'),
};

const shareStatus     = $('shareStatus');
const dropzone        = $('dropzone');
const filePicker      = $('filePicker');

const stageInfo       = $('stageInfo');
const stageName       = $('stageName');
const stageSize       = $('stageSize');
const stageBadge      = $('stageBadge');
const stageCompress   = $('stageCompress');
const stageHint       = $('stageHint');
const stageProgress   = $('stageProgress');
const stageFill       = $('stageFill');
const stageText       = $('stageText');
const btnStage        = $('btnStage');
const btnStageCancel  = $('btnStageCancel');

const sharedList      = $('sharedList');
const sharedEmpty     = $('sharedEmpty');
const btnStopAll      = $('btnStopAll');

const netStatus       = $('netStatus');
const netConfig       = $('netConfig');
const btnNetSave      = $('btnNetSave');
const btnNetReset     = $('btnNetReset');
const btnNetTest      = $('btnNetTest');

const recvStatus      = $('recvStatus');
const recvInfo        = $('recvInfo');
const recvName        = $('recvName');
const recvSize        = $('recvSize');
const recvBadge       = $('recvBadge');
const recvFill        = $('recvFill');
const recvText        = $('recvText');
const recvPath        = $('recvPath');
const recvActions     = $('recvActions');
const btnRecvCancel   = $('btnRecvCancel');

/* Constants */
const PROTO             = 2;
const CHUNK_SIZE        = 16 * 1024;       // 16 KB — safe SCTP message size
const BUFFER_HIGH_WATER = 1 * 1024 * 1024; // 1 MB
const BUFFER_LOW_WATER  = 256 * 1024;      // 256 KB
const BLOB_FOLD_BYTES   = 8 * 1024 * 1024; // fold buffered chunks into a Blob every 8 MB
const PREBUFFER_MAX     = 64 * 1024 * 1024;// cap on chunks held while awaiting a destination
const START_TIMEOUT_MS  = 5 * 60 * 1000;   // receiver has this long to pick a save location

/* ── Sender state ───────────────────────────────────────────── */
let peer = null;
let myPeerId = null;
// fileId → { meta, blob, downloads, inFlight, itemEl, dlCountEl }
// `downloads` counts transfers that actually finished; `inFlight` counts the
// ones still streaming, so an aborted download never leaves a false "delivered".
const shared = new Map();

let stagedFile = null;
let stagedDetected = null;

/* ════════════════════════════════════════════════════════════
   NETWORK SETTINGS  (ICE servers + optional self-hosted broker)
   ════════════════════════════════════════════════════════════
   Overridable at runtime via localStorage['filebeam.rtc'] or the
   "Network" panel on the share screen. Shape:

     {
       "iceServers": [
         { "urls": "stun:stun.l.google.com:19302" },
         { "urls": "turn:turn.example.com:3478",
           "username": "user", "credential": "pass" }
       ],
       "forceRelay": false,
       "server": { "host": "peer.example.com", "port": 443,
                   "path": "/", "secure": true, "key": "peerjs" }
     }

   Every field is optional; omitted fields fall back to the
   defaults below. `forceRelay` sets iceTransportPolicy:'relay',
   which is useful for verifying that your TURN server works.
   `server` points PeerJS at your own peerjs-server instead of the
   rate-limited public broker at 0.peerjs.com.
   ════════════════════════════════════════════════════════════ */

const RTC_STORAGE_KEY = 'filebeam.rtc';

/* STUN only by default. These are public binding servers run by Google
   and Cloudflare, verified reachable — they are enough to discover your
   public address, which gets a direct connection on most home networks.

   There is deliberately NO default TURN server. A relay costs real
   bandwidth, so every free public one either dies or rotates its
   credentials, and a hardcoded dead relay is worse than none: it looks
   configured while failing exactly when it is needed. Add your own here
   or through the Network panel — see TURN_EXAMPLE for the shape. */
const DEFAULT_ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/* Shown in the Network panel as a fill-in-the-blanks starting point. */
const TURN_EXAMPLE = {
  urls: ['turn:turn.example.com:3478', 'turns:turn.example.com:5349?transport=tcp'],
  username: 'your-username',
  credential: 'your-password',
};

function loadRtcConfig() {
  let raw = null;
  try { raw = localStorage.getItem(RTC_STORAGE_KEY); } catch (_) { /* private mode */ }
  if (!raw) return { iceServers: DEFAULT_ICE_SERVERS };

  try {
    const parsed = JSON.parse(raw);
    const cfg = {};
    cfg.iceServers = Array.isArray(parsed.iceServers) && parsed.iceServers.length
      ? parsed.iceServers
      : DEFAULT_ICE_SERVERS;
    if (parsed.forceRelay) cfg.forceRelay = true;
    if (parsed.server && typeof parsed.server === 'object') cfg.server = parsed.server;
    return cfg;
  } catch (err) {
    console.warn('[rtc] stored config is not valid JSON — using defaults:', err);
    return { iceServers: DEFAULT_ICE_SERVERS };
  }
}

function saveRtcConfig(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    try { localStorage.removeItem(RTC_STORAGE_KEY); } catch (_) {}
    return { ok: true, cleared: true };
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, error: 'Not valid JSON: ' + err.message };
  }
  if (parsed.iceServers && !Array.isArray(parsed.iceServers)) {
    return { ok: false, error: '"iceServers" must be an array.' };
  }
  try {
    localStorage.setItem(RTC_STORAGE_KEY, JSON.stringify(parsed, null, 2));
  } catch (err) {
    return { ok: false, error: 'Could not save: ' + err.message };
  }
  return { ok: true };
}

/* Options handed to `new Peer()`. */
function peerOptions() {
  const cfg = loadRtcConfig();
  const opts = {
    config: {
      iceServers: cfg.iceServers,
      iceCandidatePoolSize: 2,
      ...(cfg.forceRelay ? { iceTransportPolicy: 'relay' } : {}),
    },
  };
  if (cfg.server) Object.assign(opts, cfg.server);
  return opts;
}

/* Gather candidates against the configured servers to find out, before
   any transfer is attempted, whether a relay is actually reachable. */
async function probeIce(iceServers, timeoutMs = 8000) {
  if (typeof RTCPeerConnection === 'undefined') {
    return { srflx: false, relay: false, error: 'WebRTC unavailable' };
  }
  const found = { srflx: false, relay: false };
  let pc;
  try {
    pc = new RTCPeerConnection({ iceServers });
    pc.createDataChannel('probe');

    const settled = new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return finish();            // gathering complete
        const c = ev.candidate.candidate || '';
        if (c.includes(' typ srflx')) found.srflx = true;
        if (c.includes(' typ relay')) { found.relay = true; finish(); }
      };
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') finish();
      };
      setTimeout(finish, timeoutMs);
    });

    await pc.setLocalDescription(await pc.createOffer());
    await settled;
  } catch (err) {
    found.error = (err && err.message) || String(err);
  } finally {
    if (pc) { try { pc.close(); } catch (_) {} }
  }
  return found;
}

/* Which path did a live connection actually settle on? */
async function selectedPathKind(pc) {
  try {
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((r) => {
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) {
        pair = r;
      }
    });
    if (!pair) return null;
    const local  = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    const types = [local && local.candidateType, remote && remote.candidateType];
    if (types.includes('relay')) return 'relayed via TURN';
    if (types.includes('srflx') || types.includes('prflx')) return 'direct, through NAT';
    return 'direct, local network';
  } catch (_) {
    return null;
  }
}

/* PeerJS creates the RTCPeerConnection lazily, so poll briefly for it. */
function watchIce(conn, { onFailed, onConnected } = {}) {
  let tries = 0;
  const attach = () => {
    const pc = conn && conn.peerConnection;
    if (!pc) {
      if (tries++ < 40) setTimeout(attach, 50);
      return;
    }
    const handler = () => {
      const state = pc.iceConnectionState;
      if (state === 'connected' || state === 'completed') {
        if (onConnected) onConnected(pc);
      } else if (state === 'failed') {
        if (onFailed) onFailed(pc);
      }
    };
    pc.addEventListener('iceconnectionstatechange', handler);
    handler();
  };
  attach();
}

const ICE_FAILURE_HINT =
  'Could not open a direct path to the other peer (ICE failed). ' +
  'This network needs a working TURN relay — open “Network” on the ' +
  'sending page and configure one.';

/* ── Format helpers ─────────────────────────────────────────── */
function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  const units = ['KB','MB','GB','TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + ' ' + units[i];
}

function makeId() {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

/* The name comes from the remote peer — keep it from escaping into a path. */
function safeFileName(name) {
  const base = String(name || 'download.bin').split(/[\\/]/).pop().replace(/^\.+/, '');
  return base.slice(0, 200) || 'download.bin';
}

/* ── Screen helpers ─────────────────────────────────────────── */
function showScreen(name) {
  for (const k of Object.keys(screens)) screens[k].hidden = (k !== name);
}

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = 'status' + (kind ? ' status--' + kind : '');
}

/* ── Compression detection ──────────────────────────────────── */
const COMPRESSED_EXTS = new Set([
  'zip','gz','gzip','bz2','xz','7z','rar','tar','tgz','tbz2','txz','tbz','br','lz','lzma','lz4','zst','zstd',
  'docx','xlsx','pptx','odt','ods','odp','epub','cbz','cbr','jar','war','apk','ipa','nupkg',
  'jpg','jpeg','png','webp','heic','heif','avif','gif',
  'mp3','mp4','m4a','m4v','ogg','opus','flac','webm','avi','mov','mkv','wmv','aac','wma','3gp',
  'pdf',
]);

async function detectCompression(file) {
  let buf;
  try {
    buf = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  } catch (_) {
    buf = new Uint8Array(0);
  }

  const m = (...bytes) => {
    for (let i = 0; i < bytes.length; i++) if (buf[i] !== bytes[i]) return false;
    return true;
  };

  if (m(0x50, 0x4B))                          return { compressed: true, kind: 'zip family' };
  if (m(0x1F, 0x8B))                          return { compressed: true, kind: 'gzip' };
  if (m(0x42, 0x5A, 0x68))                    return { compressed: true, kind: 'bzip2' };
  if (m(0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C)) return { compressed: true, kind: '7z' };
  if (m(0x52, 0x61, 0x72, 0x21, 0x1A, 0x07)) return { compressed: true, kind: 'rar' };
  if (m(0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00)) return { compressed: true, kind: 'xz' };
  if (m(0x28, 0xB5, 0x2F, 0xFD))              return { compressed: true, kind: 'zstd' };
  if (m(0x89, 0x50, 0x4E, 0x47))              return { compressed: true, kind: 'png' };
  if (m(0xFF, 0xD8, 0xFF))                    return { compressed: true, kind: 'jpeg' };
  if (m(0x25, 0x50, 0x44, 0x46))              return { compressed: true, kind: 'pdf' };
  if (m(0x47, 0x49, 0x46, 0x38))              return { compressed: true, kind: 'gif' };
  if (m(0x52, 0x49, 0x46, 0x46) && buf[8] === 0x57 && buf[9] === 0x45)
                                              return { compressed: true, kind: 'webp' };
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70)
                                              return { compressed: true, kind: 'mp4 / m4a' };
  if (m(0x49, 0x44, 0x33))                    return { compressed: true, kind: 'mp3 (id3)' };
  if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0)
                                              return { compressed: true, kind: 'mp3 / aac' };

  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext && COMPRESSED_EXTS.has(ext)) return { compressed: true, kind: '.' + ext };

  return { compressed: false, kind: 'raw' };
}

/* ════════════════════════════════════════════════════════════
   STREAMING PRIMITIVES
   ════════════════════════════════════════════════════════════ */

/* A WritableStream that accumulates into a Blob without ever holding
   the whole payload as JS-heap arrays: every BLOB_FOLD_BYTES the
   buffered views are folded into a Blob part, which the browser is
   free to back with disk. Heap stays ~BLOB_FOLD_BYTES regardless of
   total size. */
function createBlobSink(mime) {
  const parts = [];
  let pending = [];
  let pendingBytes = 0;

  const fold = () => {
    if (!pending.length) return;
    parts.push(new Blob(pending));
    pending = [];
    pendingBytes = 0;
  };

  const writable = new WritableStream({
    write(chunk) {
      const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      pending.push(u8);
      pendingBytes += u8.byteLength;
      if (pendingBytes >= BLOB_FOLD_BYTES) fold();
    },
    close() { fold(); },
    abort() { pending = []; pendingBytes = 0; parts.length = 0; },
  });

  return {
    kind: 'memory',
    writable,
    result() {
      fold();
      return new Blob(parts, { type: mime || 'application/octet-stream' });
    },
  };
}

/* Stream straight to a user-chosen file. Requires a user gesture. */
async function createFileSink(meta) {
  const handle = await window.showSaveFilePicker({
    suggestedName: safeFileName(meta.name),
  });
  const writable = await handle.createWritable();
  return {
    kind: 'disk',
    writable,
    name: handle.name || safeFileName(meta.name),
    result() { return null; }, // already on disk
  };
}

function canSaveToDisk() {
  return typeof window.showSaveFilePicker === 'function' && window.isSecureContext;
}

/* Wraps a destination sink, optionally inserting gunzip in front, and
   exposes a serial write/finish interface. Backpressure propagates
   through the returned promises. */
function createInflatePipeline(sink, compressed) {
  if (!compressed) {
    const writer = sink.writable.getWriter();
    return {
      write: (u8) => writer.write(u8),
      finish: () => writer.close(),
      abort: async (err) => { try { await writer.abort(err); } catch (_) {} },
    };
  }

  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream is not supported in this browser.');
  }
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const piped = ds.readable.pipeTo(sink.writable);
  piped.catch(() => {}); // real handling happens in finish()/abort()

  return {
    write: (u8) => writer.write(u8),
    finish: async () => { await writer.close(); await piped; },
    abort: async (err) => {
      try { await writer.abort(err); } catch (_) {}
      try { await piped; } catch (_) {}
    },
  };
}

/* Counts bytes flowing through a stream, for progress reporting. */
function countingTransform(onBytes) {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      onBytes(seen);
      controller.enqueue(chunk);
    },
  });
}

/* Gzip a Blob without materialising either side in the heap. Returns a
   (likely disk-backed) Blob, so the compressed size is known up front
   and the send path can slice it lazily. */
async function gzipBlobStreaming(blob, onProgress) {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('CompressionStream is not supported in this browser.');
  }
  const sink = createBlobSink('application/gzip');
  const source = blob
    .stream()
    .pipeThrough(countingTransform(onProgress || (() => {})))
    .pipeThrough(new CompressionStream('gzip'));

  await source.pipeTo(sink.writable);
  return sink.result();
}

/* ════════════════════════════════════════════════════════════
   SENDER
   ════════════════════════════════════════════════════════════ */
function startSender() {
  showScreen('share');
  setStatus(shareStatus, 'Connecting to broker…', 'neutral');

  peer = new Peer(peerOptions());

  peer.on('open', (id) => {
    myPeerId = id;
    setStatus(shareStatus, 'Ready. Drop a file to share it.', 'good');
  });

  peer.on('error', (err) => {
    console.warn('[Peer] error:', err);
    if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
      setStatus(shareStatus, 'Network error contacting the broker — check connection.', 'bad');
    } else if (err.type === 'peer-unavailable') {
      // A downloader vanished; the room itself is still fine.
      console.info('[Peer] a downloader went away');
    } else {
      setStatus(shareStatus, 'Peer error: ' + err.type, 'bad');
    }
  });

  peer.on('connection', handleIncomingDownloader);

  bindShareUi();
  bindNetworkUi();
  runIceProbe();
}

function bindShareUi() {
  filePicker.addEventListener('change', (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (f) onFileStaged(f);
  });

  ['dragenter','dragover'].forEach(name => {
    dropzone.addEventListener(name, (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      dropzone.classList.add('dropzone--drag');
    });
  });
  ['dragleave','drop'].forEach(name => {
    dropzone.addEventListener(name, (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      dropzone.classList.remove('dropzone--drag');
    });
  });
  dropzone.addEventListener('drop', (ev) => {
    const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (f) onFileStaged(f);
  });

  // Also accept files dropped anywhere on the page (so the dropzone itself
  // doesn't have to be perfectly targeted).
  ['dragover','drop'].forEach(name => {
    document.addEventListener(name, (ev) => ev.preventDefault());
  });

  btnStageCancel.addEventListener('click', clearStage);
  btnStage.addEventListener('click', shareStagedFile);
  btnStopAll.addEventListener('click', stopSharing);
}

/* ── Network panel ──────────────────────────────────────────── */
function bindNetworkUi() {
  let stored = null;
  try { stored = localStorage.getItem(RTC_STORAGE_KEY); } catch (_) {}
  // Seed the box with the defaults plus a TURN stub to edit in place.
  netConfig.value = stored || JSON.stringify(
    { iceServers: [...DEFAULT_ICE_SERVERS, TURN_EXAMPLE] }, null, 2);

  btnNetSave.addEventListener('click', () => {
    const res = saveRtcConfig(netConfig.value);
    if (!res.ok) {
      setStatus(netStatus, res.error, 'bad');
      return;
    }
    setStatus(netStatus,
      (res.cleared ? 'Cleared — using defaults. ' : 'Saved. ') +
      'Reload the page to apply to the current room.',
      'warn');
  });

  btnNetReset.addEventListener('click', () => {
    try { localStorage.removeItem(RTC_STORAGE_KEY); } catch (_) {}
    netConfig.value = JSON.stringify(
      { iceServers: [...DEFAULT_ICE_SERVERS, TURN_EXAMPLE] }, null, 2);
    setStatus(netStatus, 'Reset to defaults. Reload the page to apply.', 'warn');
  });

  btnNetTest.addEventListener('click', () => runIceProbe(true));
}

async function runIceProbe(manual) {
  const cfg = loadRtcConfig();
  setStatus(netStatus, 'Testing STUN/TURN reachability…', 'neutral');

  const res = await probeIce(cfg.iceServers);

  const configuredTurn = JSON.stringify(cfg.iceServers || []).match(/turns?:/) !== null;

  if (res.error) {
    setStatus(netStatus, 'ICE probe failed: ' + res.error, 'bad');
  } else if (res.relay) {
    setStatus(netStatus,
      'TURN relay reachable — transfers should work even on restrictive networks.',
      'good');
  } else if (res.srflx && !configuredTurn) {
    setStatus(netStatus,
      'STUN works, no TURN configured. Direct connections succeed on most home ' +
      'networks but fail behind symmetric NAT (many mobile and corporate ' +
      'networks). Add a TURN server below to cover those.',
      'warn');
  } else if (res.srflx) {
    setStatus(netStatus,
      'STUN works, but your configured TURN server did not answer — check the ' +
      'host, port and credentials below.',
      'bad');
  } else {
    setStatus(netStatus,
      'No STUN or TURN candidates could be gathered. You may be offline or ' +
      'behind a firewall that blocks WebRTC entirely.',
      'bad');
  }

  if (!manual && !res.relay && !res.error) {
    console.warn('[ice] no relay candidate — symmetric-NAT peers will fail to connect');
  }
}

/* ── Staging ────────────────────────────────────────────────── */
let stageToken = 0;

async function onFileStaged(file) {
  const token = ++stageToken;   // guards against an out-of-order detect resolving late

  stagedFile = file;
  stagedDetected = null;
  stageInfo.hidden = false;
  stageProgress.hidden = true;
  stageName.textContent = file.name;
  stageSize.textContent = fmtBytes(file.size);
  stageBadge.textContent = 'checking…';
  stageBadge.className = 'badge';
  stageCompress.checked = false;
  stageCompress.disabled = true;
  stageHint.textContent = 'Detecting file type…';

  const detected = await detectCompression(file);
  if (token !== stageToken) return;   // a newer file was staged meanwhile

  stagedDetected = detected;

  if (detected.compressed) {
    stageBadge.textContent = 'Already compressed · ' + detected.kind;
    stageBadge.className = 'badge badge--compressed';
    stageCompress.checked = false;
    stageCompress.disabled = false;
    stageHint.textContent =
      'This file looks already compressed (' + detected.kind +
      '). Re-compressing usually wastes time. Skip it unless you know better.';
  } else {
    stageBadge.textContent = 'Raw / uncompressed';
    stageBadge.className = 'badge badge--raw';
    stageCompress.checked = true;
    stageCompress.disabled = false;
    stageHint.textContent =
      'This file is not in a compressed format. Sharing it through gzip will likely shrink it.';
  }
}

function clearStage() {
  stageToken++;
  stagedFile = null;
  stagedDetected = null;
  filePicker.value = '';
  stageInfo.hidden = true;
  stageProgress.hidden = true;
  stageFill.style.width = '0%';
}

async function shareStagedFile() {
  if (!stagedFile) return;
  if (!myPeerId) {
    setStatus(shareStatus, 'Not connected to broker yet — try again in a moment.', 'bad');
    return;
  }

  if (!stageCompress.checked && stagedDetected && !stagedDetected.compressed) {
    const ok = window.confirm(
      'This file is not in a compressed format. Share it without gzip?\n\n' +
      'Tip: cancel and toggle "Compress with gzip" to shrink it.'
    );
    if (!ok) return;
  }

  const file = stagedFile;
  btnStage.disabled = true;
  try {
    let blob = file;
    let compressed = false;

    if (stageCompress.checked) {
      setStatus(shareStatus, 'Compressing…', 'neutral');
      stageProgress.hidden = false;
      stageFill.style.width = '0%';
      stageText.textContent = '0%';

      blob = await gzipBlobStreaming(file, (readBytes) => {
        const pct = file.size ? Math.min(100, (readBytes / file.size) * 100) : 0;
        stageFill.style.width = pct.toFixed(1) + '%';
        stageText.textContent =
          pct.toFixed(1) + '% · ' + fmtBytes(readBytes) + ' / ' + fmtBytes(file.size);
      });

      compressed = true;
      stageProgress.hidden = true;
    }

    const fileId = makeId();
    const meta = {
      id: fileId,
      name: safeFileName(file.name),
      mime: file.type || 'application/octet-stream',
      size: blob.size,
      originalSize: file.size,
      compressed,
    };
    addToShared({ meta, blob });
    setStatus(shareStatus, 'Sharing — copy the link below to invite a downloader.', 'good');
    clearStage();
  } catch (err) {
    console.error(err);
    stageProgress.hidden = true;
    setStatus(shareStatus, 'Failed: ' + (err && err.message ? err.message : err), 'bad');
  } finally {
    btnStage.disabled = false;
  }
}

function makeShareLink(fileId) {
  const url = new URL(location.href);
  url.hash = 'share=' + encodeURIComponent(myPeerId) + '.' + encodeURIComponent(fileId);
  return url.toString();
}

function addToShared({ meta, blob }) {
  const link = makeShareLink(meta.id);
  const els = renderSharedItem(meta, link);
  const entry = {
    meta, blob, downloads: 0, inFlight: 0,
    itemEl: els.root,
    dlCountEl: els.downloads,
  };
  shared.set(meta.id, entry);
  renderDownloadState(entry);
  sharedEmpty.hidden = true;
}

function renderSharedItem(meta, link) {
  const root = document.createElement('div');
  root.className = 'recv-item';

  const row1 = document.createElement('div');
  row1.className = 'recv-item__row';
  const name = document.createElement('span');
  name.className = 'recv-item__name';
  name.textContent = meta.name;
  const size = document.createElement('span');
  size.className = 'recv-item__size';
  size.textContent = fmtBytes(meta.size);
  row1.appendChild(name);
  row1.appendChild(size);

  const row2 = document.createElement('div');
  row2.className = 'recv-item__row';
  const badge = document.createElement('span');
  badge.className = 'badge ' + (meta.compressed ? 'badge--compressed' : 'badge--raw');
  badge.textContent = meta.compressed
    ? 'gzipped · was ' + fmtBytes(meta.originalSize)
    : 'raw';
  const downloads = document.createElement('span');
  downloads.className = 'recv-item__downloads';
  downloads.textContent = 'not downloaded yet';
  downloads.setAttribute('aria-live', 'polite');
  row2.appendChild(badge);
  row2.appendChild(downloads);

  const linkInput = document.createElement('input');
  linkInput.type = 'text';
  linkInput.readOnly = true;
  linkInput.className = 'share-link';
  linkInput.value = link;
  linkInput.addEventListener('focus', () => linkInput.select());

  const actions = document.createElement('div');
  actions.className = 'recv-item__row recv-item__actions';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'recv-item__download';
  copyBtn.textContent = 'Copy link';
  copyBtn.addEventListener('click', () => copyLink(link, copyBtn));

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'recv-item__remove';
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', () => removeShared(meta.id));

  /* Folded away by default: copying the link is still the main move,
     the QR is for the phone standing next to the laptop. */
  const qrPanel = document.createElement('div');
  qrPanel.className = 'qr-panel';
  qrPanel.hidden = true;

  const qrBtn = document.createElement('button');
  qrBtn.type = 'button';
  qrBtn.className = 'recv-item__qr';
  qrBtn.textContent = 'QR';
  qrBtn.title = 'Show this link as a QR code';
  qrBtn.setAttribute('aria-expanded', 'false');
  qrBtn.addEventListener('click', () => toggleQr(qrBtn, qrPanel, link));

  actions.appendChild(removeBtn);
  actions.appendChild(qrBtn);
  actions.appendChild(copyBtn);

  root.appendChild(row1);
  root.appendChild(row2);
  root.appendChild(linkInput);
  root.appendChild(actions);
  root.appendChild(qrPanel);
  sharedList.appendChild(root);

  return { root, downloads };
}

/* Drawn on first reveal only — most links get copied, never scanned. */
function toggleQr(btn, panel, link) {
  const show = panel.hidden;

  if (show && !panel.dataset.drawn) {
    panel.dataset.drawn = '1';
    const caption = document.createElement('p');
    caption.className = 'qr-panel__caption';
    try {
      const img = document.createElement('img');
      img.className = 'qr-panel__img';
      img.alt = 'QR code for this share link';
      img.src = QR.toDataUrl(link);
      panel.appendChild(img);
      caption.textContent = 'Scan with the receiving device';
    } catch (err) {
      console.error(err);
      caption.textContent = 'This link is too long to draw as a QR code.';
    }
    panel.appendChild(caption);
  }

  panel.hidden = !show;
  btn.setAttribute('aria-expanded', String(show));
}

function copyLink(link, btn) {
  const restore = (text) => {
    const orig = btn.dataset.label || 'Copy link';
    btn.textContent = text;
    setTimeout(() => { btn.textContent = orig; }, 1500);
  };
  btn.dataset.label = btn.dataset.label || btn.textContent;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link)
      .then(() => restore('Copied!'))
      .catch(() => restore('Copy failed'));
  } else {
    restore('Copy unavailable');
  }
}

function removeShared(fileId) {
  const entry = shared.get(fileId);
  if (!entry) return;
  if (entry.itemEl && entry.itemEl.parentNode) {
    entry.itemEl.parentNode.removeChild(entry.itemEl);
  }
  shared.delete(fileId);
  if (shared.size === 0) sharedEmpty.hidden = false;
}

/* Paint the "has anyone actually taken this?" state onto a shared item.
   A plain `downloads: 0 → 1` counter was too easy to miss, so a delivered
   file also gets a stamped counter and a coloured rail down its left edge. */
function renderDownloadState(entry) {
  const el = entry.dlCountEl;
  const done = entry.downloads;
  if (el) {
    const parts = [];
    if (done > 0) parts.push('✓ downloaded ' + done + '×');
    else if (!entry.inFlight) parts.push('not downloaded yet');
    if (entry.inFlight) parts.push('sending…');
    el.textContent = parts.join(' · ');
  }
  const root = entry.itemEl;
  if (root && root.classList) {
    root.classList.toggle('recv-item--claimed', done > 0);
    root.classList.toggle('recv-item--sending', entry.inFlight > 0);
  }
}

function markSending(entry) {
  entry.inFlight++;
  renderDownloadState(entry);
}

function markSendFinished(entry, delivered) {
  entry.inFlight = Math.max(0, entry.inFlight - 1);
  if (delivered) entry.downloads++;
  renderDownloadState(entry);
  if (!delivered || !entry.itemEl || !entry.itemEl.classList) return;
  // One-shot flash so a completed pickup is noticeable while you watch.
  entry.itemEl.classList.remove('recv-item--just-hit');
  void (entry.itemEl.offsetWidth);            // restart the animation
  entry.itemEl.classList.add('recv-item--just-hit');
  setTimeout(() => {
    if (entry.itemEl && entry.itemEl.classList) {
      entry.itemEl.classList.remove('recv-item--just-hit');
    }
  }, 1200);
}

function stopSharing() {
  if (peer) { try { peer.destroy(); } catch (_) {} peer = null; }
  myPeerId = null;
  for (const entry of shared.values()) {
    if (entry.itemEl && entry.itemEl.parentNode) {
      entry.itemEl.parentNode.removeChild(entry.itemEl);
    }
  }
  shared.clear();
  sharedEmpty.hidden = false;
  clearStage();
  setStatus(shareStatus,
    'Stopped sharing. All links are now dead. Reload the page to start a new room.',
    'warn');
  btnStopAll.disabled = true;
}

// Browser tear-down → links die.
window.addEventListener('beforeunload', () => {
  if (peer) { try { peer.destroy(); } catch (_) {} }
});

/* ── Sender: handle a downloader connecting in ──────────────── */
function handleIncomingDownloader(conn) {
  console.log('[Host] incoming downloader from', conn.peer);
  let requestTimer = null;
  let startTimer = null;
  let entry = null;
  let streaming = false;

  const clearTimers = () => {
    if (requestTimer) { clearTimeout(requestTimer); requestTimer = null; }
    if (startTimer)   { clearTimeout(startTimer);   startTimer = null; }
  };

  watchIce(conn, {
    onFailed: () => console.warn('[Host] ICE failed for', conn.peer),
    onConnected: async (pc) => {
      const kind = await selectedPathKind(pc);
      if (kind) console.log('[Host] path to', conn.peer + ':', kind);
    },
  });

  conn.on('open', () => {
    requestTimer = setTimeout(() => {
      if (!entry && conn.open) {
        try { conn.send({ type: 'reject', reason: 'no-request' }); } catch (_) {}
        try { conn.close(); } catch (_) {}
      }
    }, 5000);
  });

  const beginStream = async () => {
    if (streaming || !entry) return;
    streaming = true;
    clearTimers();
    markSending(entry);
    try {
      await sendBlobChunks(conn, entry.blob);
      if (conn.open) conn.send({ type: 'file-end', id: entry.meta.id, size: entry.meta.size });
      await drainAndClose(conn);
      markSendFinished(entry, true);
    } catch (err) {
      console.warn('[Host] send failed:', err);
      markSendFinished(entry, false);
      try { conn.close(); } catch (_) {}
    }
  };

  conn.on('data', async (msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'start') {
      await beginStream();
      return;
    }

    if (msg.type !== 'request' || entry) return;
    if (requestTimer) { clearTimeout(requestTimer); requestTimer = null; }

    entry = shared.get(msg.fileId);
    if (!entry) {
      try { conn.send({ type: 'reject', reason: 'not-found' }); } catch (_) {}
      setTimeout(() => { try { conn.close(); } catch (_) {} }, 200);
      return;
    }

    try {
      conn.send({ type: 'file-meta', ...entry.meta });
    } catch (err) {
      console.warn('[Host] could not send meta:', err);
      return;
    }

    if (Number(msg.proto) >= 2) {
      // Receiver will pick a destination (possibly via a save dialog) and
      // then ask us to start. Give it room, but not forever.
      startTimer = setTimeout(() => {
        if (!streaming && conn.open) {
          try { conn.send({ type: 'reject', reason: 'no-start' }); } catch (_) {}
          try { conn.close(); } catch (_) {}
        }
      }, START_TIMEOUT_MS);
    } else {
      await beginStream();   // legacy receiver: stream immediately
    }
  });

  conn.on('close', clearTimers);
  conn.on('error', (e) => { clearTimers(); console.warn('[Host conn] error:', e); });
}

async function sendBlobChunks(conn, blob) {
  const total = blob.size;
  let offset = 0;
  let sinceYield = 0;
  const dc = conn && conn.dataChannel ? conn.dataChannel : null;
  if (dc) { try { dc.bufferedAmountLowThreshold = BUFFER_LOW_WATER; } catch (_) {} }

  while (offset < total) {
    if (!conn.open) throw new Error('downloader disconnected');
    const end = Math.min(offset + CHUNK_SIZE, total);
    // Slicing the Blob reads lazily from wherever the browser stored it,
    // so only one chunk is in the heap at a time.
    const buf = await blob.slice(offset, end).arrayBuffer();
    conn.send(buf);
    offset = end;
    sinceYield++;

    if (dc && dc.bufferedAmount > BUFFER_HIGH_WATER) {
      sinceYield = 0;
      await new Promise((resolve) => {
        const handler = () => { dc.removeEventListener('bufferedamountlow', handler); resolve(); };
        dc.addEventListener('bufferedamountlow', handler);
        setTimeout(() => { dc.removeEventListener('bufferedamountlow', handler); resolve(); }, 1000);
      });
    } else if (sinceYield >= 32) {
      sinceYield = 0;
      await new Promise(r => setTimeout(r, 0));
    }
  }
}

async function drainAndClose(conn) {
  const dc = conn && conn.dataChannel ? conn.dataChannel : null;
  if (dc) {
    let waited = 0;
    while (dc.bufferedAmount > 0 && waited < 15000) {
      await new Promise(r => setTimeout(r, 50));
      waited += 50;
    }
  }
  setTimeout(() => { try { conn.close(); } catch (_) {} }, 200);
}

/* ════════════════════════════════════════════════════════════
   RECEIVER
   ════════════════════════════════════════════════════════════ */
function startReceiver(senderPeerId, fileId) {
  showScreen('receive');
  setStatus(recvStatus, 'Connecting to broker…', 'neutral');

  const recvPeer = new Peer(peerOptions());
  let conn = null;
  let meta = null;

  let pipeline = null;         // set once a destination is chosen
  let sinkKind = null;         // 'disk' | 'memory'
  let activeSink = null;
  let preBuffer = [];          // chunks that arrived before the destination existed
  let preBufferBytes = 0;
  let received = 0;            // wire bytes
  let started = false;
  let done = false;
  let failed = false;
  let objectUrl = null;

  /* Two independent facts share the note line — the ICE path (set whenever
     the connection settles) and the destination (set at file-meta). Compose
     them instead of letting whichever fires last win. */
  let pathNote = '';
  let destNote = '';
  const renderNotes = () => {
    recvPath.textContent = [pathNote, destNote].filter(Boolean).join(' · ');
  };

  /* PeerJS emits 'data' synchronously; an async handler would interleave
     and write chunks out of order. Everything funnels through this chain. */
  let chain = Promise.resolve();
  const serial = (fn) => {
    chain = chain.then(fn).catch((err) => {
      if (failed) return;
      failed = true;
      console.error('[Recv] pipeline error:', err);
      setStatus(recvStatus, 'Transfer failed: ' + (err && err.message ? err.message : err), 'bad');
      if (pipeline) pipeline.abort(err);
      try { recvPeer.destroy(); } catch (_) {}
    });
    return chain;
  };

  const cleanupUrl = () => {
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  };
  window.addEventListener('beforeunload', cleanupUrl);

  /* ── Destination selection ── */
  async function useDestination(sink) {
    activeSink = sink;
    sinkKind = sink.kind;
    pipeline = createInflatePipeline(sink, !!(meta && meta.compressed));

    // Flush anything that raced ahead of us (legacy sender).
    const queued = preBuffer;
    preBuffer = [];
    preBufferBytes = 0;
    for (const u8 of queued) await pipeline.write(u8);

    if (!started) {
      started = true;
      try { conn.send({ type: 'start' }); } catch (e) { console.warn(e); }
    }
    setStatus(recvStatus,
      sinkKind === 'disk' ? 'Receiving — writing straight to disk…' : 'Receiving…',
      'neutral');
    destNote = sinkKind === 'disk'
      ? 'Streaming to “' + sink.name + '” — memory use stays flat'
      : 'Buffering in memory';
    renderNotes();
  }

  async function chooseDisk() {
    try {
      const sink = await createFileSink(meta);
      recvActions.innerHTML = '';
      await useDestination(sink);
    } catch (err) {
      if (err && err.name === 'AbortError') {
        setStatus(recvStatus, 'Save cancelled — pick a destination to start the transfer.', 'warn');
        return;
      }
      console.warn('[Recv] save picker failed:', err);
      setStatus(recvStatus, 'Could not open the save dialog — falling back to memory.', 'warn');
      recvActions.innerHTML = '';
      await useDestination(createBlobSink(meta && meta.mime));
    }
  }

  async function chooseMemory() {
    recvActions.innerHTML = '';
    await useDestination(createBlobSink(meta && meta.mime));
  }

  function offerDestinationChoice() {
    recvActions.innerHTML = '';

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn--primary';
    save.textContent = 'Save to disk…';
    save.addEventListener('click', () => serial(chooseDisk));

    const mem = document.createElement('button');
    mem.type = 'button';
    mem.className = 'btn btn--ghost';
    mem.textContent = 'Keep in memory';
    mem.addEventListener('click', () => serial(chooseMemory));

    recvActions.appendChild(save);
    recvActions.appendChild(mem);

    setStatus(recvStatus,
      'Ready. “Save to disk” streams the file straight to storage — the only ' +
      'option that works for files larger than available memory.',
      'good');
    destNote = '“Keep in memory” holds the whole file in the tab until you download it';
    renderNotes();
  }

  /* ── Completion ── */
  async function complete() {
    if (meta && received !== meta.size) {
      throw new Error(
        'Truncated transfer — expected ' + fmtBytes(meta.size) +
        ' but got ' + fmtBytes(received) + '.'
      );
    }
    if (meta && meta.compressed) setStatus(recvStatus, 'Decompressing…', 'neutral');

    await pipeline.finish();
    done = true;

    recvFill.style.width = '100%';

    if (sinkKind === 'disk') {
      recvText.textContent = 'Saved · ' + fmtBytes(received) + ' received';
      setStatus(recvStatus, 'Done. Saved to “' + activeSink.name + '”.', 'good');
      recvActions.innerHTML = '';
    } else {
      const blob = activeSink.result();
      recvText.textContent = 'Received · ' + fmtBytes(blob.size);
      setStatus(recvStatus, 'Done. Tap to download.', 'good');
      recvActions.innerHTML = '';
      cleanupUrl();
      objectUrl = URL.createObjectURL(blob);
      const dl = document.createElement('a');
      dl.className = 'btn btn--primary';
      dl.href = objectUrl;
      dl.download = safeFileName(meta && meta.name);
      dl.textContent = 'Download';
      recvActions.appendChild(dl);
    }

    try { recvPeer.destroy(); } catch (_) {}
  }

  /* ── Peer wiring ── */
  recvPeer.on('open', () => {
    setStatus(recvStatus, 'Reaching sender…', 'neutral');
    conn = recvPeer.connect(senderPeerId, { reliable: true });

    watchIce(conn, {
      onFailed: () => {
        if (done) return;
        failed = true;
        setStatus(recvStatus, ICE_FAILURE_HINT, 'bad');
      },
      onConnected: async (pc) => {
        const kind = await selectedPathKind(pc);
        if (kind && !done) { pathNote = 'Connection: ' + kind; renderNotes(); }
      },
    });

    conn.on('open', () => {
      setStatus(recvStatus, 'Requesting file…', 'neutral');
      try { conn.send({ type: 'request', fileId, proto: PROTO }); } catch (e) { console.warn(e); }
    });

    conn.on('data', (msg) => {
      /* Binary: a file chunk. */
      let u8 = null;
      if (msg instanceof ArrayBuffer) {
        u8 = new Uint8Array(msg);
      } else if (ArrayBuffer.isView(msg)) {
        u8 = new Uint8Array(msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength));
      }

      if (u8) {
        received += u8.byteLength;
        updateRecvProgress(received, meta && meta.size);
        serial(async () => {
          if (pipeline) return pipeline.write(u8);
          // Legacy sender streaming before we picked a destination.
          preBufferBytes += u8.byteLength;
          if (preBufferBytes > PREBUFFER_MAX) {
            throw new Error('Sender started streaming before a destination was chosen.');
          }
          preBuffer.push(u8);
        });
        return;
      }

      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'reject') {
        const reason = ({
          'not-found':  'This share link no longer exists. The sender may have removed the file or left the room.',
          'no-request': 'Sender timed out waiting for our request.',
          'no-start':   'Sender timed out waiting for us to choose a save location.',
        })[msg.reason] || ('Rejected: ' + msg.reason);
        setStatus(recvStatus, reason, 'bad');
        failed = true;
        try { recvPeer.destroy(); } catch (_) {}
        return;
      }

      if (msg.type === 'file-meta') {
        meta = msg;
        recvInfo.hidden = false;
        recvName.textContent = safeFileName(meta.name);
        recvSize.textContent = fmtBytes(meta.originalSize || meta.size);
        recvBadge.textContent = meta.compressed
          ? 'gzipped on the wire (' + fmtBytes(meta.size) + ')'
          : 'raw';
        recvBadge.className = 'badge ' + (meta.compressed ? 'badge--compressed' : 'badge--raw');

        if (canSaveToDisk()) {
          // showSaveFilePicker needs a user gesture, so ask before starting.
          offerDestinationChoice();
        } else {
          destNote = 'This browser cannot stream to disk (no File System Access ' +
                     'API), so the file is held in memory until you download it';
          renderNotes();
          serial(chooseMemory);
        }
        return;
      }

      if (msg.type === 'file-end') {
        serial(complete);
      }
    });

    conn.on('close', () => {
      if (!done && !failed) {
        failed = true;
        setStatus(recvStatus, 'Sender closed the connection before transfer finished.', 'bad');
        if (pipeline) pipeline.abort(new Error('connection closed'));
      }
    });
    conn.on('error', (e) => {
      console.warn('[Recv conn] error:', e);
    });
  });

  recvPeer.on('error', (err) => {
    console.warn('[Recv peer] error:', err);
    if (done) return;
    if (err.type === 'peer-unavailable') {
      setStatus(recvStatus,
        'Sender is offline. The link has expired (the sender closed the page or stopped sharing).',
        'bad');
    } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
      setStatus(recvStatus, 'Network error contacting the broker — check connection.', 'bad');
    } else {
      setStatus(recvStatus, 'Peer error: ' + err.type, 'bad');
    }
  });

  btnRecvCancel.addEventListener('click', () => {
    if (done) return;
    failed = true;
    try { recvPeer.destroy(); } catch (_) {}
    if (pipeline) pipeline.abort(new Error('cancelled'));
    cleanupUrl();
    setStatus(recvStatus, 'Cancelled.', 'warn');
    recvActions.innerHTML = '';
  });
}

function updateRecvProgress(received, total) {
  if (!total) {
    recvText.textContent = fmtBytes(received) + ' received…';
    return;
  }
  const pct = Math.min(100, (received / total) * 100);
  recvFill.style.width = pct.toFixed(1) + '%';
  recvText.textContent =
    pct.toFixed(1) + '% · ' + fmtBytes(received) + ' / ' + fmtBytes(total);
}

/* ════════════════════════════════════════════════════════════
   Boot
   ════════════════════════════════════════════════════════════ */
function parseShareHash() {
  const params = new URLSearchParams((location.hash || '').replace(/^#/, ''));
  const share = params.get('share');
  if (!share) return null;
  const dot = share.lastIndexOf('.');
  if (dot <= 0 || dot === share.length - 1) return null;
  return {
    peerId: decodeURIComponent(share.slice(0, dot)),
    fileId: decodeURIComponent(share.slice(dot + 1)),
  };
}

window.addEventListener('DOMContentLoaded', () => {
  if (typeof Peer === 'undefined') {
    showScreen('share');
    setStatus(shareStatus, 'PeerJS failed to load — check your connection and reload.', 'bad');
    return;
  }
  if (typeof CompressionStream === 'undefined') {
    console.warn('CompressionStream not supported — gzip option will fail.');
  }

  const target = parseShareHash();
  if (target) {
    startReceiver(target.peerId, target.fileId);
  } else {
    startSender();
  }
});
