/* ============================================================
   FileBeam — Drag-and-Drop P2P File Sharing  v0.2.0
   ============================================================
   Architecture
     • One PeerJS Peer per browser session, created on page load.
       Its broker-assigned ID is the "room". When the page closes
       or the user clicks "Stop sharing", the Peer is destroyed —
       every outstanding share link instantly stops working.
     • Each file the user shares gets a random fileId and lives in
       a Map alongside its (optionally pre-compressed) Blob. The
       share link is:  <location>#share=<peerId>.<fileId>
     • Receiver flow: open the link → fresh Peer → connect to the
       sender's peerId → send {type:'request', fileId}. Sender
       replies with {type:'file-meta'} + ArrayBuffer chunks +
       {type:'file-end'}. Unknown fileId → {type:'reject',
       reason:'not-found'}.
     • Compression: magic-byte + extension detection. If the file
       isn't already compressed, the gzip toggle defaults ON. The
       Blob is gzipped at "Share" time using CompressionStream so
       the wire size on the link is accurate; receiver inflates
       with DecompressionStream.
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
const btnStage        = $('btnStage');
const btnStageCancel  = $('btnStageCancel');

const sharedList      = $('sharedList');
const sharedEmpty     = $('sharedEmpty');
const btnStopAll      = $('btnStopAll');

const recvStatus      = $('recvStatus');
const recvInfo        = $('recvInfo');
const recvName        = $('recvName');
const recvSize        = $('recvSize');
const recvBadge       = $('recvBadge');
const recvFill        = $('recvFill');
const recvText        = $('recvText');
const recvActions     = $('recvActions');
const btnRecvCancel   = $('btnRecvCancel');

/* Constants */
const CHUNK_SIZE        = 16 * 1024;       // 16 KB — safe SCTP message size
const BUFFER_HIGH_WATER = 1 * 1024 * 1024; // 1 MB
const BUFFER_LOW_WATER  = 256 * 1024;      // 256 KB

/* ── Sender state ───────────────────────────────────────────── */
let peer = null;
let myPeerId = null;
const shared = new Map(); // fileId → { meta, blob, downloads, itemEl, dlCountEl }

let stagedFile = null;
let stagedDetected = null;

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

async function gzipBlob(blob) {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('CompressionStream is not supported in this browser.');
  }
  const cs = new CompressionStream('gzip');
  return await new Response(blob.stream().pipeThrough(cs)).blob();
}

async function gunzipBlob(blob) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream is not supported in this browser.');
  }
  const ds = new DecompressionStream('gzip');
  return await new Response(blob.stream().pipeThrough(ds)).blob();
}

/* ════════════════════════════════════════════════════════════
   SENDER
   ════════════════════════════════════════════════════════════ */
function startSender() {
  showScreen('share');
  setStatus(shareStatus, 'Connecting to broker…', 'neutral');

  peer = new Peer();

  peer.on('open', (id) => {
    myPeerId = id;
    setStatus(shareStatus, 'Ready. Drop a file to share it.', 'good');
  });

  peer.on('error', (err) => {
    console.warn('[Peer] error:', err);
    if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
      setStatus(shareStatus, 'Network error contacting the broker — check connection.', 'bad');
    } else {
      setStatus(shareStatus, 'Peer error: ' + err.type, 'bad');
    }
  });

  peer.on('connection', handleIncomingDownloader);

  bindShareUi();
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

