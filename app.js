/* ============================================================
   FileBeam — P2P File Transfer PWA  v0.1.0
   ============================================================
   Architecture
     • PeerJS public broker handles only signaling (peer discovery).
       After the WebRTC data channel opens, all file traffic flows
       directly peer-to-peer.
     • Lobby gating is host-side and password is REQUIRED. Guest's
       first message must be {type:'auth', password}. On mismatch
       the host sends {type:'reject'} and closes the connection.
     • File transfer protocol over the data channel:
         host/guest → {type:'file-meta', id, name, mime,
                        size, originalSize, compressed}
         host/guest → ArrayBuffer chunks (raw, in order)
         host/guest → {type:'file-end', id}
         host/guest → {type:'file-remove', id}   (sync deletions)
       Either side may send. Receiver assembles chunks into a Blob
       and exposes a download link.
     • Lobby is self-cleaning: when the peer disconnects, all received
       files (their object URLs included) are revoked, the broker peer
       entry is destroyed, and the user is sent back to the menu.
     • Compression: detected via magic bytes (with extension fallback).
       If the file is NOT already compressed, the user is offered a
       gzip toggle (default ON). Compression uses the browser-native
       CompressionStream API; decompression on the receiver uses
       DecompressionStream.
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
  menu:     $('screen-menu'),
  host:     $('screen-host'),
  join:     $('screen-join'),
  transfer: $('screen-transfer'),
};

const menuStatus     = $('menuStatus');
const btnGoHost      = $('btnGoHost');
const btnGoJoin      = $('btnGoJoin');

const hostPasswordEl = $('hostPassword');
const btnCreateLobby = $('btnCreateLobby');
const btnHostBack    = $('btnHostBack');
const btnHostCancel  = $('btnHostCancel');
const hostLobbyInfo  = $('hostLobbyInfo');
const lobbyCodeEl    = $('lobbyCode');
const hostStatus     = $('hostStatus');

const joinCodeEl     = $('joinCode');
const joinPasswordEl = $('joinPassword');
const btnConnect     = $('btnConnect');
const btnJoinBack    = $('btnJoinBack');
const joinStatus     = $('joinStatus');

const peerTagYou     = $('peerTagYou');
const peerTagOpp     = $('peerTagOpp');
const transferStatus = $('transferStatus');

const dropzone           = $('dropzone');
const filePicker         = $('filePicker');
const sendInfo           = $('sendInfo');
const sendName           = $('sendName');
const sendSize           = $('sendSize');
const sendCompressedBadge= $('sendCompressedBadge');
const compressToggle     = $('compressToggle');
const compressHint       = $('compressHint');
const btnSend            = $('btnSend');
const btnClearFile       = $('btnClearFile');
const sendProgressWrap   = $('sendProgressWrap');
const sendProgressFill   = $('sendProgressFill');
const sendProgressText   = $('sendProgressText');

const recvList     = $('recvList');
const recvEmpty    = $('recvEmpty');
const btnLeave     = $('btnLeave');

/* Constants */
const ID_PREFIX     = 'filebeamv01-';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
const CODE_LEN      = 6;

const CHUNK_SIZE        = 16 * 1024;             // 16 KB — safe SCTP message size
const BUFFER_HIGH_WATER = 1 * 1024 * 1024;       // 1 MB
const BUFFER_LOW_WATER  = 256 * 1024;            // 256 KB

/* State */
let peer = null;
let conn = null;
let role = null;             // 'host' | 'guest'
let lobbyPassword = '';
let authPending = false;

let pendingFile = null;      // File the user picked but hasn't sent
let pendingDetected = null;  // detection result for pendingFile
let sending = false;

const incoming = new Map();  // id → { meta, chunks, received, itemEl, fillEl, textEl }

/* ── Screen helpers ─────────────────────────────────────────── */
function showScreen(name) {
  for (const k of Object.keys(screens)) {
    screens[k].hidden = (k !== name);
  }
}

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = 'status' + (kind ? ' status--' + kind : '');
}

