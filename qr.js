/* ============================================================
   FileBeam — QR code encoder  v0.3.0
   ============================================================
   A share link is most often handed from a laptop to a phone
   standing next to it, and typing a peer id by hand is hopeless.
   So links are also drawn as a QR — encoded here, in the page,
   because handing the link to a QR image service would leak the
   one thing this app exists to keep between two browsers.

   Byte mode only, versions 1–20, all four ECC levels, mask
   chosen by the standard penalty rules (ISO/IEC 18004). That is
   far more than any share link needs; anything longer throws.
   ============================================================ */

'use strict';

const QR = (() => {

  /* ── Tables (indexed [ecl][version], version 0 unused) ────── */
  const L = 0, M = 1, Q = 2, H = 3;

  const ECC_CODEWORDS = [
    [0, 7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28],
    [0,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26],
    [0,13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,22,24,20,22],
    [0,17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28],
  ];

  const NUM_BLOCKS = [
    [0,1,1,1,1,1,2,2,2,2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8],
    [0,1,1,1,2,2,4,4,4,5, 5, 5, 8, 9, 9,10,10,11,13,14,16],
    [0,1,1,2,2,4,4,6,6,8, 8, 8,10,12,16,12,17,16,18,21,20],
    [0,1,1,2,4,4,4,5,5,8, 8,11,11,16,16,18,16,19,21,25,25],
  ];

  /* Format-info bits are not in ECC-level order. */
  const ECL_BITS = [1, 0, 3, 2];

  const MAX_VERSION = 20;

  /* ── GF(256) arithmetic, primitive polynomial 0x11D ───────── */
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (() => {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

  /* Generator polynomial of degree n, coefficients high → low. */
  function rsGenerator(n) {
    let poly = [1];
    for (let i = 0; i < n; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j]     ^= poly[j];                  // × x
        next[j + 1] ^= gfMul(poly[j], EXP[i]);   // × α^i
      }
      poly = next;
    }
    return poly;
  }

  function rsRemainder(data, ecLen, gen) {
    const rem = new Uint8Array(ecLen);
    for (let d = 0; d < data.length; d++) {
      const factor = data[d] ^ rem[0];
      rem.copyWithin(0, 1);
      rem[ecLen - 1] = 0;
      for (let i = 0; i < ecLen; i++) rem[i] ^= gfMul(gen[i + 1], factor);
    }
    return rem;
  }

  /* ── Capacity ─────────────────────────────────────────────── */

  /* Modules available for data + ECC, before the codeword split. */
  function rawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  function dataCodewords(ver, ecl) {
    return Math.floor(rawDataModules(ver) / 8)
         - ECC_CODEWORDS[ecl][ver] * NUM_BLOCKS[ecl][ver];
  }

  /* Bits a byte-mode segment of this length costs at this version. */
  function segmentBits(numBytes, ver) {
    return 4 + (ver < 10 ? 8 : 16) + numBytes * 8;
  }

  /* ── Bit stream → data codewords ──────────────────────────── */
  function buildData(bytes, ver, ecl) {
    const capacity = dataCodewords(ver, ecl) * 8;
    const bits = [];
    const push = (val, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    };

    push(4, 4);                                  // byte mode
    push(bytes.length, ver < 10 ? 8 : 16);
    for (let i = 0; i < bytes.length; i++) push(bytes[i], 8);

    push(0, Math.min(4, capacity - bits.length));       // terminator
    push(0, (8 - bits.length % 8) % 8);                 // byte align

    const data = new Uint8Array(capacity / 8);
    for (let i = 0; i < bits.length; i++) {
      data[i >>> 3] |= bits[i] << (7 - (i & 7));
    }
    for (let i = bits.length / 8, pad = 0xEC; i < data.length; i++, pad ^= 0xEC ^ 0x11) {
      data[i] = pad;
    }
    return data;
  }

  /* Split into blocks, append Reed-Solomon, interleave. */
  function addEcc(data, ver, ecl) {
    const numBlocks = NUM_BLOCKS[ecl][ver];
    const eccLen    = ECC_CODEWORDS[ecl][ver];
    const rawCw     = Math.floor(rawDataModules(ver) / 8);
    const numShort  = numBlocks - rawCw % numBlocks;
    const shortLen  = Math.floor(rawCw / numBlocks);
    const gen       = rsGenerator(eccLen);

    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const len = shortLen - eccLen + (i < numShort ? 0 : 1);
      const dat = data.subarray(k, k + len);
      k += len;
      blocks.push({ dat, ecc: rsRemainder(dat, eccLen, gen) });
    }

    const out = [];
    for (let i = 0; i < shortLen - eccLen + 1; i++) {
      for (const b of blocks) if (i < b.dat.length) out.push(b.dat[i]);
    }
    for (let i = 0; i < eccLen; i++) {
      for (const b of blocks) out.push(b.ecc[i]);
    }
    return out;
  }

  /* ── Matrix ───────────────────────────────────────────────── */
  function alignPositions(ver) {
    if (ver === 1) return [];
    const numAlign = Math.floor(ver / 7) + 2;
    const step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = ver * 4 + 10; result.length < numAlign; pos -= step) {
      result.splice(1, 0, pos);
    }
    return result;
  }

  const getBit = (x, i) => ((x >>> i) & 1) !== 0;

  function buildMatrix(ver, ecl, codewords) {
    const size = ver * 4 + 17;
    const modules = [], isFn = [];
    for (let i = 0; i < size; i++) {
      modules.push(new Array(size).fill(false));
      isFn.push(new Array(size).fill(false));
    }

    const setFn = (x, y, dark) => {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      modules[y][x] = dark;
      isFn[y][x] = true;
    };

    /* Timing lines first: the finders sit on top of their ends. */
    for (let i = 0; i < size; i++) {
      setFn(6, i, i % 2 === 0);
      setFn(i, 6, i % 2 === 0);
    }
    for (const [fx, fy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          setFn(fx + dx, fy + dy, dist !== 2 && dist !== 4);
        }
      }
    }

    /* Alignment patterns, minus the three that collide with finders. */
    const align = alignPositions(ver);
    const last = align.length - 1;
    for (let i = 0; i < align.length; i++) {
      for (let j = 0; j < align.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            setFn(align[j] + dx, align[i] + dy,
                  Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }

    /* Format info: written once to reserve the cells, then again
       for real once a mask has been picked. */
    const drawFormat = (mask) => {
      const val = (ECL_BITS[ecl] << 3) | mask;
      let rem = val;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bits = ((val << 10) | rem) ^ 0x5412;

      for (let i = 0; i <= 5; i++) setFn(8, i, getBit(bits, i));
      setFn(8, 7, getBit(bits, 6));
      setFn(8, 8, getBit(bits, 7));
      setFn(7, 8, getBit(bits, 8));
      for (let i = 9; i < 15; i++) setFn(14 - i, 8, getBit(bits, i));

      for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, getBit(bits, i));
      for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, getBit(bits, i));
      setFn(8, size - 8, true);                  // the dark module
    };
    drawFormat(0);

    if (ver >= 7) {
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      const bits = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = getBit(bits, i);
        const a = size - 11 + i % 3, b = Math.floor(i / 3);
        setFn(a, b, bit);
        setFn(b, a, bit);
      }
    }

    /* Codewords, zig-zagging up and down the two-module columns. */
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;                // skip the timing column
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!isFn[y][x] && i < codewords.length * 8) {
            modules[y][x] = getBit(codewords[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }

    /* Every mask is tried; the least ugly one wins. */
    let bestMask = 0, bestPenalty = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      applyMask(modules, isFn, mask);
      drawFormat(mask);
      const p = penalty(modules, size);
      if (p < bestPenalty) { bestPenalty = p; bestMask = mask; }
      applyMask(modules, isFn, mask);            // xor is its own undo
    }
    applyMask(modules, isFn, bestMask);
    drawFormat(bestMask);

    return modules;
  }

  function applyMask(modules, isFn, mask) {
    const size = modules.length;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (isFn[y][x]) continue;
        let invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = x * y % 2 + x * y % 3 === 0; break;
          case 6: invert = (x * y % 2 + x * y % 3) % 2 === 0; break;
          default: invert = ((x + y) % 2 + x * y % 3) % 2 === 0; break;
        }
        if (invert) modules[y][x] = !modules[y][x];
      }
    }
  }

  /* ── Mask penalty (ISO/IEC 18004 §8.8.2) ──────────────────── */
  const N1 = 3, N2 = 3, N3 = 40, N4 = 10;

  function pushRun(len, history, size) {
    if (history[0] === 0) len += size;           // pad the leading white edge
    history.pop();
    history.unshift(len);
  }

  /* The 1:1:3:1:1 finder look-alike, with its required light margin. */
  function countFinderLike(history) {
    const n = history[1];
    const core = n > 0 && history[2] === n && history[3] === n * 3
              && history[4] === n && history[5] === n;
    return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0)
         + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
  }

  function endRun(color, len, history, size) {
    if (color) { pushRun(len, history, size); len = 0; }
    pushRun(len + size, history, size);
    return countFinderLike(history);
  }

  function penalty(modules, size) {
    let result = 0;

    for (let pass = 0; pass < 2; pass++) {       // 0 = rows, 1 = columns
      for (let a = 0; a < size; a++) {
        let color = false, run = 0;
        const history = [0, 0, 0, 0, 0, 0, 0];
        for (let b = 0; b < size; b++) {
          const dark = pass === 0 ? modules[a][b] : modules[b][a];
          if (dark === color) {
            run++;
            if (run === 5) result += N1;
            else if (run > 5) result++;
          } else {
            pushRun(run, history, size);
            if (!color) result += countFinderLike(history) * N3;
            color = dark;
            run = 1;
          }
        }
        result += endRun(color, run, history, size) * N3;
      }
    }

    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
          result += N2;
        }
      }
    }

    let dark = 0;
    for (const row of modules) for (const c of row) if (c) dark++;
    const total = size * size;
    result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * N4;

    return result;
  }

  /* ── Public API ───────────────────────────────────────────── */

  /* Returns a size×size array of booleans, true = dark module. */
  function encode(text, minEcl = M) {
    const bytes = new TextEncoder().encode(text);

    let ver = 0;
    for (let v = 1; v <= MAX_VERSION; v++) {
      if (segmentBits(bytes.length, v) <= dataCodewords(v, minEcl) * 8) { ver = v; break; }
    }
    if (!ver) throw new Error('data too long for a QR code');

    /* Free upgrade: spend the slack left in this version on more ECC. */
    let ecl = minEcl;
    for (let e = minEcl + 1; e <= H; e++) {
      if (segmentBits(bytes.length, ver) <= dataCodewords(ver, e) * 8) ecl = e;
    }

    return buildMatrix(ver, ecl, addEcc(buildData(bytes, ver, ecl), ver, ecl));
  }

  /* Modules → standalone SVG string (one path, so it stays small). */
  function toSvg(modules, { border = 4, dark = '#000', light = '#fff' } = {}) {
    const size = modules.length;
    const dim = size + border * 2;
    let path = '';
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (modules[y][x]) path += `M${x + border} ${y + border}h1v1h-1z`;
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" ` +
           `shape-rendering="crispEdges">` +
           `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
           `<path d="${path}" fill="${dark}"/></svg>`;
  }

  /* Ready for an <img src>. */
  function toDataUrl(text, opts) {
    return 'data:image/svg+xml;charset=utf-8,' +
           encodeURIComponent(toSvg(encode(text), opts));
  }

  return { encode, toSvg, toDataUrl, ECL: { L, M, Q, H } };
})();
