// api/_lib.js - fungsi bersama (CORS, rate limit, perlindungan SSRF)
const dns = require('dns').promises;
const net = require('net');

const UA = 'Mozilla/5.0 (compatible; CekBrokenLink/1.0; +https://example.com/bot)';
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);
const hits = new Map();

function cors(req, res) {
  // Ganti '*' dengan domain Blogger Anda agar hanya blog Anda yang bisa memakai API ini,
  // misalnya: https://namablog.blogspot.com
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return true; }
  return false;
}

// Batas per IP: LIMIT permintaan per menit (memori instance, cukup untuk skala kecil).
function rateLimited(req, limit) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => t > now - 60000);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > (limit || 60);
}

function send(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === '::1' || s === '::') return true;
    if (s.startsWith('::ffff:')) return isPrivateIp(s.slice(7));
    return s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe8') ||
      s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb');
  }
  return true;
}

// Tolak URL non-http(s), port aneh, dan host yang mengarah ke jaringan privat.
async function assertPublic(href) {
  let u;
  try { u = new URL(href); } catch (e) { throw new Error('URL tidak valid'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Protokol tidak didukung');
  if (!ALLOWED_PORTS.has(u.port)) throw new Error('Port tidak diizinkan');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Alamat tidak diizinkan');
    return u;
  }
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('Alamat tidak diizinkan');
  return u;
}

module.exports = { UA, cors, rateLimited, send, assertPublic };