/* ── Format helpers ─────────────────────────────────────────── */
function fmtBytes(n) {
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

/* ── PeerJS lifecycle ───────────────────────────────────────── */
function ensurePeer(customId) {
  if (peer) { try { peer.destroy(); } catch (_) {} peer = null; }
  peer = customId ? new Peer(customId) : new Peer();

  peer.on('error', (err) => {
    console.warn('[Peer] error:', err);
    if (err.type === 'unavailable-id') {
      setStatus(hostStatus, 'Lobby code already in use — try again.', 'bad');
      btnCreateLobby.disabled = false;
      hostLobbyInfo.hidden = true;
    } else if (err.type === 'peer-unavailable') {
      setStatus(joinStatus, 'No lobby with that code is open.', 'bad');
      btnConnect.disabled = false;
    } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
      const target = role === 'guest' ? joinStatus : (role === 'host' ? hostStatus : menuStatus);
      setStatus(target, 'Network error contacting the broker — check connection.', 'bad');
    } else {
      const target = role === 'guest' ? joinStatus : (role === 'host' ? hostStatus : menuStatus);
      setStatus(target, 'Peer error: ' + err.type, 'bad');
    }
  });
}

function generateCode() {
  let s = '';
  const buf = new Uint8Array(CODE_LEN);
  crypto.getRandomValues(buf);
  for (let i = 0; i < CODE_LEN; i++) {
    s += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  }
  return s;
}

/* ── Host flow ──────────────────────────────────────────────── */
btnGoHost.addEventListener('click', () => {
  role = 'host';
  showScreen('host');
  hostLobbyInfo.hidden = true;
  btnCreateLobby.disabled = false;
  hostPasswordEl.value = '';
  hostPasswordEl.focus();
});

btnHostBack.addEventListener('click', backToMenu);
btnHostCancel.addEventListener('click', backToMenu);

btnCreateLobby.addEventListener('click', () => {
  const pw = (hostPasswordEl.value || '').trim();
  if (!pw) {
    setStatus(hostStatus, 'Password is required to keep strangers out.', 'bad');
    hostLobbyInfo.hidden = false;
    return;
  }
  lobbyPassword = pw;

  const code = generateCode();
  btnCreateLobby.disabled = true;
  hostLobbyInfo.hidden = false;
  lobbyCodeEl.textContent = code;
  setStatus(hostStatus, 'Registering lobby with broker…', 'neutral');

  ensurePeer(ID_PREFIX + code);

  peer.on('open', () => {
    setStatus(hostStatus, 'Waiting for guest to join…', 'neutral');
  });

  peer.on('connection', (incomingConn) => {
    console.log('[Host] incoming connection from', incomingConn.peer);

    if (conn && conn.open) {
      // Already paired — refuse extra peers.
      incomingConn.on('open', () => {
        try { incomingConn.send({ type: 'reject', reason: 'lobby-full' }); } catch (_) {}
        setTimeout(() => { try { incomingConn.close(); } catch (_) {} }, 100);
      });
      return;
    }

    authPending = true;
    let authTimer = null;

    incomingConn.on('open', () => {
      console.log('[Host] connection open');
      authTimer = setTimeout(() => {
        if (authPending && incomingConn.open) {
          try { incomingConn.send({ type: 'reject', reason: 'no-auth' }); } catch (_) {}
          try { incomingConn.close(); } catch (_) {}
          authPending = false;
        }
      }, 5000);
    });

    incomingConn.on('data', (msg) => {
      if (authPending) {
        if (!msg || msg.type !== 'auth') return;
        if (authTimer) { clearTimeout(authTimer); authTimer = null; }
        if ((msg.password || '') !== lobbyPassword) {
          try { incomingConn.send({ type: 'reject', reason: 'bad-password' }); } catch (_) {}
          setTimeout(() => { try { incomingConn.close(); } catch (_) {} }, 50);
          authPending = false;
          setStatus(hostStatus, 'Someone tried to join with a wrong password.', 'warn');
          return;
        }
        authPending = false;
        conn = incomingConn;
        try { conn.send({ type: 'welcome' }); } catch (e) { console.warn(e); }
        enterTransfer('Host', 'Guest');
        return;
      }
      handleData(msg);
    });

    incomingConn.on('close', () => {
      console.log('[Host] connection closed');
      if (incomingConn === conn) onConnClosed();
    });
    incomingConn.on('error', (e) => console.warn('[Host conn] error:', e));
  });
});

/* ── Guest flow ─────────────────────────────────────────────── */
btnGoJoin.addEventListener('click', () => {
  role = 'guest';
  showScreen('join');
  setStatus(joinStatus, '', 'neutral');
  btnConnect.disabled = false;
  joinCodeEl.value = '';
  joinPasswordEl.value = '';
  joinCodeEl.focus();
});

btnJoinBack.addEventListener('click', backToMenu);

