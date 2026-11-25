// api/extract.js - ambil satu halaman dan kumpulkan semua link di dalamnya
const { UA, cors, rateLimited, send, assertPublic } = require('./_lib');

const MAX_LINKS = 500;
const MAX_BYTES = 3 * 1024 * 1024;

const decode = s => String(s || '')
  .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#0?39;/g, "'")
  .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ');

function attr(tag, name) {
  const m = tag.match(new RegExp('(?:^|[\\s"\'])' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
  return m ? decode(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]).trim() : null;
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (rateLimited(req, 30)) return send(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi sebentar lagi.' });

  const target = String((req.query && req.query.url) || '');
  const types = new Set(String((req.query && req.query.types) || 'a,img').split(','));
  let page;
  try { page = await assertPublic(target); }
  catch (e) { return send(res, 400, { error: 'URL tidak diizinkan: ' + e.message }); }

  const t0 = Date.now();
  let r, html;
  try {
    // Ikuti redirect secara manual agar setiap tujuan tetap divalidasi.
    let cur = page.href;
    for (let i = 0; i < 5; i++) {
      await assertPublic(cur);
      r = await fetch(cur, {
        redirect: 'manual', signal: AbortSignal.timeout(10000),
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' }
      });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
        cur = new URL(r.headers.get('location'), cur).href; continue;
      }
      page = new URL(cur); break;
    }
    const ct = r.headers.get('content-type') || '';
    if (!r.ok) return send(res, 502, { error: 'Halaman mengembalikan status HTTP ' + r.status + '.' });
    if (ct && !/html|xml/i.test(ct)) return send(res, 400, { error: 'URL ini bukan halaman HTML (' + ct.split(';')[0] + ').' });
    html = (await r.text()).slice(0, MAX_BYTES);
  } catch (e) {
    const msg = e.name === 'TimeoutError' ? 'Halaman terlalu lama merespons.' :
      /ENOTFOUND|EAI_AGAIN/.test(String(e.cause && e.cause.code || e.message)) ? 'Domain tidak ditemukan.' :
      'Tidak dapat mengambil halaman: ' + e.message;
    return send(res, 502, { error: msg });
  }

  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim().slice(0, 150);
  let base = page.href;
  const bt = html.match(/<base\b[^>]*>/i);
  if (bt) { const b = attr(bt[0], 'href'); if (b) { try { base = new URL(b, page.href).href; } catch (e) {} } }

  const map = new Map();
  let overflow = false;
  const add = (raw, type, text) => {
    if (!raw) return;
    raw = raw.trim();
    if (!raw || raw[0] === '#' || /^(mailto|tel|javascript|data|sms|whatsapp|blob|about):/i.test(raw)) return;
    let u;
    try { u = new URL(raw, base); } catch (e) { return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    u.hash = '';
    const key = u.href;
    const ex = map.get(key);
    if (ex) { ex.count++; if (!ex.text && text) ex.text = text; return; }
    if (map.size >= MAX_LINKS) { overflow = true; return; }
    map.set(key, { url: key, type, text: text || '', internal: u.hostname.replace(/^www\./, '') === page.hostname.replace(/^www\./, ''), count: 1 });
  };

  if (types.has('a')) {
    const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi; let m;
    while ((m = re.exec(html))) {
      const tag = '<a ' + m[1] + '>';
      let text = decode(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      if (!text) { const al = (m[2].match(/<img\b[^>]*\balt\s*=\s*["']([^"']+)["']/i) || [])[1]; text = al ? '[gambar] ' + decode(al) : ''; }
      add(attr(tag, 'href'), 'a', text.slice(0, 90));
    }
    // area map
    const ra = /<area\b[^>]*>/gi; let a;
    while ((a = ra.exec(html))) add(attr(a[0], 'href'), 'a', '');
  }
  if (types.has('img')) {
    const re = /<img\b[^>]*>/gi; let m;
    while ((m = re.exec(html))) {
      add(attr(m[0], 'src') || attr(m[0], 'data-src') || attr(m[0], 'data-lazy-src'), 'img', decode(attr(m[0], 'alt') || '').slice(0, 90));
    }
  }
  if (types.has('css')) {
    const re = /<link\b[^>]*>/gi; let m;
    while ((m = re.exec(html))) if (/stylesheet/i.test(attr(m[0], 'rel') || '')) add(attr(m[0], 'href'), 'css', '');
  }
  if (types.has('js')) {
    const re = /<script\b[^>]*>/gi; let m;
    while ((m = re.exec(html))) add(attr(m[0], 'src'), 'js', '');
  }

  const links = Array.from(map.values());
  send(res, 200, {
    page: { url: page.href, title, status: r.status, ms: Date.now() - t0 },
    links,
    notes: overflow ? ['Halaman memiliki lebih dari ' + MAX_LINKS + ' link; hanya ' + MAX_LINKS + ' pertama yang diambil.'] : []
  });
};