async function onFileStaged(file) {
  stagedFile = file;
  stageInfo.hidden = false;
  stageName.textContent = file.name;
  stageSize.textContent = fmtBytes(file.size);
  stageBadge.textContent = 'checking…';
  stageBadge.className = 'badge';
  stageCompress.checked = false;
  stageCompress.disabled = true;
  stageHint.textContent = 'Detecting file type…';

  const detected = await detectCompression(file);
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
  stagedFile = null;
  stagedDetected = null;
  filePicker.value = '';
  stageInfo.hidden = true;
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

  btnStage.disabled = true;
  try {
    let blob = stagedFile;
    let compressed = false;
    if (stageCompress.checked) {
      setStatus(shareStatus, 'Compressing…', 'neutral');
      blob = await gzipBlob(stagedFile);
      compressed = true;
    }
    const fileId = makeId();
    const meta = {
      id: fileId,
      name: stagedFile.name,
      mime: stagedFile.type || 'application/octet-stream',
      size: blob.size,
      originalSize: stagedFile.size,
      compressed,
    };
    addToShared({ meta, blob });
    setStatus(shareStatus, 'Sharing — copy the link below to invite a downloader.', 'good');
    clearStage();
  } catch (err) {
    console.error(err);
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
  shared.set(meta.id, {
    meta, blob, downloads: 0,
    itemEl: els.root,
    dlCountEl: els.downloads,
  });
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
  downloads.textContent = 'downloads: 0';
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

  actions.appendChild(removeBtn);
  actions.appendChild(copyBtn);

  root.appendChild(row1);
  root.appendChild(row2);
  root.appendChild(linkInput);
  root.appendChild(actions);
  sharedList.appendChild(root);

  return { root, downloads };
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

function bumpDownloads(entry) {
  entry.downloads++;
  if (entry.dlCountEl) entry.dlCountEl.textContent = 'downloads: ' + entry.downloads;
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
  let entry = null;

  conn.on('open', () => {
    requestTimer = setTimeout(() => {
      if (!entry && conn.open) {
        try { conn.send({ type: 'reject', reason: 'no-request' }); } catch (_) {}
        try { conn.close(); } catch (_) {}
      }
    }, 5000);
  });

  conn.on('data', async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type !== 'request' || entry) return;

    if (requestTimer) { clearTimeout(requestTimer); requestTimer = null; }

    entry = shared.get(msg.fileId);
    if (!entry) {
      try { conn.send({ type: 'reject', reason: 'not-found' }); } catch (_) {}
      setTimeout(() => { try { conn.close(); } catch (_) {} }, 200);
      return;
    }

    bumpDownloads(entry);
    try {
      conn.send({ type: 'file-meta', ...entry.meta });
      await sendBlobChunks(conn, entry.blob);
      if (conn.open) conn.send({ type: 'file-end', id: entry.meta.id });
      await drainAndClose(conn);
    } catch (err) {
      console.warn('[Host] send failed:', err);
      try { conn.close(); } catch (_) {}
    }
  });

  conn.on('close', () => {
    if (requestTimer) { clearTimeout(requestTimer); requestTimer = null; }
  });
  conn.on('error', (e) => console.warn('[Host conn] error:', e));
}

async function sendBlobChunks(conn, blob) {
  const total = blob.size;
  let offset = 0;
  const dc = conn && conn.dataChannel ? conn.dataChannel : null;
  if (dc) { try { dc.bufferedAmountLowThreshold = BUFFER_LOW_WATER; } catch (_) {} }

  while (offset < total) {
    if (!conn.open) throw new Error('downloader disconnected');
    const end = Math.min(offset + CHUNK_SIZE, total);
    const buf = await blob.slice(offset, end).arrayBuffer();
    conn.send(buf);
    offset = end;

    if (dc && dc.bufferedAmount > BUFFER_HIGH_WATER) {
      await new Promise((resolve) => {
        const handler = () => { dc.removeEventListener('bufferedamountlow', handler); resolve(); };
        dc.addEventListener('bufferedamountlow', handler);
        setTimeout(() => { dc.removeEventListener('bufferedamountlow', handler); resolve(); }, 1000);
      });
    } else if ((offset / CHUNK_SIZE) % 32 === 0) {
      await new Promise(r => setTimeout(r, 0));
    }
  }
}