joinCodeEl.addEventListener('input', () => {
  joinCodeEl.value = joinCodeEl.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

btnConnect.addEventListener('click', () => {
  const code = (joinCodeEl.value || '').trim().toUpperCase();
  const pw = (joinPasswordEl.value || '').trim();
  if (code.length !== CODE_LEN) {
    setStatus(joinStatus, `Code must be ${CODE_LEN} characters.`, 'bad');
    return;
  }
  if (!pw) {
    setStatus(joinStatus, 'Password is required.', 'bad');
    return;
  }
  btnConnect.disabled = true;
  setStatus(joinStatus, 'Connecting to broker…', 'neutral');

  ensurePeer(null);

  peer.on('open', () => {
    setStatus(joinStatus, 'Reaching host…', 'neutral');
    const c = peer.connect(ID_PREFIX + code, { reliable: true });
    conn = c;

    c.on('open', () => {
      setStatus(joinStatus, 'Authenticating…', 'neutral');
      try { c.send({ type: 'auth', password: pw }); } catch (e) { console.warn(e); }
    });

    c.on('data', (msg) => handleData(msg));

    c.on('close', () => {
      console.log('[Guest] connection closed');
      onConnClosed();
    });
    c.on('error', (e) => console.warn('[Guest conn] error:', e));
  });
});

/* ── Connection close ───────────────────────────────────────── */
function onConnClosed() {
  // Pre-transfer disconnect (auth phase) — keep lobby open so host
  // can still wait for another guest, or guest can retry.
  if (screens.transfer.hidden) {
    if (role === 'guest') {
      setStatus(joinStatus, 'Connection closed by host.', 'bad');
      btnConnect.disabled = false;
    } else if (role === 'host') {
      setStatus(hostStatus, 'Guest disconnected.', 'warn');
    }
    conn = null;
    return;
  }

  // Active session ended → self-destruct the lobby and any files in it.
  conn = null;
  const hadFiles = incoming.size > 0;
  purgeAllRecvFiles();
  if (peer) { try { peer.destroy(); } catch (_) {} peer = null; }
  role = null;
  pendingFile = null;
  pendingDetected = null;
  sending = false;
  peerTagYou.classList.remove('player-tag--active');
  showScreen('menu');
  setStatus(menuStatus,
    hadFiles
      ? 'Peer left — lobby and its files were cleared.'
      : 'Peer left — lobby closed.',
    'warn');
}

/* ── Message dispatch ───────────────────────────────────────── */
function handleData(msg) {
  // Binary chunk?
  if (msg instanceof ArrayBuffer) {
    onChunk(msg);
    return;
  }
  if (ArrayBuffer.isView(msg)) {
    onChunk(msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength));
    return;
  }
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'reject') {
    const reason = ({
      'bad-password': 'Wrong password.',
      'lobby-full':   'Lobby is full.',
      'no-auth':      'Host timed out waiting for authentication.',
    })[msg.reason] || ('Rejected: ' + msg.reason);
    setStatus(joinStatus, reason, 'bad');
    btnConnect.disabled = false;
    if (conn) { try { conn.close(); } catch (_) {} }
    return;
  }
  if (msg.type === 'welcome') {
    enterTransfer('Guest', 'Host');
    return;
  }
  if (msg.type === 'file-meta')   { onFileMeta(msg); return; }
  if (msg.type === 'file-end')    { onFileEnd(msg); return; }
  if (msg.type === 'file-remove') { removeRecvFile(msg.id, false); return; }
}

/* ── Transfer screen entry ──────────────────────────────────── */
function enterTransfer(youLabel, oppLabel) {
  showScreen('transfer');
  peerTagYou.textContent = 'You: ' + youLabel;
  peerTagOpp.textContent = 'Peer: ' + oppLabel;
  peerTagYou.classList.add('player-tag--active');
  setStatus(transferStatus, 'Connected. Pick a file to send.', 'good');
  resetSendUi();
  recvEmpty.hidden = incoming.size > 0;
}

/* ── File picker / drag-drop ────────────────────────────────── */
filePicker.addEventListener('change', (ev) => {
  const f = ev.target.files && ev.target.files[0];
  if (f) onFilePicked(f);
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
  if (f) onFilePicked(f);
});

