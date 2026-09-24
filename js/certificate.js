// js/certificate.js — the ONE certificate design (landscape, A4 ratio), used by:
//   • /dashboard/certificates  (fellow preview + print / save as PDF)
//   • /verify                  (public verification page)
// Self-contained: its own CSS, its own QR generator (js/qr.js). No external images needed.
//
// Usage:
//   DrixCertificate.render({ fellowName, photo, trackName, title, grade, score, certId, issuedAt,
//                            sig1_name, sig1_logo, sig2_name, sig2_logo, logoUrl })  -> HTML string
//   DrixCertificate.fit(scopeEl?)     -> (re)scale every certificate inside scopeEl to its container
//   DrixCertificate.print(wrapEl)     -> print / save as PDF (A4 landscape) that one certificate
//   DrixCertificate.loadBranding()    -> Promise<{ logo }>  (site logo from admin settings, if set)
(function (root) {
  'use strict';

  var FOUNDATION = 'Drix Tech Foundation';   // issuing name — always this
  var W = 1000, H = 707;                     // design canvas (A4 landscape ratio)
  var uid = 0;

  var CSS = [
    "@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap');",
    ".drx-cert-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:10px;}",
    ".drx-cert-wrap{position:relative;width:100%;overflow:hidden;background:#f4f4f8;border-radius:6px;}",
    ".drx-cert{position:absolute;top:0;left:0;width:" + W + "px;height:" + H + "px;transform-origin:0 0;background:#f4f4f8;color:#1c1d2e;",
    "  font-family:'Poppins','Inter',Arial,sans-serif;overflow:hidden;-webkit-print-color-adjust:exact;print-color-adjust:exact;text-align:left;}",
    ".drx-cert *{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;}",
    ".drx-bg{position:absolute;inset:0;}",
    ".drx-ribbon{position:absolute;top:0;right:96px;width:66px;height:172px;background:linear-gradient(180deg,#5a4bdc,#3b2fa8);clip-path:polygon(0 0,100% 0,100% 100%,50% 84%,0 100%);}",
    ".drx-brand{position:absolute;left:52px;top:40px;display:flex;align-items:center;gap:12px;}",
    ".drx-brand img{height:52px;width:auto;max-width:200px;object-fit:contain;display:block;}",
    ".drx-wm{line-height:1;}",
    ".drx-wm b{display:block;font-size:30px;font-weight:800;letter-spacing:-0.02em;color:#1c1d2e;}",
    ".drx-wm b i{font-style:normal;color:#5a4bdc;}",
    ".drx-wm span{display:block;margin-top:5px;font-size:10.5px;font-weight:500;letter-spacing:0.14em;text-transform:uppercase;color:#6b6d85;}",
    ".drx-presents{position:absolute;left:52px;top:122px;font-size:14.5px;font-weight:500;color:#3a3b52;}",
    ".drx-presents b{font-weight:700;color:#1c1d2e;}",
    ".drx-title{position:absolute;left:50px;top:150px;font-weight:800;color:#26273a;text-transform:uppercase;line-height:1;}",
    ".drx-title .t1{font-size:66px;letter-spacing:-0.01em;}",
    ".drx-title .t2{font-size:38px;margin-top:8px;letter-spacing:0.005em;}",
    ".drx-awarded{position:absolute;left:52px;top:322px;font-size:15px;font-weight:500;color:#3a3b52;}",
    ".drx-name{position:absolute;left:52px;top:344px;width:560px;padding:6px 6px 8px;border-bottom:2px solid #26273a;font-weight:600;color:#1c1d2e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
    ".drx-body{position:absolute;left:52px;top:410px;width:600px;font-size:17.5px;line-height:1.62;color:#3a3b52;}",
    ".drx-body b{color:#1c1d2e;font-weight:700;}",
    ".drx-meta{position:absolute;left:52px;top:508px;font-size:18px;font-weight:700;line-height:1.5;color:#4a3cc4;}",
    ".drx-meta span{color:#26273a;font-weight:700;}",
    ".drx-photo{position:absolute;left:740px;top:196px;width:132px;height:132px;border-radius:50%;object-fit:cover;border:5px solid #fff;box-shadow:0 0 0 3px #5a4bdc,0 8px 22px rgba(58,47,168,0.25);background:#ddd;}",
    ".drx-seal{position:absolute;left:722px;top:352px;width:176px;height:176px;}",
    ".drx-band{position:absolute;left:0;right:0;bottom:0;height:128px;background:linear-gradient(100deg,#3b2fa8 0%,#5a4bdc 55%,#7C6EF7 100%);color:#fff;}",
    ".drx-band::before{content:'';position:absolute;left:0;right:0;top:-6px;height:6px;background:linear-gradient(90deg,#06D6A0,#7C6EF7);opacity:.9;}",
    ".drx-sigs{position:absolute;left:52px;top:26px;display:flex;gap:34px;align-items:flex-start;height:90px;}",
    ".drx-sig{width:212px;text-align:center;}",
    ".drx-sig-logo{height:38px;margin-bottom:6px;display:flex;align-items:flex-end;justify-content:center;}",
    ".drx-sig-logo img{max-height:38px;max-width:150px;object-fit:contain;background:#fff;border-radius:6px;padding:3px 8px;}",
    ".drx-sig-line{height:1.5px;background:rgba(255,255,255,.7);margin-bottom:7px;}",
    ".drx-sig-name{font-size:11.5px;font-weight:600;letter-spacing:0.03em;color:#fff;line-height:1.3;}",
    ".drx-verify{position:absolute;right:44px;top:12px;width:392px;height:104px;display:flex;align-items:center;justify-content:flex-end;gap:16px;}",
    ".drx-vtext{text-align:right;font-size:11px;line-height:1.5;color:rgba(255,255,255,.88);max-width:250px;}",
    ".drx-vtext .lead{text-wrap:balance;}",
    ".drx-vtext .id{margin-top:5px;font-size:12px;color:#fff;}",
    ".drx-vtext .id em{font-style:normal;font-weight:500;opacity:.8;margin-right:8px;}",
    ".drx-vtext .id strong{font-family:'JetBrains Mono',ui-monospace,Menlo,Consolas,monospace;font-weight:600;letter-spacing:0.02em;border-bottom:1px solid rgba(255,255,255,.55);padding-bottom:1px;}",
    ".drx-vtext .tag{margin-top:6px;font-weight:600;color:#c8f7e8;font-size:11.5px;}",
    ".drx-qr{width:98px;height:98px;background:#fff;border-radius:8px;padding:6px;flex-shrink:0;}",
    ".drx-qr svg{display:block;width:100%;height:100%;}",
    "#drxPrintRoot{display:none;}",
    "@media print{",
    "  @page{size:A4 landscape;margin:0;}",
    "  html,body{background:#fff !important;}",
    "  body.drx-printing > *:not(#drxPrintRoot){display:none !important;}",
    "  body.drx-printing #drxPrintRoot{display:block !important;position:absolute;left:0;top:0;width:297mm;height:210mm;overflow:hidden;}",
    "  #drxPrintRoot .drx-cert-scroll{overflow:visible;}",
    "  #drxPrintRoot .drx-cert-wrap{min-width:0 !important;width:297mm !important;height:210mm !important;border-radius:0;}",
    "  #drxPrintRoot .drx-cert{transform:scale(1.1225) !important;}",
    "}"
  ].join('\n');

  function injectStyles() {
    if (document.getElementById('drxCertStyles')) return;
    var s = document.createElement('style');
    s.id = 'drxCertStyles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function safeUrl(u) {
    u = String(u || '');
    return /^(https?:\/\/|data:image\/)/i.test(u) ? esc(u) : '';
  }
  function ordinalDate(d) {
    var dt = new Date(d);
    if (isNaN(dt.getTime())) return '—';
    var day = dt.getDate();
    var suf = (day % 100 >= 11 && day % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] || 'th');
    return day + suf + ' ' + dt.toLocaleDateString('en-GB', { month: 'long' }) + ', ' + dt.getFullYear();
  }
  // "Certificate of Completion" -> ["CERTIFICATE", "OF COMPLETION"]; anything else stays on one line
  function splitTitle(title) {
    var t = String(title || 'Certificate of Completion').trim();
    var m = /^certificate\s+(of\s+.+)$/i.exec(t);
    return m ? ['Certificate', m[1]] : [t, ''];
  }
  function nameSize(name) {
    var n = String(name || '').length;
    return n <= 22 ? 30 : n <= 30 ? 26 : n <= 40 ? 21 : 17;
  }

  // Fallback logo mark (used when no site logo is configured in admin settings)
  function markSvg(size) {
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">' +
      '<defs><linearGradient id="dm' + size + '" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7C6EF7"/><stop offset="1" stop-color="#3b2fa8"/></linearGradient></defs>' +
      '<rect width="48" height="48" rx="12" fill="url(#dm' + size + ')"/>' +
      '<path d="M15 12h9.5c7.2 0 11.5 4.3 11.5 12S31.7 36 24.5 36H15z" fill="none" stroke="#fff" stroke-width="5" stroke-linejoin="round"/>' +
      '<circle cx="37" cy="12" r="4" fill="#06D6A0"/></svg>';
  }

  function sealSvg(id) {
    var cid = 'drxSealPath' + id;
    return '<svg class="drx-seal" viewBox="0 0 176 176" xmlns="http://www.w3.org/2000/svg">' +
      '<defs><path id="' + cid + '" d="M 88 88 m -66 0 a 66 66 0 1 1 132 0 a 66 66 0 1 1 -132 0"/>' +
      '<linearGradient id="drxSealG' + id + '" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7C6EF7"/><stop offset="1" stop-color="#3b2fa8"/></linearGradient></defs>' +
      '<circle cx="88" cy="88" r="84" fill="none" stroke="#5a4bdc" stroke-width="1.5" stroke-dasharray="2 4"/>' +
      '<circle cx="88" cy="88" r="52" fill="url(#drxSealG' + id + ')"/>' +
      '<circle cx="88" cy="88" r="46" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1.2"/>' +
      '<text font-family="Poppins,Inter,Arial,sans-serif" font-size="12.5" font-weight="600" letter-spacing="3.6" fill="#3b2fa8">' +
      '<textPath href="#' + cid + '" startOffset="8%">CERTIFICATE OF COMPLETION</textPath></text>' +
      '<g transform="translate(64 64)">' + markSvg(48).replace(/<rect[^>]*\/>/, '<rect width="48" height="48" rx="24" fill="rgba(255,255,255,.14)"/>') + '</g>' +
      '</svg>';
  }

  function bgSvg() {
    return '<svg class="drx-bg" viewBox="0 0 1000 707" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">' +
      '<g fill="none" stroke="#5a4bdc" stroke-opacity=".055" stroke-width="2">' +
      '<circle cx="960" cy="60" r="140"/><circle cx="960" cy="60" r="200"/><circle cx="960" cy="60" r="260"/><circle cx="960" cy="60" r="320"/>' +
      '<circle cx="20" cy="560" r="120"/><circle cx="20" cy="560" r="180"/><circle cx="20" cy="560" r="240"/><circle cx="20" cy="560" r="300"/></g></svg>';
  }

  function sigBlock(name, logo) {
    var url = safeUrl(logo);
    return '<div class="drx-sig"><div class="drx-sig-logo">' + (url ? '<img src="' + url + '" alt=""/>' : '') +
      '</div><div class="drx-sig-line"></div><div class="drx-sig-name">' + esc(name) + '</div></div>';
  }

  function render(o) {
    o = o || {};
    injectStyles();
    var id = ++uid;
    var t = splitTitle(o.title);
    var trackName = o.trackName || 'Tech Talent Programme';
    var certId = o.certId || '';
    var origin = (typeof location !== 'undefined' && location.origin) ? location.origin : '';
    var verifyUrl = origin + '/verify?id=' + encodeURIComponent(certId);
    var qr = '';
    try { qr = DrixQR.svg(verifyUrl, { dark: '#1c1d2e', light: '#ffffff' }); } catch (e) { qr = ''; }

    var logoUrl = safeUrl(o.logoUrl);
    var brand = (logoUrl ? '<img src="' + logoUrl + '" alt="' + FOUNDATION + '"/>' : markSvg(50)) +
      '<div class="drx-wm"><b>DRIX<i> Tech</i></b><span>Foundation</span></div>';

    var score = (o.score !== undefined && o.score !== null && o.score !== '') ? ' · ' + esc(o.score) + '%' : '';

    return '' +
      '<div class="drx-cert-scroll"><div class="drx-cert-wrap"><div class="drx-cert" data-cert-id="' + esc(certId) + '">' +
        bgSvg() +
        '<div class="drx-ribbon"></div>' +
        '<div class="drx-brand">' + brand + '</div>' +
        '<div class="drx-presents"><b>' + FOUNDATION + '</b> presents this</div>' +
        '<div class="drx-title"><div class="t1">' + esc(t[0]) + '</div>' + (t[1] ? '<div class="t2">' + esc(t[1]) + '</div>' : '') + '</div>' +
        (safeUrl(o.photo) ? '<img class="drx-photo" src="' + safeUrl(o.photo) + '" alt=""/>' : '') +
        sealSvg(id) +
        '<div class="drx-awarded">Proudly awarded to</div>' +
        '<div class="drx-name" style="font-size:' + nameSize(o.fellowName) + 'px;">' + esc(o.fellowName || '—') + '</div>' +
        '<div class="drx-body">For successfully completing the <b>' + FOUNDATION + '</b> Tech Talent Programme in <b>' + esc(trackName) + '</b> and meeting all the programme\'s requirements.</div>' +
        '<div class="drx-meta">Date of Issue: <span>' + esc(ordinalDate(o.issuedAt)) + '</span><br/>Result: <span>' + esc(o.grade || 'Pass') + score + '</span></div>' +
        '<div class="drx-band">' +
          '<div class="drx-sigs">' + sigBlock(o.sig1_name || FOUNDATION + ' Management', o.sig1_logo) + sigBlock(o.sig2_name || 'ePayBillz Management', o.sig2_logo) + '</div>' +
          '<div class="drx-verify"><div class="drx-vtext"><div class="lead">You can verify this certificate by scanning this QR code</div>' +
            '<div class="id"><em>Unique ID</em><strong>' + esc(certId) + '</strong></div><div class="tag">#DrixTechTalent</div></div>' +
            (qr ? '<div class="drx-qr">' + qr + '</div>' : '') + '</div>' +
        '</div>' +
      '</div></div></div>';
  }

  // Scale each certificate to the width of its container (design is 1000px wide)
  function fit(scope) {
    (scope || document).querySelectorAll('.drx-cert-wrap').forEach(function (wrap) {
      var cert = wrap.firstElementChild;
      if (!cert) return;
      var k = wrap.clientWidth / W;
      if (!k) return;
      cert.style.transform = 'scale(' + k + ')';
      wrap.style.height = (H * k) + 'px';
    });
  }

  // Print / save as PDF: clone the certificate into a print-only root so page layout never interferes
  function print(wrapEl) {
    var src = wrapEl && wrapEl.closest ? (wrapEl.closest('.drx-cert-scroll') || wrapEl) : wrapEl;
    if (!src) return;
    var old = document.getElementById('drxPrintRoot');
    if (old) old.remove();
    var host = document.createElement('div');
    host.id = 'drxPrintRoot';
    // The on-screen copy is hidden while printing; give the clone its own SVG ids so gradients/paths still resolve
    host.innerHTML = src.outerHTML.replace(/(drxSealPath\d+|drxSealG\d+|dm\d+)/g, '$1p');
    document.body.appendChild(host);
    document.body.classList.add('drx-printing');
    setTimeout(function () { window.print(); }, 60);
  }
  function cleanup() {
    document.body.classList.remove('drx-printing');
    var host = document.getElementById('drxPrintRoot');
    if (host) host.remove();
    fit();
  }
  window.addEventListener('afterprint', cleanup);
  window.addEventListener('resize', function () { fit(); });

  var brandingCache = null;
  function loadBranding() {
    if (brandingCache) return brandingCache;
    var base = (typeof API_BASE !== 'undefined') ? API_BASE : '';
    brandingCache = fetch(base + '/api/admin/settings/public')
      .then(function (r) { return r.json(); })
      .then(function (s) { return { logo: (s && s.site_logo) || '' }; })
      .catch(function () { return { logo: '' }; });
    return brandingCache;
  }

  root.DrixCertificate = { render: render, fit: fit, print: print, loadBranding: loadBranding, ordinalDate: ordinalDate };
})(window);
