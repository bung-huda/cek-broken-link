// api/check.js - cek status sekumpulan URL (maksimal 10 per permintaan)
const { UA, cors, rateLimited, send, assertPublic } = require('./_lib');

const MAX_BATCH = 10;
const TIMEOUT = 8000;
const MAX_HOPS = 6;

async function checkOne(url) {
  const t0 = Date.now();
  let cur = url, method = 'HEAD', hops = 0, res;
  try {
    for (let guard = 0; guard < MAX_HOPS * 2; guard++) {
      await assertPublic(cur);
      res = await fetch(cur, {
        method, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT),
        headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'id,en;q=0.8' }
      });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        try { res.body && res.body.cancel(); } catch (e) {}
        if (++hops > MAX_HOPS) return out('broken', res.status, 'Terlalu banyak redirect');
        cur = new URL(loc, cur).href; method = 'HEAD'; continue;
      }
      // Banyak server menolak HEAD; ulangi dengan GET sebelum menyimpulkan rusak.
      if (method === 'HEAD' && res.status >= 400) {
        try { res.body && res.body.cancel(); } catch (e) {}
        method = 'GET'; continue;
      }
      break;
    }
    try { res.body && res.body.cancel(); } catch (e) {}
    const s = res.status;
    if (s >= 200 && s < 300) return out(hops ? 'redirect' : 'ok', s);
    if (s === 401 || s === 403 || s === 429 || s === 999) return out('limited', s, 'Server membatasi pengecekan otomatis');
    if (s === 404 || s === 410) return out('broken', s, 'Halaman tidak ditemukan');
    if (s >= 500) return out('broken', s, 'Server error');
    if (s >= 400) return out('broken', s, 'Permintaan ditolak');
    return out('broken', s, 'Respons tidak dikenali');
  } catch (e) {
    const code = String((e.cause && e.cause.code) || e.code || '');
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return out('timeout', 0, 'Server tidak menjawab dalam ' + TIMEOUT / 1000 + ' detik');
    if (/ENOTFOUND|EAI_AGAIN/.test(code) || /ENOTFOUND/.test(e.message)) return out('broken', 0, 'Domain tidak ditemukan');
    if (/ECONNREFUSED/.test(code)) return out('broken', 0, 'Koneksi ditolak');
    if (/ECONNRESET|UND_ERR_SOCKET/.test(code)) return out('timeout', 0, 'Koneksi terputus');
    if (/CERT|SSL|TLS|ERR_SSL/.test(code + e.message)) return out('broken', 0, 'Masalah sertifikat SSL');
    if (/tidak diizinkan|tidak valid|didukung/.test(e.message)) return out('broken', 0, e.message);
    return out('broken', 0, 'Gagal terhubung');
  }
  function out(category, status, error) {
    return { url, category, status, ms: Date.now() - t0, finalUrl: cur !== url ? cur : null, redirects: hops, error: error || null };
  }
}

module.exports = async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return send(res, 405, { error: 'Gunakan metode POST.' });
  if (rateLimited(req, 120)) return send(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi sebentar lagi.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const urls = body && Array.isArray(body.urls) ? body.urls : null;
  if (!urls || !urls.length) return send(res, 400, { error: 'Daftar URL kosong.' });

  const list = Array.from(new Set(urls.map(String))).slice(0, MAX_BATCH);
  const results = await Promise.all(list.map(checkOne));
  send(res, 200, { results });
};