async function onFilePicked(file) {
  pendingFile = file;
  sendInfo.hidden = false;
  sendName.textContent = file.name;
  sendSize.textContent = fmtBytes(file.size);
  sendCompressedBadge.textContent = 'checking…';
  sendCompressedBadge.className = 'badge';
  compressToggle.checked = false;
  compressToggle.disabled = true;
  compressHint.textContent = 'Detecting file type…';
  resetProgress();

  const detected = await detectCompression(file);
  pendingDetected = detected;

  if (detected.compressed) {
    sendCompressedBadge.textContent = 'Already compressed · ' + detected.kind;
    sendCompressedBadge.className = 'badge badge--compressed';
    compressToggle.checked = false;
    compressToggle.disabled = false; // user can still force gzip
    compressHint.textContent =
      'This file looks already compressed (' + detected.kind +
      '). Re-compressing usually wastes time. Skip it unless you know better.';
  } else {
    sendCompressedBadge.textContent = 'Raw / uncompressed';
    sendCompressedBadge.className = 'badge badge--raw';
    compressToggle.checked = true;
    compressToggle.disabled = false;
    compressHint.textContent =
      'This file is not in a compressed format. Sending it through gzip will likely shrink it.';
  }
}

btnClearFile.addEventListener('click', () => {
  pendingFile = null;
  pendingDetected = null;
  filePicker.value = '';
  resetSendUi();
});

function resetSendUi() {
  sendInfo.hidden = true;
  filePicker.value = '';
  resetProgress();
  btnSend.disabled = false;
}

function resetProgress() {
  sendProgressWrap.hidden = true;
  sendProgressFill.style.width = '0%';
  sendProgressText.textContent = '0%';
}

/* ── Compression detection (magic bytes + extension fallback) ─ */
const COMPRESSED_EXTS = new Set([
  'zip','gz','gzip','bz2','xz','7z','rar','tar','tgz','tbz2','txz','tbz','br','lz','lzma','lz4','zst','zstd',
  'docx','xlsx','pptx','odt','ods','odp','epub','cbz','cbr','jar','war','apk','ipa','nupkg',
  'jpg','jpeg','png','webp','heic','heif','avif','gif',
  'mp3','mp4','m4a','m4v','ogg','opus','flac','webm','avi','mov','mkv','wmv','aac','wma','3gp',
  'pdf',
]);

async function detectCompression(file) {
  // Magic byte sniff (first 16 bytes is enough for everything we check).
  const slice = file.slice(0, 16);
  let buf;
  try {
    buf = new Uint8Array(await slice.arrayBuffer());
  } catch (_) {
    buf = new Uint8Array(0);
  }

  const m = (...bytes) => {
    for (let i = 0; i < bytes.length; i++) {
      if (buf[i] !== bytes[i]) return false;
    }
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

  // Fallback: extension.
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext && COMPRESSED_EXTS.has(ext)) {
    return { compressed: true, kind: '.' + ext };
  }

  return { compressed: false, kind: 'raw' };
}

/* ── Compression helpers ────────────────────────────────────── */
async function gzipBlob(blob) {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('CompressionStream is not supported in this browser.');
  }
  const cs = new CompressionStream('gzip');
  const stream = blob.stream().pipeThrough(cs);
  return await new Response(stream).blob();
}

async function gunzipBlob(blob) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream is not supported in this browser.');
  }
  const ds = new DecompressionStream('gzip');
  const stream = blob.stream().pipeThrough(ds);
  return await new Response(stream).blob();
}

/* ── Send flow ──────────────────────────────────────────────── */
btnSend.addEventListener('click', async () => {
  if (!pendingFile) return;
  if (!conn || !conn.open) {
    setStatus(transferStatus, 'Not connected.', 'bad');
    return;
  }
  if (sending) return;

  // If user did NOT enable compress AND file is not detected as compressed,
  // confirm — the brief asks us to either compress or ask.
  if (!compressToggle.checked && pendingDetected && !pendingDetected.compressed) {
    const ok = window.confirm(
      'This file is not in a compressed format. Send it without gzip compression?\n\n' +
      'Tip: cancel and toggle "Compress with gzip before sending" to shrink it.'
    );
    if (!ok) return;
  }

  sending = true;
  btnSend.disabled = true;
  btnClearFile.disabled = true;
  sendProgressWrap.hidden = false;

  try {
    let blobToSend = pendingFile;
    let compressed = false;

    if (compressToggle.checked) {
      setStatus(transferStatus, 'Compressing…', 'neutral');
      blobToSend = await gzipBlob(pendingFile);
      compressed = true;
    }

    const id = makeId();
    const meta = {
      type: 'file-meta',
      id,
      name: pendingFile.name,
      mime: pendingFile.type || 'application/octet-stream',
      size: blobToSend.size,
      originalSize: pendingFile.size,
      compressed,
    };

    setStatus(transferStatus,
      compressed
        ? `Sending (${fmtBytes(blobToSend.size)}, gzipped from ${fmtBytes(pendingFile.size)})…`
        : `Sending (${fmtBytes(blobToSend.size)})…`,
      'neutral');

    conn.send(meta);
    await sendBlobChunks(blobToSend, id);
    conn.send({ type: 'file-end', id });

    sendProgressFill.style.width = '100%';
    sendProgressText.textContent = '100% · done';
    setStatus(transferStatus, 'File sent.', 'good');
  } catch (err) {
    console.error(err);
    setStatus(transferStatus, 'Send failed: ' + (err && err.message ? err.message : err), 'bad');
  } finally {
    sending = false;
    btnSend.disabled = false;
    btnClearFile.disabled = false;
  }
});

