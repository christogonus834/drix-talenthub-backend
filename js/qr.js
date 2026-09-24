// js/qr.js — tiny self-contained QR code generator (byte mode, error correction L, versions 1–10).
// No external libraries, no network. Exposes: DrixQR.svg(text, {size, dark, light, margin}) -> SVG string
//                                              DrixQR.matrix(text) -> 2D array of booleans
(function (root) {
  'use strict';

  // [totalCodewords, ecPerBlock, g1Blocks, g1DataCw, g2Blocks, g2DataCw] — error correction level L
  var VERSIONS = [
    null,
    [26, 7, 1, 19, 0, 0], [44, 10, 1, 34, 0, 0], [70, 15, 1, 55, 0, 0], [100, 20, 1, 80, 0, 0],
    [134, 26, 1, 108, 0, 0], [172, 18, 2, 68, 0, 0], [196, 20, 2, 78, 0, 0], [242, 24, 2, 97, 0, 0],
    [292, 30, 2, 116, 0, 0], [346, 18, 2, 68, 2, 69]
  ];
  var ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  // ── GF(256) ────────────────────────────────────────────────────────
  var EXP = new Array(512), LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D; }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();
  function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

  function rsGenerator(deg) {
    var poly = [1];
    for (var i = 0; i < deg; i++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gmul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly; // highest degree first, length deg+1
  }
  function rsRemainder(data, ecLen) {
    var gen = rsGenerator(ecLen);
    var res = new Array(ecLen).fill(0);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ res[0];
      res.shift(); res.push(0);
      for (var j = 0; j < ecLen; j++) res[j] ^= gmul(gen[j + 1], factor);
    }
    return res;
  }

  // ── Bit helpers ────────────────────────────────────────────────────
  function utf8(str) {
    var out = [];
    var s = unescape(encodeURIComponent(str));
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return out;
  }
  function pushBits(bits, val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }

  function chooseVersion(len) {
    for (var v = 1; v <= 10; v++) {
      var info = VERSIONS[v];
      var dataCw = info[2] * info[3] + info[4] * info[5];
      var ccBits = v < 10 ? 8 : 16;
      if (4 + ccBits + len * 8 <= dataCw * 8) return v;
    }
    throw new Error('QR: text too long');
  }

  function buildCodewords(bytes, v) {
    var info = VERSIONS[v];
    var dataCw = info[2] * info[3] + info[4] * info[5];
    var bits = [];
    pushBits(bits, 4, 4);                                  // byte mode
    pushBits(bits, bytes.length, v < 10 ? 8 : 16);
    bytes.forEach(function (b) { pushBits(bits, b, 8); });
    var cap = dataCw * 8;
    pushBits(bits, 0, Math.min(4, cap - bits.length));     // terminator
    while (bits.length % 8) bits.push(0);
    var data = [];
    for (var i = 0; i < bits.length; i += 8) {
      var b = 0; for (var k = 0; k < 8; k++) b = (b << 1) | bits[i + k]; data.push(b);
    }
    for (var pad = 0xEC; data.length < dataCw; pad ^= (0xEC ^ 0x11)) data.push(pad);

    // split into blocks, add EC, interleave
    var blocks = [], pos = 0, ecLen = info[1];
    for (var g = 0; g < info[2]; g++) blocks.push(data.slice(pos, pos += info[3]));
    for (var h = 0; h < info[4]; h++) blocks.push(data.slice(pos, pos += info[5]));
    var ecs = blocks.map(function (b) { return rsRemainder(b, ecLen); });
    var out = [], maxLen = Math.max(info[3], info[5]);
    for (var c = 0; c < maxLen; c++) blocks.forEach(function (b) { if (c < b.length) out.push(b[c]); });
    for (var e = 0; e < ecLen; e++) ecs.forEach(function (b) { out.push(b[e]); });
    return out;
  }

  // ── Matrix construction ───────────────────────────────────────────
  function makeMatrix(v) {
    var n = 17 + 4 * v;
    var m = [], f = [];
    for (var i = 0; i < n; i++) { m.push(new Array(n).fill(false)); f.push(new Array(n).fill(false)); }
    return { n: n, m: m, f: f };
  }
  function setF(q, r, c, dark) { if (r >= 0 && r < q.n && c >= 0 && c < q.n) { q.m[r][c] = dark; q.f[r][c] = true; } }

  function drawFinder(q, r0, c0) {
    for (var dr = -1; dr <= 7; dr++) for (var dc = -1; dc <= 7; dc++) {
      var inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
      var dark = inside && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
      setF(q, r0 + dr, c0 + dc, dark);
    }
  }
  function drawAlign(q, cr, cc) {
    for (var dr = -2; dr <= 2; dr++) for (var dc = -2; dc <= 2; dc++) {
      var d = Math.max(Math.abs(dr), Math.abs(dc));
      setF(q, cr + dr, cc + dc, d !== 1);
    }
  }
  function bch(value, poly, dataBits, totalBits) {
    var v = value << (totalBits - dataBits);
    var top = 1 << (totalBits - 1);
    for (var i = totalBits - 1; i >= totalBits - dataBits; i--) {
      if (v & (1 << i)) v ^= poly << (i - (totalBits - dataBits));
    }
    return (value << (totalBits - dataBits)) | v;
  }

  function drawFunctionPatterns(q, v) {
    var n = q.n;
    drawFinder(q, 0, 0); drawFinder(q, 0, n - 7); drawFinder(q, n - 7, 0);
    for (var i = 8; i < n - 8; i++) { setF(q, 6, i, i % 2 === 0); setF(q, i, 6, i % 2 === 0); }  // timing
    var a = ALIGN[v];
    for (var x = 0; x < a.length; x++) for (var y = 0; y < a.length; y++) {
      if ((x === 0 && y === 0) || (x === 0 && y === a.length - 1) || (x === a.length - 1 && y === 0)) continue;
      drawAlign(q, a[x], a[y]);
    }
    setF(q, n - 8, 8, true);                                                                    // dark module
    // reserve format areas (filled later)
    for (var k = 0; k < 9; k++) { if (!q.f[8][k]) setF(q, 8, k, false); if (!q.f[k][8]) setF(q, k, 8, false); }
    for (var k2 = 0; k2 < 8; k2++) { setF(q, 8, n - 1 - k2, false); setF(q, n - 1 - k2, 8, false); }
    setF(q, n - 8, 8, true);
    if (v >= 7) {
      var vi = bch(v, 0x1F25, 6, 18);
      for (var b = 0; b < 18; b++) {
        var bit = ((vi >> b) & 1) === 1;
        var r = Math.floor(b / 3), c = b % 3 + n - 11;
        setF(q, r, c, bit); setF(q, c, r, bit);
      }
    }
  }

  function placeData(q, codewords) {
    var bits = [];
    codewords.forEach(function (cw) { pushBits(bits, cw, 8); });
    var idx = 0, n = q.n, up = true;
    for (var col = n - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (var t = 0; t < n; t++) {
        var r = up ? n - 1 - t : t;
        for (var dc = 0; dc < 2; dc++) {
          var c = col - dc;
          if (!q.f[r][c]) { q.m[r][c] = idx < bits.length ? bits[idx] === 1 : false; idx++; }
        }
      }
      up = !up;
    }
  }

  var MASKS = [
    function (r, c) { return (r + c) % 2 === 0; },
    function (r, c) { return r % 2 === 0; },
    function (r, c) { return c % 3 === 0; },
    function (r, c) { return (r + c) % 3 === 0; },
    function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
    function (r, c) { return (r * c) % 2 + (r * c) % 3 === 0; },
    function (r, c) { return ((r * c) % 2 + (r * c) % 3) % 2 === 0; },
    function (r, c) { return ((r + c) % 2 + (r * c) % 3) % 2 === 0; }
  ];

  function applyMask(q, mask) {
    var out = q.m.map(function (row) { return row.slice(); });
    for (var r = 0; r < q.n; r++) for (var c = 0; c < q.n; c++) {
      if (!q.f[r][c] && MASKS[mask](r, c)) out[r][c] = !out[r][c];
    }
    return out;
  }

  function drawFormat(m, n, mask) {
    var data = (1 << 3) | mask;                       // level L = 01, then mask
    var bits = bch(data, 0x537, 5, 15) ^ 0x5412;
    function bit(i) { return ((bits >> i) & 1) === 1; }
    for (var i = 0; i <= 5; i++) m[i][8] = bit(i);
    m[7][8] = bit(6); m[8][8] = bit(7); m[8][7] = bit(8);
    for (var j = 9; j < 15; j++) m[8][14 - j] = bit(j);
    for (var k = 0; k < 8; k++) m[8][n - 1 - k] = bit(k);
    for (var l = 8; l < 15; l++) m[n - 15 + l][8] = bit(l);
    m[n - 8][8] = true;
  }

  function penalty(m, n) {
    var p = 0, r, c, run, i;
    for (r = 0; r < n; r++) {                           // rule 1 rows
      run = 1;
      for (c = 1; c < n; c++) { if (m[r][c] === m[r][c - 1]) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; }
    }
    for (c = 0; c < n; c++) {                           // rule 1 cols
      run = 1;
      for (r = 1; r < n; r++) { if (m[r][c] === m[r - 1][c]) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; }
    }
    for (r = 0; r < n - 1; r++) for (c = 0; c < n - 1; c++) {   // rule 2
      var s = m[r][c];
      if (s === m[r][c + 1] && s === m[r + 1][c] && s === m[r + 1][c + 1]) p += 3;
    }
    var pat1 = [true, false, true, true, true, false, true, false, false, false, false];
    var pat2 = [false, false, false, false, true, false, true, true, true, false, true];
    function match(getter, pat) { for (var k = 0; k < 11; k++) if (getter(k) !== pat[k]) return false; return true; }
    for (r = 0; r < n; r++) for (c = 0; c <= n - 11; c++) {     // rule 3
      if (match(function (k) { return m[r][c + k]; }, pat1) || match(function (k) { return m[r][c + k]; }, pat2)) p += 40;
    }
    for (c = 0; c < n; c++) for (r = 0; r <= n - 11; r++) {
      if (match(function (k) { return m[r + k][c]; }, pat1) || match(function (k) { return m[r + k][c]; }, pat2)) p += 40;
    }
    var dark = 0;                                       // rule 4
    for (r = 0; r < n; r++) for (c = 0; c < n; c++) if (m[r][c]) dark++;
    var pct = dark * 100 / (n * n);
    p += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return p;
  }

  function matrix(text) {
    var bytes = utf8(String(text));
    var v = chooseVersion(bytes.length);
    var q = makeMatrix(v);
    drawFunctionPatterns(q, v);
    placeData(q, buildCodewords(bytes, v));
    var best = null, bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var cand = applyMask(q, mask);
      drawFormat(cand, q.n, mask);
      var s = penalty(cand, q.n);
      if (s < bestScore) { bestScore = s; best = cand; }
    }
    return best;
  }

  function svg(text, opts) {
    opts = opts || {};
    var m = matrix(text), n = m.length, margin = opts.margin == null ? 0 : opts.margin;
    var dark = opts.dark || '#000', light = opts.light || 'transparent';
    var d = '';
    for (var r = 0; r < n; r++) {
      var c = 0;
      while (c < n) {
        if (m[r][c]) { var s = c; while (c < n && m[r][c]) c++; d += 'M' + (s + margin) + ' ' + (r + margin) + 'h' + (c - s) + 'v1h-' + (c - s) + 'z'; }
        else c++;
      }
    }
    var total = n + margin * 2;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + ' ' + total + '" shape-rendering="crispEdges"' +
      (opts.size ? ' width="' + opts.size + '" height="' + opts.size + '"' : '') + '>' +
      '<rect width="' + total + '" height="' + total + '" fill="' + light + '"/><path d="' + d + '" fill="' + dark + '"/></svg>';
  }

  root.DrixQR = { matrix: matrix, svg: svg };
})(typeof window !== 'undefined' ? window : globalThis);
