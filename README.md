# FileBeam

Drag-and-drop peer-to-peer file sharing in the browser. Files travel directly
between the two browsers over WebRTC — they are never uploaded to a server.

**https://ricardobertolin.github.io/file_transfer_app/**

Each shared file gets its own link. Links live only as long as the sending tab:
close it, or hit *Stop sharing*, and every outstanding link stops working
immediately.

The **QR** button next to a link draws it as a QR code, for handing a share
straight to a phone. It is encoded in the page (`qr.js`, no dependency), so the
link is never sent to an image service.

## How it works

A public [PeerJS](https://peerjs.com) broker is used for signalling only — just
enough for two browsers to find each other. Once the data channel opens, all
file bytes flow directly peer-to-peer.

```
receiver → {type:'request', fileId, proto:2}
sender   → {type:'file-meta', …}
receiver → {type:'start'}            after choosing where to save
sender   → ArrayBuffer chunks…
sender   → {type:'file-end', id, size}
```

The receiver validates the received byte count against the announced size, so a
truncated transfer fails loudly instead of producing a corrupt file.

## Connectivity: you probably want a TURN server

WebRTC needs help getting through NAT. STUN (configured by default) discovers
your public address and is enough for most home networks. It is **not** enough
for symmetric NAT, which is common on mobile carriers and corporate networks —
those need a **TURN relay**, which forwards the traffic.

No TURN server ships with this app on purpose: a relay costs real bandwidth, so
free public ones die or rotate credentials, and a hardcoded dead relay is worse
than none — it looks configured while failing exactly when it is needed.

Open the **Network** panel on the share screen to check what your network can
actually do and to add your own servers. The panel writes to
`localStorage['filebeam.rtc']`:

```json
{
  "iceServers": [
    { "urls": "stun:stun.l.google.com:19302" },
    {
      "urls": ["turn:turn.example.com:3478",
               "turns:turn.example.com:5349?transport=tcp"],
      "username": "your-username",
      "credential": "your-password"
    }
  ],
  "forceRelay": false,
  "server": { "host": "peer.example.com", "port": 443, "secure": true }
}
```

| key | meaning |
| --- | --- |
| `iceServers` | Standard WebRTC ICE server list. Replaces the defaults entirely. |
| `forceRelay` | Sets `iceTransportPolicy: 'relay'` — forces every connection through TURN. Useful for proving your relay works. |
| `server` | Point PeerJS at your own [peerjs-server](https://github.com/peers/peerjs-server) instead of the rate-limited public broker. |

**Test connectivity** gathers candidates against your configuration and reports
whether a relay was reachable. Settings apply on reload, and are stored per
browser — the receiving side needs its own working configuration too.

Self-hosting [coturn](https://github.com/coturn/coturn) is the durable fix. Note
that `turns:` on port 443 is what gets through the strictest firewalls.

## Memory and large files

Nothing is buffered whole in the JS heap:

- **Sending** — gzip runs through `CompressionStream` into a disk-backed Blob,
  which is then sliced chunk by chunk onto the wire.
- **Receiving** — chunks are piped straight through `DecompressionStream` into
  the destination. Where the
  [File System Access API](https://developer.mozilla.org/docs/Web/API/File_System_API)
  is available (Chrome, Edge, Opera), that destination is a file you pick, so
  the transfer is bounded by disk rather than RAM. The receiver asks where to
  save *before* the transfer starts, because opening the save dialog requires a
  user gesture.
- Elsewhere (Firefox, Safari) the file is folded into a Blob every 8 MB, letting
  the browser spill to disk, and offered as a download link at the end. This
  still works for large files but keeps more in the tab.

## Compression

Magic bytes and file extension are checked to guess whether a file is already
compressed. Already-compressed formats (zip, jpeg, mp4, …) default to gzip
*off*, since re-compressing them mostly wastes time; anything else defaults to
*on*. You can always override the toggle.

## Requirements

A browser with WebRTC and the Compression Streams API: Chrome/Edge 80+,
Safari 16.4+, Firefox 113+. Streaming to disk additionally needs the File System
Access API (Chromium-based browsers only, in a secure context).

## Running locally

Static files, no build step:

```sh
python -m http.server 8000
```

Then open `http://localhost:8000`. `localhost` counts as a secure context, so
WebRTC and the save-file picker both work.