async function sendBlobChunks(blob, id) {
  const total = blob.size;
  let offset = 0;
  let lastUiUpdate = 0;

  // Underlying RTCDataChannel — used for backpressure if available.
  const dc = conn && conn.dataChannel ? conn.dataChannel : null;
  if (dc) {
    try { dc.bufferedAmountLowThreshold = BUFFER_LOW_WATER; } catch (_) {}
  }

  while (offset < total) {
    const end = Math.min(offset + CHUNK_SIZE, total);
    const slice = blob.slice(offset, end);
    const buf = await slice.arrayBuffer();

    if (!conn || !conn.open) throw new Error('connection closed mid-transfer');
    conn.send(buf);
    offset = end;

    // UI update (throttled)
    const now = performance.now();
    if (now - lastUiUpdate > 80 || offset === total) {
      const pct = (offset / total) * 100;
      sendProgressFill.style.width = pct.toFixed(1) + '%';
      sendProgressText.textContent =
        pct.toFixed(1) + '% · ' + fmtBytes(offset) + ' / ' + fmtBytes(total);
      lastUiUpdate = now;
    }

    // Backpressure: wait if SCTP queue is high.
    if (dc && dc.bufferedAmount > BUFFER_HIGH_WATER) {
      await new Promise((resolve) => {
        const handler = () => {
          dc.removeEventListener('bufferedamountlow', handler);
          resolve();
        };
        dc.addEventListener('bufferedamountlow', handler);
        // Safety fallback in case the event never fires.
        setTimeout(() => {
          dc.removeEventListener('bufferedamountlow', handler);
          resolve();
        }, 1000);
      });
    } else if ((offset / CHUNK_SIZE) % 32 === 0) {
      // Yield occasionally so the UI stays responsive even without backpressure events.
      await new Promise(r => setTimeout(r, 0));
    }
  }
}

/* ── Receive flow ───────────────────────────────────────────── */
function onFileMeta(meta) {
  if (!meta.id) return;
  const item = createRecvItem(meta);
  incoming.set(meta.id, {
    meta,
    chunks: [],
    received: 0,
    itemEl: item.root,
    fillEl: item.fill,
    textEl: item.text,
    nameEl: item.name,
  });
  recvEmpty.hidden = true;
}

function onChunk(buf) {
  // Chunks belong to the most recently announced in-progress file.
  // (We assume one file transfer at a time per direction, which is what
  //  the send button enforces.)
  const last = lastIncomingInProgress();
  if (!last) return;
  last.chunks.push(buf);
  last.received += buf.byteLength;

  const total = last.meta.size;
  const pct = (last.received / total) * 100;
  last.fillEl.style.width = pct.toFixed(1) + '%';
  last.textEl.textContent =
    pct.toFixed(1) + '% · ' + fmtBytes(last.received) + ' / ' + fmtBytes(total);
}

function lastIncomingInProgress() {
  let candidate = null;
  for (const v of incoming.values()) {
    if (!v.done) candidate = v;
  }
  return candidate;
}

async function onFileEnd(msg) {
  const rec = incoming.get(msg.id);
  if (!rec) return;
  rec.done = true;

  try {
    let blob = new Blob(rec.chunks, { type: rec.meta.mime || 'application/octet-stream' });
    if (rec.meta.compressed) {
      rec.textEl.textContent = 'decompressing…';
      blob = await gunzipBlob(blob);
    }
    finalizeRecv(rec, blob);
  } catch (err) {
    console.error(err);
    rec.textEl.textContent = 'failed: ' + (err && err.message ? err.message : err);
    rec.fillEl.style.background = 'var(--color-bad)';
  } finally {
    rec.chunks = []; // free memory; URL keeps the assembled blob alive
  }
}