async function drainAndClose(conn) {
  const dc = conn && conn.dataChannel ? conn.dataChannel : null;
  if (dc) {
    let waited = 0;
    while (dc.bufferedAmount > 0 && waited < 5000) {
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

  const recvPeer = new Peer();
  let conn = null;
  let chunks = [];
  let received = 0;
  let meta = null;
  let done = false;

  recvPeer.on('open', () => {
    setStatus(recvStatus, 'Reaching sender…', 'neutral');
    conn = recvPeer.connect(senderPeerId, { reliable: true });

    conn.on('open', () => {
      setStatus(recvStatus, 'Requesting file…', 'neutral');
      try { conn.send({ type: 'request', fileId }); } catch (e) { console.warn(e); }
    });

    conn.on('data', async (msg) => {
      if (msg instanceof ArrayBuffer) {
        chunks.push(msg);
        received += msg.byteLength;
        updateRecvProgress(received, meta && meta.size);
        return;
      }
      if (ArrayBuffer.isView(msg)) {
        const buf = msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength);
        chunks.push(buf);
        received += buf.byteLength;
        updateRecvProgress(received, meta && meta.size);
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'reject') {
        const reason = ({
          'not-found':  'This share link no longer exists. The sender may have removed the file or left the room.',
          'no-request': 'Sender timed out waiting for our request.',
        })[msg.reason] || ('Rejected: ' + msg.reason);
        setStatus(recvStatus, reason, 'bad');
        try { recvPeer.destroy(); } catch (_) {}
        return;
      }
      if (msg.type === 'file-meta') {
        meta = msg;
        recvInfo.hidden = false;
        recvName.textContent = meta.name;
        recvSize.textContent = fmtBytes(meta.originalSize || meta.size);
        recvBadge.textContent = meta.compressed
          ? 'gzipped on the wire (' + fmtBytes(meta.size) + ')'
          : 'raw';
        recvBadge.className = 'badge ' + (meta.compressed ? 'badge--compressed' : 'badge--raw');
        setStatus(recvStatus, 'Receiving…', 'neutral');
        return;
      }
      if (msg.type === 'file-end') {
        done = true;
        try {
          let blob = new Blob(chunks, { type: (meta && meta.mime) || 'application/octet-stream' });
          chunks = [];
          if (meta && meta.compressed) {
            setStatus(recvStatus, 'Decompressing…', 'neutral');
            blob = await gunzipBlob(blob);
          }
          finalizeRecv(blob);
        } catch (e) {
          console.error(e);
          setStatus(recvStatus, 'Failed: ' + (e && e.message ? e.message : e), 'bad');
        } finally {
          try { recvPeer.destroy(); } catch (_) {}
        }
      }
    });

    conn.on('close', () => {
      if (!done) {
        setStatus(recvStatus, 'Sender closed the connection before transfer finished.', 'bad');
      }
    });
    conn.on('error', (e) => {
      console.warn('[Recv conn] error:', e);
    });
  });

  recvPeer.on('error', (err) => {
    console.warn('[Recv peer] error:', err);
    if (err.type === 'peer-unavailable') {
      setStatus(recvStatus,
        'Sender is offline. The link has expired (the sender closed the page or stopped sharing).',
        'bad');
    } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
      setStatus(recvStatus, 'Network error contacting the broker — check connection.', 'bad');
    } else if (!done) {
      setStatus(recvStatus, 'Peer error: ' + err.type, 'bad');
    }
  });

  btnRecvCancel.addEventListener('click', () => {
    try { recvPeer.destroy(); } catch (_) {}
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

function finalizeRecv(blob) {
  setStatus(recvStatus, 'Done. Tap to download.', 'good');
  recvFill.style.width = '100%';
  recvText.textContent = 'Received · ' + fmtBytes(blob.size);

  recvActions.innerHTML = '';
  const dl = document.createElement('a');
  dl.className = 'btn btn--primary';
  dl.href = URL.createObjectURL(blob);
  dl.download = recvName.textContent || 'download.bin';
  dl.textContent = 'Download';
  recvActions.appendChild(dl);
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