function finalizeRecv(rec, blob) {
  const url = URL.createObjectURL(blob);
  rec.objectUrl = url;

  const dl = document.createElement('a');
  dl.className = 'recv-item__download';
  dl.href = url;
  dl.download = rec.meta.name || 'download.bin';
  dl.textContent = 'Download';

  const rm = document.createElement('button');
  rm.type = 'button';
  rm.className = 'recv-item__remove';
  rm.textContent = 'Remove';
  rm.addEventListener('click', () => removeRecvFile(rec.meta.id, true));

  rec.fillEl.style.width = '100%';
  rec.textEl.textContent =
    'received · ' + fmtBytes(blob.size) +
    (rec.meta.compressed
      ? ` (was ${fmtBytes(rec.meta.size)} on the wire)`
      : '');

  const actionsRow = rec.itemEl.querySelector('.recv-item__actions');
  actionsRow.innerHTML = '';
  actionsRow.appendChild(rm);
  actionsRow.appendChild(dl);
}

/* ── Remove / purge received files ──────────────────────────── */
function removeRecvFile(id, notify) {
  const rec = incoming.get(id);
  if (!rec) return;
  if (rec.objectUrl) { try { URL.revokeObjectURL(rec.objectUrl); } catch (_) {} }
  if (rec.itemEl && rec.itemEl.parentNode) rec.itemEl.parentNode.removeChild(rec.itemEl);
  incoming.delete(id);
  if (incoming.size === 0) recvEmpty.hidden = false;
  if (notify && conn && conn.open) {
    try { conn.send({ type: 'file-remove', id }); } catch (_) {}
  }
}

function purgeAllRecvFiles() {
  for (const rec of incoming.values()) {
    if (rec.objectUrl) { try { URL.revokeObjectURL(rec.objectUrl); } catch (_) {} }
    if (rec.itemEl && rec.itemEl.parentNode) rec.itemEl.parentNode.removeChild(rec.itemEl);
  }
  incoming.clear();
  recvEmpty.hidden = false;
}

function createRecvItem(meta) {
  const root = document.createElement('div');
  root.className = 'recv-item';

  const row1 = document.createElement('div');
  row1.className = 'recv-item__row';
  const name = document.createElement('span');
  name.className = 'recv-item__name';
  name.textContent = meta.name || '(unnamed)';
  const size = document.createElement('span');
  size.className = 'recv-item__size';
  size.textContent = fmtBytes(meta.originalSize || meta.size);
  row1.appendChild(name);
  row1.appendChild(size);

  const progress = document.createElement('div');
  progress.className = 'progress';
  const bar = document.createElement('div');
  bar.className = 'progress__bar';
  const fill = document.createElement('div');
  fill.className = 'progress__fill';
  bar.appendChild(fill);
  const text = document.createElement('p');
  text.className = 'progress__text';
  text.textContent = '0%';
  progress.appendChild(bar);
  progress.appendChild(text);

  const actions = document.createElement('div');
  actions.className = 'recv-item__row recv-item__actions';

  root.appendChild(row1);
  root.appendChild(progress);
  root.appendChild(actions);
  recvList.appendChild(root);

  return { root, fill, text, name };
}

/* ── Leave / nav ────────────────────────────────────────────── */
btnLeave.addEventListener('click', () => {
  if (conn) { try { conn.close(); } catch (_) {} conn = null; }
  if (peer) { try { peer.destroy(); } catch (_) {} peer = null; }
  backToMenu();
});

function backToMenu() {
  if (peer) { try { peer.destroy(); } catch (_) {} peer = null; }
  conn = null;
  role = null;
  pendingFile = null;
  pendingDetected = null;
  sending = false;
  purgeAllRecvFiles();
  showScreen('menu');
  setStatus(menuStatus, 'Ready.', 'neutral');
  peerTagYou.classList.remove('player-tag--active');
}

/* ── Boot ───────────────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', () => {
  if (typeof Peer === 'undefined') {
    setStatus(menuStatus, 'PeerJS failed to load — check your connection and reload.', 'bad');
    btnGoHost.disabled = true;
    btnGoJoin.disabled = true;
    return;
  }
  if (typeof CompressionStream === 'undefined') {
    setStatus(menuStatus,
      'Heads up: this browser lacks CompressionStream. You can still send files, but gzip will be unavailable.',
      'warn');
  } else {
    setStatus(menuStatus, 'Ready.', 'neutral');
  }
  showScreen('menu');
});
