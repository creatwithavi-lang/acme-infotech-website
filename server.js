const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool, types } = require('pg');
const sanitizeHtmlLib = require('sanitize-html');
const { put } = require('@vercel/blob');

const ROOT = __dirname;

// Local development only: read a few known keys from .env.local (never overrides real environment variables).
function loadLocalEnv() {
  const envFile = path.join(ROOT, '.env.local');
  if (!fs.existsSync(envFile)) return;
  const allowed = new Set([
    'BLOB_READ_WRITE_TOKEN', 'SESSION_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'POSTGRES_URL', 'DATABASE_URL'
  ]);
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match || !allowed.has(match[1]) || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

loadLocalEnv();

const IS_VERCEL = Boolean(process.env.VERCEL);
const IS_PROD = IS_VERCEL || process.env.NODE_ENV === 'production';
const UPLOAD_DIR = path.join(ROOT, 'uploads', 'blogs'); // local development only (production uses Vercel Blob)
const PORT = Number(process.env.PORT || 3000);
const SITE_URL = 'https://www.acmeinfotechsecuritysystem.com';
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const IST_OFFSET_MIN = 330; // admin date/time fields are entered in Indian Standard Time
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

// A public, hard-coded fallback secret would let anyone forge an admin cookie, so we never use one.
const SESSION_SECRET = process.env.SESSION_SECRET
  || process.env.ADMIN_PASSWORD
  || process.env.POSTGRES_URL
  || process.env.DATABASE_URL
  || (IS_PROD ? '' : crypto.randomBytes(32).toString('hex'));
if (!process.env.SESSION_SECRET && IS_PROD) {
  console.warn('WARNING: SESSION_SECRET is not set. Add a long random value in your environment variables.');
}

const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif'
};
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4'
};

/* ------------------------------------------------------------------ */
/* Database (PostgreSQL)                                               */
/* ------------------------------------------------------------------ */

// Errors whose message is safe to show to visitors (they only contain setup instructions, never secrets).
class ConfigError extends Error {}

// "TIMESTAMP" columns have no time zone. We always store UTC, so always read them back as UTC.
types.setTypeParser(1114, value => new Date(`${value.replace(' ', 'T')}Z`));

const DATABASE_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL;
let pool = null;
if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL, max: IS_VERCEL ? 2 : 10, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000 });
  pool.on('error', err => console.error('Postgres pool error:', err.message));
} else if (!IS_PROD) {
  const { PGlite } = require('@electric-sql/pglite');
  pool = new PGlite(path.join(ROOT, 'local-pgdata'));
}

// Write SQL with "?" placeholders; they are converted to $1, $2 ... in order.
// (Do not mix "?" with hand-written "$1" placeholders in the same query.)
function toPgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function runQuery(sql, args = []) {
  if (!pool) throw new ConfigError('Database is not configured. Set POSTGRES_URL (or DATABASE_URL) in the environment variables.');
  return pool.query(toPgSql(sql), args);
}

const db = {
  prepare: sql => ({
    get: async (...args) => (await runQuery(sql, args)).rows[0] || null,
    all: async (...args) => (await runQuery(sql, args)).rows,
    run: async (...args) => { await runQuery(sql, args); return true; }
  }),
  exec: async sql => {
    if (!pool) throw new ConfigError('Database is not configured. Set POSTGRES_URL (or DATABASE_URL) in the environment variables.');
    if (pool.exec) {
      await pool.exec(sql);
    } else {
      await pool.query(sql);
    }
  }
};

async function openDatabase() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      password TEXT NOT NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'admin',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      slug VARCHAR(255) NOT NULL UNIQUE,
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS blogs (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      slug VARCHAR(255) NOT NULL UNIQUE,
      excerpt TEXT NOT NULL,
      content TEXT NOT NULL,
      featured_image TEXT,
      featured_image_alt TEXT,
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      author VARCHAR(255) NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','scheduled')),
      published_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      seo_title VARCHAR(255),
      meta_description TEXT,
      focus_keyword VARCHAR(255),
      canonical_url TEXT,
      og_image TEXT,
      og_image_alt TEXT
    );
    CREATE INDEX IF NOT EXISTS blogs_status_published_idx ON blogs (status, published_at);
    CREATE TABLE IF NOT EXISTS site_meta (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT
    );
  `);
}

function nowIso() {
  return new Date().toISOString();
}

function tomorrowIso() {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const iterations = 210000;
  const digest = 'sha512';
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 64, digest).toString('hex');
  return `pbkdf2$${digest}$${iterations}$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, digest, iter, salt, hash] = String(stored).split('$');
    if (scheme !== 'pbkdf2' || !digest || !iter || !salt || !hash) return false;
    const actual = crypto.pbkdf2Sync(password, salt, Number(iter), 64, digest).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(actual, 'hex'));
  } catch {
    return false;
  }
}

const DEFAULT_ADMIN_EMAIL = 'admin@acme.local';
const DEFAULT_ADMIN_PASSWORD = 'ChangeMe@12345';

// ADMIN_EMAIL / ADMIN_PASSWORD from the environment are the source of truth for the admin login.
// Change the password in your environment variables and redeploy/restart to reset it.
async function syncAdmin() {
  const envEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const envPassword = process.env.ADMIN_PASSWORD || '';
  const userCount = async () => Number((await db.prepare('SELECT COUNT(*) AS total FROM users').get()).total);

  if (envEmail && envPassword) {
    const existing = await db.prepare('SELECT id, password FROM users WHERE email = ?').get(envEmail);
    if (!existing) {
      await db.prepare('INSERT INTO users (name,email,password,role) VALUES (?,?,?,?) ON CONFLICT (email) DO NOTHING')
        .run('ACME Admin', envEmail, hashPassword(envPassword), 'admin');
      console.log(`Admin created: ${envEmail}`);
    } else if (!verifyPassword(envPassword, existing.password)) {
      await db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(envPassword), existing.id);
      console.log(`Admin password updated from environment for: ${envEmail}`);
    }
    if (envEmail !== DEFAULT_ADMIN_EMAIL) {
      const legacy = await db.prepare('SELECT id, password FROM users WHERE email = ?').get(DEFAULT_ADMIN_EMAIL);
      if (legacy && verifyPassword(DEFAULT_ADMIN_PASSWORD, legacy.password)) {
        await db.prepare('DELETE FROM users WHERE id = ?').run(legacy.id);
        console.log('Removed the default admin account (it used a well-known password).');
      }
    }
    return;
  }

  if ((await userCount()) > 0) {
    const legacy = await db.prepare('SELECT password FROM users WHERE email = ?').get(DEFAULT_ADMIN_EMAIL);
    if (IS_PROD && legacy && verifyPassword(DEFAULT_ADMIN_PASSWORD, legacy.password)) {
      console.error('SECURITY: the default admin password is still active. Set ADMIN_EMAIL and ADMIN_PASSWORD in your environment variables.');
    }
    return;
  }

  if (IS_PROD) {
    console.error('No admin user exists yet. Set ADMIN_EMAIL and ADMIN_PASSWORD in your environment variables and redeploy.');
    return;
  }
  await db.prepare('INSERT INTO users (name,email,password,role) VALUES (?,?,?,?) ON CONFLICT (email) DO NOTHING')
    .run('ACME Admin', DEFAULT_ADMIN_EMAIL, hashPassword(DEFAULT_ADMIN_PASSWORD), 'admin');
  console.log(`Development admin created: ${DEFAULT_ADMIN_EMAIL} / ${DEFAULT_ADMIN_PASSWORD}`);
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || crypto.randomBytes(4).toString('hex');
}

async function ensureUniqueSlug(slug, id = 0) {
  let base = slugify(slug);
  let candidate = base;
  let i = 2;
  while (await db.prepare('SELECT id FROM blogs WHERE slug = ? AND id != ?').get(candidate, id)) {
    candidate = `${base}-${i++}`;
  }
  return candidate;
}

async function seedCategoriesAndBlogs() {
  const categories = [
    ['CCTV Tips', 'cctv-tips', 'CCTV planning, placement and installation advice.'],
    ['Attendance', 'attendance', 'Biometric attendance machine guides.'],
    ['Buying Guide', 'buying-guide', 'Security product buying guidance.'],
    ['How To', 'how-to', 'Setup and troubleshooting guides.'],
    ['Business Tips', 'business-tips', 'Security advice for businesses.'],
    ['Home Security', 'home-security', 'Home and society CCTV guidance.']
  ];
  const catStmt = await db.prepare('INSERT INTO categories (name,slug,description) VALUES (?,?,?) ON CONFLICT (slug) DO NOTHING');
  for (const c of categories) await catStmt.run(...c);
  // Sample blogs are inserted only once (fresh database). Deleting them later must not bring them back.
  if (await db.prepare("SELECT value FROM site_meta WHERE key = 'sample_blogs_seeded'").get()) return;
  const blogCount = Number((await db.prepare('SELECT COUNT(*) AS total FROM blogs').get()).total);
  if (blogCount > 0) {
    await db.prepare("INSERT INTO site_meta (key,value) VALUES ('sample_blogs_seeded','1') ON CONFLICT (key) DO NOTHING").run();
    return;
  }
  const getCat = await db.prepare('SELECT id FROM categories WHERE slug = ?');
  const insert = await db.prepare(`
    INSERT INTO blogs
    (title, slug, excerpt, content, featured_image, featured_image_alt, category_id, author, status, published_at,
     seo_title, meta_description, focus_keyword, canonical_url, og_image, og_image_alt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (slug) DO NOTHING
  `);
  const rows = [
    {
      title: 'How Many CCTV Cameras Does Your Surat Business Need?',
      slug: 'cctv-camera-count-surat',
      category: 'cctv-tips',
      image: '/images/blog_cctv.png',
      focus: 'CCTV camera installation Surat',
      date: '2025-05-15T09:00:00.000Z',
      excerpt: 'A CCTV camera installation Surat guide for shops, offices, factories, warehouses, and commercial spaces.',
      content: '<p>Planning CCTV camera installation in Surat becomes easier when you map entrances, counters, blind spots, storage zones and outdoor approach points before choosing camera quantity.</p><h2>Recommended camera count</h2><table><thead><tr><th>Location</th><th>Suggested cameras</th><th>Priority coverage</th></tr></thead><tbody><tr><td>Small shop</td><td>4 cameras</td><td>Entry, billing counter, aisle, storage</td></tr><tr><td>Office</td><td>6 to 8 cameras</td><td>Reception, work area, server, passage</td></tr><tr><td>Factory or warehouse</td><td>12+ cameras</td><td>Perimeter, loading, production, stock</td></tr></tbody></table><h2>Placement matters</h2><p>A professional CCTV camera dealer in Surat studies blind spots first. Useful evidence needs the right angle, height and light.</p><blockquote>For most Surat businesses, a free site survey is the safest way to finalize camera count, DVR or NVR channels and hard disk capacity.</blockquote>'
    },
    {
      title: 'Fingerprint vs Face Recognition Attendance Machine',
      slug: 'fingerprint-vs-face-recognition-attendance-machine',
      category: 'attendance',
      image: '/images/essl_biometric.png',
      focus: 'biometric attendance machine in Surat',
      date: '2025-04-15T09:00:00.000Z',
      excerpt: 'Choose the right biometric attendance machine in Surat for staff size, hygiene, payroll, and factory use.',
      content: '<p>The best biometric attendance machine in Surat depends on staff size, work environment, hygiene needs, payroll process and how employees enter the workplace.</p><h2>Fingerprint vs face recognition</h2><table><thead><tr><th>Feature</th><th>Fingerprint</th><th>Face recognition</th></tr></thead><tbody><tr><td>Best for</td><td>Offices and showrooms</td><td>Factories and high-traffic entry</td></tr><tr><td>Use style</td><td>Touch based</td><td>Touchless</td></tr></tbody></table><h2>Final recommendation</h2><p>Choose fingerprint for simple budget-friendly attendance. Choose face recognition when speed, hygiene and rough work conditions matter.</p>'
    },
    {
      title: 'Best Night Vision CCTV Cameras for Complete Security',
      slug: 'best-night-vision-cctv-camera-surat',
      category: 'buying-guide',
      image: '/images/hikvision_dome.png',
      focus: 'night vision CCTV camera Surat',
      date: '2025-03-15T09:00:00.000Z',
      excerpt: 'A night vision CCTV camera Surat guide covering IR, ColorVu, Starlight, indoor, and outdoor use.',
      content: '<p>A night vision CCTV camera Surat setup should be selected according to light level, distance, outdoor exposure and evidence detail needed after dark.</p><h2>Camera types</h2><ul><li>IR cameras for dark shops and passages.</li><li>Color night vision for gates and parking.</li><li>Outdoor bullet cameras for longer range coverage.</li></ul><p>For outdoor Surat conditions, check IP rating, night vision distance, lens angle and warranty before buying.</p>'
    },
    {
      title: 'How to Watch Your CCTV Camera on Mobile from Anywhere',
      slug: 'watch-cctv-camera-on-mobile',
      category: 'how-to',
      image: '/images/wifi_ip_camera.png',
      focus: 'CCTV camera mobile viewing setup',
      date: '2025-02-15T09:00:00.000Z',
      excerpt: 'Step-by-step CCTV camera mobile viewing setup for Hik-Connect, DMSS, and CP Plus apps.',
      content: '<p>A correct CCTV camera mobile viewing setup lets owners check live video, playback, alerts and recordings from outside the shop or home.</p><h2>Setup steps</h2><ol><li>Create an account in the camera brand app.</li><li>Enable platform access or P2P from DVR/NVR settings.</li><li>Scan the QR code from the device menu.</li><li>Test viewing on mobile data.</li></ol>'
    },
    {
      title: 'How Biometric Attendance Saves Surat Businesses Time and Money',
      slug: 'biometric-attendance-system-surat-savings',
      category: 'business-tips',
      image: '/images/zkteco_face.png',
      focus: 'biometric attendance system Surat',
      date: '2025-01-15T09:00:00.000Z',
      excerpt: 'A biometric attendance system Surat guide for reducing proxy attendance, payroll errors, and HR workload.',
      content: '<p>A biometric attendance system Surat setup creates accurate attendance records that are easier to verify.</p><h2>Where savings come from</h2><ul><li>Less proxy attendance.</li><li>Faster monthly payroll calculation.</li><li>Clear late coming and early going reports.</li><li>Reduced register mistakes.</li></ul>'
    },
    {
      title: 'Best CCTV Setup for Surat Homes, Bungalows and Societies',
      slug: 'home-cctv-camera-setup-surat',
      category: 'home-security',
      image: '/images/wifi_ip_camera.png',
      focus: 'home CCTV camera setup Surat',
      date: '2024-12-15T09:00:00.000Z',
      excerpt: 'Plan a home CCTV camera setup Surat residents can use for gates, parking, lobbies, and apartment entrances.',
      content: '<p>A home CCTV camera setup Surat families can depend on should cover entry points, parking, staircases, gates and daily movement without invading privacy.</p><h2>Best camera points</h2><ul><li>Main gate and visitor entry.</li><li>Parking area and vehicle approach.</li><li>Back door or side passage.</li><li>Terrace access and boundary corners.</li></ul>'
    }
  ];
  for (const b of rows) await insert.run(
    b.title, b.slug, b.excerpt, b.content, b.image, b.title, (await getCat.get(b.category)).id, 'Acme Infotech Security System',
    'published', b.date, b.title, b.excerpt, b.focus, `https://www.acmeinfotechsecuritysystem.com/blog/${b.slug}`,
    b.image, b.title
  );
  await db.prepare("INSERT INTO site_meta (key,value) VALUES ('sample_blogs_seeded','1') ON CONFLICT (key) DO NOTHING").run();
}



let dbReadyPromise = null;
function ensureDbReady() {
  if (!dbReadyPromise) {
    dbReadyPromise = (async () => {
      await openDatabase();
      await syncAdmin();
      await seedCategoriesAndBlogs();
    })().catch(err => {
      dbReadyPromise = null; // retry on the next request instead of failing forever
      throw err;
    });
  }
  return dbReadyPromise;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[ch]));
}

// Blog HTML comes from the admin editor, but it is rendered on the public site, so it is always sanitized
// with a real HTML sanitizer (allow-list) instead of regular expressions.
const SANITIZE_OPTIONS = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup',
    'ul', 'ol', 'li', 'a', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    'img', 'figure', 'figcaption', 'iframe'
  ],
  allowedAttributes: {
    '*': ['class'],
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    iframe: ['src', 'width', 'height', 'title', 'allow', 'allowfullscreen', 'frameborder'],
    th: ['colspan', 'rowspan'],
    td: ['colspan', 'rowspan']
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowProtocolRelative: false,
  allowedIframeHostnames: ['www.youtube.com', 'www.youtube-nocookie.com', 'player.vimeo.com']
};

function sanitizeHtml(html) {
  return sanitizeHtmlLib(String(html || ''), SANITIZE_OPTIONS);
}

function plainText(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    try {
      out[decodeURIComponent(part.slice(0, idx).trim())] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch { /* ignore malformed cookie */ }
  }
  return out;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function signValue(value) {
  if (!SESSION_SECRET) throw new ConfigError('SESSION_SECRET is not configured. Add it in the environment variables and redeploy.');
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function createSessionCookie(admin) {
  const payload = JSON.stringify({
    user_id: admin.id,
    name: admin.name,
    email: admin.email,
    role: admin.role,
    csrf_token: crypto.randomBytes(24).toString('hex'),
    expires_at: Date.now() + SESSION_TTL_MS
  });
  const encoded = Buffer.from(payload).toString('base64url');
  return `${encoded}.${signValue(encoded)}`;
}

function verifySessionCookie(value) {
  const [encoded, signature] = String(value || '').split('.');
  if (!encoded || !signature || !safeEqual(signValue(encoded), signature)) return null;
  try {
    const session = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!session.expires_at || session.expires_at < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

function send(res, status, body, type = 'text/html; charset=utf-8', headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}

// Admin pages must never be cached or indexed.
function sendAdmin(res, status, body, type = 'text/html; charset=utf-8') {
  send(res, status, body, type, { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
}

function redirect(res, location, status = 302) {
  if (res.headersSent) return;
  res.writeHead(status, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) tooLarge = true; // keep reading (and discard) so a proper error page can still be sent
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (!tooLarge) return resolve(Buffer.concat(chunks));
      const err = new Error('Request too large');
      err.statusCode = 413;
      reject(err);
    });
    req.on('error', reject);
  });
}

function parseUrlEncoded(buffer) {
  return Object.fromEntries(new URLSearchParams(buffer.toString('utf8')));
}

// Parses a multipart/form-data body. The delimiter is taken from the first line of the body itself, so it keeps
// working even if a proxy changes the Content-Type header.
function parseMultipart(buffer) {
  const fields = {};
  const files = {};
  const lineEnd = buffer.indexOf('\r\n');
  if (lineEnd < 3 || lineEnd > 200) return { fields, files };
  const delimiter = buffer.subarray(0, lineEnd); // "--boundary"
  const separator = Buffer.concat([Buffer.from('\r\n'), delimiter]); // "\r\n--boundary"
  let pos = lineEnd + 2;
  while (pos < buffer.length) {
    const next = buffer.indexOf(separator, pos);
    if (next === -1) break;
    const part = buffer.subarray(pos, next);
    const headEnd = part.indexOf('\r\n\r\n');
    if (headEnd !== -1) {
      const header = part.subarray(0, headEnd).toString('utf8');
      const body = part.subarray(headEnd + 4);
      const nameMatch = /\bname="([^"]*)"/i.exec(header);
      if (nameMatch) {
        const fileMatch = /\bfilename="([^"]*)"/i.exec(header);
        if (fileMatch) {
          const mime = /Content-Type:\s*([^\r\n]+)/i.exec(header)?.[1]?.trim() || 'application/octet-stream';
          files[nameMatch[1]] = { filename: fileMatch[1], mime, buffer: body };
        } else {
          fields[nameMatch[1]] = body.toString('utf8');
        }
      }
    }
    pos = next + separator.length;
    if (buffer[pos] === 45 && buffer[pos + 1] === 45) break; // closing "--"
    pos += 2; // skip the CRLF after the delimiter
  }
  return { fields, files };
}

// Reads a POST body (urlencoded or multipart) into { fields, files }.
async function readForm(req) {
  const contentType = req.headers['content-type'] || '';
  let raw = req.body; // undefined on a plain Node server; may be pre-parsed by some platforms
  if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw)) return { fields: raw, files: {} };
  if (typeof raw === 'string') raw = Buffer.from(raw);
  if (!Buffer.isBuffer(raw)) raw = await readBody(req);
  return /multipart\/form-data/i.test(contentType)
    ? parseMultipart(raw)
    : { fields: parseUrlEncoded(raw), files: {} };
}

const loginFailures = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

function loginBlocked(ip) {
  const rec = loginFailures.get(ip);
  return Boolean(rec && rec.count >= 8 && Date.now() - rec.first < LOGIN_WINDOW_MS);
}

function recordLoginFailure(ip) {
  const now = Date.now();
  if (loginFailures.size > 1000) loginFailures.clear();
  const rec = loginFailures.get(ip);
  if (!rec || now - rec.first > LOGIN_WINDOW_MS) loginFailures.set(ip, { count: 1, first: now });
  else rec.count += 1;
}

async function currentUser(req) {
  const session = verifySessionCookie(parseCookies(req).sid);
  if (!session) return null;
  const admin = await db.prepare('SELECT id, name, email, role FROM users WHERE email = ?').get(String(session.email || '').toLowerCase());
  if (!admin || admin.role !== 'admin') return null;
  return { ...admin, csrf_token: session.csrf_token, expires_at: session.expires_at };
}

async function requireAdmin(req, res) {
  const user = await currentUser(req);
  if (!user || user.role !== 'admin') {
    redirect(res, '/admin/login');
    return null;
  }
  return user;
}

function csrfOk(user, form) {
  return Boolean(user && user.csrf_token && safeEqual(String(form.csrf || '').trim(), user.csrf_token));
}

const FLASH = {
  saved: ['ok', 'Blog saved successfully.'],
  deleted: ['ok', 'Blog deleted.'],
  published: ['ok', 'Blog is now published.'],
  unpublished: ['ok', 'Blog moved to draft (unpublished).'],
  category_added: ['ok', 'Category added.'],
  category_exists: ['error', 'A category with that name or slug already exists.'],
  category_invalid: ['error', 'Category name is required.']
};

function flashHtml(key) {
  const flash = FLASH[key];
  if (!flash) return '';
  return `<div class="${flash[0] === 'ok' ? 'notice' : 'alert'}">${escapeHtml(flash[1])}</div>`;
}

function adminLayout(title, user, content) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)} | ACME Admin</title><link rel="stylesheet" href="/admin/admin.css"><script src="/admin/admin.js" defer></script></head><body><div class="admin-shell"><aside class="admin-side"><a class="admin-brand" href="/admin"><span>AI</span><strong>ACME CMS</strong></a><nav><a href="/admin">Dashboard</a><a href="/admin/blogs">Blogs</a><a href="/admin/blogs/new">Add New Blog</a><a href="/admin/categories">Categories</a><a href="/blog" target="_blank">Public Blog</a></nav></aside><div class="admin-main"><header class="admin-top"><div><p>Logged in as</p><strong>${escapeHtml(user.name)} · ${escapeHtml(user.email)}</strong></div><form method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${escapeHtml(user.csrf_token)}"><button class="btn ghost" type="submit">Logout</button></form></header>${content}</div></div></body></html>`;
}

function loginPage(error = '', hint = '') {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="robots" content="noindex,nofollow"><title>Admin Login | ACME Infotech CCTV</title><link rel="stylesheet" href="/admin/admin.css"></head><body class="login-body"><main class="login-card"><div class="login-mark">AI</div><h1>Admin Login</h1><p>Secure blog management for ACME Infotech CCTV.</p>${error ? `<div class="alert">${escapeHtml(error)}</div>` : ''}${hint ? `<div class="alert">${escapeHtml(hint)}</div>` : ''}<form method="post" action="/admin/login"><label>Email / Username<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button class="btn primary full" type="submit">Login</button></form></main></body></html>`;
}

async function categoryOptions(selected) {
  return (await db.prepare('SELECT * FROM categories ORDER BY name').all()).map(c => `<option value="${c.id}" ${String(c.id) === String(selected || '') ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
}

async function blogForm(user, blog = {}, error = '') {
  const isEdit = Boolean(blog.id);
  const action = isEdit ? `/admin/blogs/${blog.id}/edit` : '/admin/blogs/new';
  const title = isEdit ? 'Edit Blog' : 'Add New Blog';
  return adminLayout(title, user, `<section class="page-head"><div><h1>${title}</h1><p>Create SEO-ready public blog posts with images, categories and rich content.</p></div><a class="btn ghost" href="/admin/blogs">Back</a></section>${error ? `<div class="alert">${escapeHtml(error)}</div>` : ''}<form class="editor-form" method="post" action="${action}" enctype="multipart/form-data"><input type="hidden" name="csrf" value="${escapeHtml(user.csrf_token)}"><div class="form-grid"><label>Blog Title<input name="title" id="titleInput" required value="${escapeHtml(blog.title || '')}"></label><label>URL Slug<input name="slug" id="slugInput" required value="${escapeHtml(blog.slug || '')}"></label><label class="wide">Short Description / Excerpt<textarea name="excerpt" rows="3" required>${escapeHtml(blog.excerpt || '')}</textarea></label><label>Featured Image<input name="featured_image" type="file" accept="image/png,image/jpeg,image/webp,image/gif"><small>JPG, PNG, WEBP or GIF (max 3MB). Big photos are resized automatically.</small>${blog.featured_image ? `<small>Current image: ${escapeHtml(blog.featured_image)} (choose a file only if you want to replace it)</small>` : ''}</label><label>Featured Image Alt Text<input name="featured_image_alt" value="${escapeHtml(blog.featured_image_alt || '')}"></label><label>Blog Category<select name="category_id" required>${await categoryOptions(blog.category_id)}</select></label><label>Author<input name="author" required value="${escapeHtml(blog.author || 'Acme Infotech Security System')}"></label><label>Publish / Schedule Date<input name="published_at" type="datetime-local" value="${escapeHtml(toLocalInput(blog.published_at))}"><small>Time India (IST) ma che. Scheduled blog aa date/time sudhi public website par nahi dekhay.</small></label><label>Status<select name="status"><option value="draft" ${blog.status !== 'published' && blog.status !== 'scheduled' ? 'selected' : ''}>Draft</option><option value="scheduled" ${blog.status === 'scheduled' ? 'selected' : ''}>Scheduled</option><option value="published" ${blog.status === 'published' ? 'selected' : ''}>Published</option></select></label><label>SEO Title<input name="seo_title" value="${escapeHtml(blog.seo_title || '')}"></label><label class="wide">Meta Description<textarea name="meta_description" rows="3">${escapeHtml(blog.meta_description || '')}</textarea></label><label>Focus Keyword<input name="focus_keyword" value="${escapeHtml(blog.focus_keyword || '')}"></label><label>Canonical URL<input name="canonical_url" value="${escapeHtml(blog.canonical_url || '')}"></label><label>Open Graph Image<input name="og_image_file" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label><label>OG Image Alt Text<input name="og_image_alt" value="${escapeHtml(blog.og_image_alt || '')}"></label></div><section class="editor-box"><div class="toolbar"><button type="button" data-cmd="formatBlock" data-value="h1">H1</button><button type="button" data-cmd="formatBlock" data-value="h2">H2</button><button type="button" data-cmd="formatBlock" data-value="h3">H3</button><button type="button" data-cmd="bold">B</button><button type="button" data-cmd="italic">I</button><button type="button" data-cmd="insertUnorderedList">List</button><button type="button" data-cmd="insertOrderedList">1. List</button><button type="button" data-action="link">Link</button><button type="button" data-action="quote">Quote</button><button type="button" data-action="table">Table</button><button type="button" data-action="youtube">YouTube</button><button type="button" data-action="image">Image</button><button type="button" data-action="code">HTML</button></div><input id="editorImageInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden><div id="editor" class="rich-editor" contenteditable="true" data-placeholder="Write your blog content here...">${sanitizeHtml(blog.content || '')}</div><textarea name="content" id="contentInput" hidden></textarea></section><div class="form-actions"><button class="btn primary" type="submit">${isEdit ? 'Update Blog' : 'Save Blog'}</button><a class="btn ghost" href="/admin/blogs">Cancel</a></div></form>`);
}

// Dates are stored in UTC. The admin form uses Indian Standard Time (IST).
function toLocalInput(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() + IST_OFFSET_MIN * 60000).toISOString().slice(0, 16);
}

// "2026-09-20T15:30" (IST) -> ISO string in UTC. Returns null when the value is not a valid date.
function fromLocalInput(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  const d = new Date(`${v}${v.length === 16 ? ':00' : ''}+05:30`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function detectImageType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

async function saveImage(file) {
  if (!file || !file.filename || file.buffer.length === 0) return '';
  if (file.buffer.length > MAX_IMAGE_BYTES) throw new Error('Image must be smaller than 3MB.');
  const mime = detectImageType(file.buffer); // check the real file content, not just the browser-provided type
  if (!mime) throw new Error('Only JPG, PNG, WEBP and GIF images are allowed.');
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${MIME_EXT[mime]}`;
  if (IS_VERCEL || process.env.BLOB_READ_WRITE_TOKEN) {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      throw new Error('Image storage is not configured. In Vercel: Storage -> create/connect a Blob store (adds BLOB_READ_WRITE_TOKEN), then redeploy.');
    }
    const blob = await put(`blogs/${filename}`, file.buffer, {
      access: 'public',
      contentType: mime,
      token: process.env.BLOB_READ_WRITE_TOKEN
    });
    return blob.url;
  }
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), file.buffer);
  return `/uploads/blogs/${filename}`;
}

function publicLayout({ title, description, canonical, image, type = 'website', body, schema = '' }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}"><meta name="robots" content="index, follow"><link rel="canonical" href="${escapeHtml(canonical)}"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:type" content="${escapeHtml(type)}"><meta property="og:url" content="${escapeHtml(canonical)}"><meta property="og:image" content="${escapeHtml(image || 'https://www.acmeinfotechsecuritysystem.com/images/blog_cctv.png')}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeHtml(title)}"><meta name="twitter:description" content="${escapeHtml(description)}"><meta name="twitter:image" content="${escapeHtml(image || 'https://www.acmeinfotechsecuritysystem.com/images/blog_cctv.png')}"><meta name="theme-color" content="#2563EB"><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet"><link rel="stylesheet" href="/css/style.css"><script src="https://unpkg.com/lucide@latest"></script>${schema}</head><body class="page-shell"><nav id="nav"><a href="/" class="nav-logo"><div class="logo-mark"><svg viewBox="0 0 24 24"><path d="M15 10l4.553-2.069A1 1 0 0121 8.87v6.26a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" /></svg></div>Acme Infotech</a><ul class="nav-links"><li><a href="/#services">Services</a></li><li><a href="/#products">Products</a></li><li><a href="/blog">Blog</a></li><li><a href="/#contact" class="nav-pill">Get Quote</a></li></ul><div class="ham" onclick="toggleMob()"><span></span><span></span><span></span></div><div class="mob-nav" id="mobNav"><a href="/#services">Services</a><a href="/#products">Products</a><a href="/blog">Blog</a><a href="/#contact">Contact / Quote</a></div></nav>${body}<footer><div class="foot-wrap"><div class="foot-bottom"><span>&copy; 2025 Acme Infotech Security System. All Rights Reserved.</span><span>GST: 24AMZPV7358R1ZG | Prop: Dhaval Variya</span></div></div></footer><script>function toggleMob(){document.getElementById('mobNav').classList.toggle('open')}window.addEventListener('scroll',function(){document.getElementById('nav').classList.toggle('solid',window.scrollY>40)});lucide.createIcons();</script></body></html>`;
}

// One shared definition of "visible on the public site". It takes ONE parameter: the current time.
const PUBLIC_BLOG_WHERE = "(blogs.status = 'published' OR (blogs.status = 'scheduled' AND blogs.published_at IS NOT NULL AND blogs.published_at <= ?::timestamp))";

async function renderBlogList() {
  const blogs = await db.prepare(`SELECT blogs.*, categories.name AS category_name FROM blogs LEFT JOIN categories ON categories.id = blogs.category_id WHERE ${PUBLIC_BLOG_WHERE} ORDER BY published_at DESC, id DESC`).all(nowIso());
  const cards = blogs.map(b => `<a class="blog-card-link" href="/blog/${escapeHtml(b.slug)}"><article class="blog-card"><div class="blog-img blog-img-fit"><img class="blog-thumb-img" src="${escapeHtml(b.featured_image || '/images/blog_cctv.png')}" alt="${escapeHtml(b.featured_image_alt || b.title)}" loading="lazy"><span class="blog-cat-badge">${escapeHtml(b.category_name || 'Security')}</span></div><div class="blog-body"><div class="blog-meta"><span>${formatDate(b.published_at)}</span><span>${readTime(b.content)} min read</span></div><h2 class="blog-title">${escapeHtml(b.title)}</h2><p class="blog-exc">${escapeHtml(b.excerpt)}</p><span class="blog-link">Read More</span></div></article></a>`).join('');
  const schema = `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Blog', name: 'Security Blog Surat', url: 'https://www.acmeinfotechsecuritysystem.com/blog', blogPost: blogs.map(b => ({ '@type': 'BlogPosting', headline: b.title, url: `https://www.acmeinfotechsecuritysystem.com/blog/${b.slug}` })) })}</script>`;
  return publicLayout({
    title: 'Security Blog Surat | CCTV and Attendance Machine Guides',
    description: 'Security Blog Surat by Acme Infotech: expert CCTV camera, biometric attendance machine, access control, and home security guides.',
    canonical: 'https://www.acmeinfotechsecuritysystem.com/blog',
    image: 'https://www.acmeinfotechsecuritysystem.com/images/blog_cctv.png',
    schema,
    body: `<main><section class="page-hero blog-list-hero"><div class="page-hero-inner"><div class="breadcrumb"><a href="/">Home</a><span>/</span><span>Blog</span></div><div class="page-kicker">Security Blog Surat</div><h1 class="page-title">CCTV and Attendance Machine Guides for Surat</h1><p class="page-lede">Practical security advice from Acme Infotech for shops, textile units, diamond offices, schools, societies and homes across Surat.</p></div></section><section class="blog-page-wrap"><div class="blog-grid">${cards || '<p>No published blogs yet.</p>'}</div></section></main>`
  });
}

async function renderBlogDetail(slug) {
  const b = await db.prepare(`SELECT blogs.*, categories.name AS category_name FROM blogs LEFT JOIN categories ON categories.id = blogs.category_id WHERE blogs.slug = ? AND ${PUBLIC_BLOG_WHERE}`).get(slug, nowIso());
  if (!b) return null;
  const title = b.seo_title || b.title;
  const desc = b.meta_description || b.excerpt;
  const canonical = b.canonical_url || `https://www.acmeinfotechsecuritysystem.com/blog/${b.slug}`;
  const image = absoluteUrl(b.og_image || b.featured_image || '/images/blog_cctv.png');
  const schema = `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'BlogPosting', headline: b.title, description: desc, image, datePublished: b.published_at || b.created_at, dateModified: b.updated_at, author: { '@type': 'Organization', name: b.author }, publisher: { '@type': 'Organization', name: 'Acme Infotech Security System' }, mainEntityOfPage: canonical, keywords: b.focus_keyword })}</script><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home', item: 'https://www.acmeinfotechsecuritysystem.com/' }, { '@type': 'ListItem', position: 2, name: 'Blog', item: 'https://www.acmeinfotechsecuritysystem.com/blog' }, { '@type': 'ListItem', position: 3, name: b.title, item: canonical }] })}</script>`;
  const related = await db.prepare(`SELECT title, slug FROM blogs WHERE ${PUBLIC_BLOG_WHERE} AND blogs.id != ? ORDER BY published_at DESC LIMIT 4`).all(nowIso(), b.id);
  return publicLayout({
    title,
    description: desc,
    canonical,
    image,
    type: 'article',
    schema,
    body: `<main><section class="page-hero blog-detail-hero"><div class="page-hero-inner"><div class="breadcrumb"><a href="/">Home</a><span>/</span><a href="/blog">Blog</a><span>/</span><span>${escapeHtml(b.category_name || 'Security')}</span></div><div class="page-kicker">${escapeHtml(b.category_name || 'Security')}</div><h1 class="page-title">${escapeHtml(b.title)}</h1><p class="page-lede">${escapeHtml(b.excerpt)}</p></div></section><section class="article-wrap"><article class="article-main"><div class="article-meta"><span>${formatDate(b.published_at)}</span><span>${readTime(b.content)} min read</span><span>${escapeHtml(b.author)}</span>${b.focus_keyword ? `<span>Focus: ${escapeHtml(b.focus_keyword)}</span>` : ''}</div><div class="article-cover"><img src="${escapeHtml(b.featured_image || '/images/blog_cctv.png')}" alt="${escapeHtml(b.featured_image_alt || b.title)}"></div><div class="article-content">${sanitizeHtml(b.content)}<div class="article-cta"><div><h3>Need help with security planning?</h3><p>Talk to ACME Infotech for CCTV, biometric attendance, access control and AMC support in Surat.</p></div><a href="/#contact">Get Free Quote</a></div></div></article><aside class="article-sidebar"><div class="side-box"><h3>Article details</h3><p><strong>Category:</strong> ${escapeHtml(b.category_name || 'Security')}</p><p><strong>Published:</strong> ${formatDate(b.published_at)}</p>${b.focus_keyword ? `<p><strong>Focus keyword:</strong> ${escapeHtml(b.focus_keyword)}</p>` : ''}</div><div class="side-box"><h3>Related guides</h3><ul>${related.map(r => `<li><a href="/blog/${escapeHtml(r.slug)}">${escapeHtml(r.title)}</a></li>`).join('')}</ul></div></aside></section></main>`
  });
}

function absoluteUrl(url) {
  if (!url) return '';
  if (url.startsWith('data:')) return url;
  return /^https?:\/\//i.test(url) ? url : `https://www.acmeinfotechsecuritysystem.com${url}`;
}

function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

function readTime(html) {
  const words = String(html || '').replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 180));
}

async function latestBlogsJson(limit = 8) {
  const blogs = await db.prepare(`SELECT blogs.*, categories.name AS category_name FROM blogs LEFT JOIN categories ON categories.id = blogs.category_id WHERE ${PUBLIC_BLOG_WHERE} ORDER BY published_at DESC, id DESC LIMIT ?`).all(nowIso(), limit);
  return blogs.map(b => ({
    title: b.title,
    slug: b.slug,
    excerpt: b.excerpt,
    image: b.featured_image || '/images/blog_cctv.png',
    imageAlt: b.featured_image_alt || b.title,
    category: b.category_name || 'Security',
    date: formatDate(b.published_at),
    readMinutes: readTime(b.content),
    url: `/blog/${b.slug}`
  }));
}



async function renderSitemap() {
  const blogs = await db.prepare(`SELECT slug, published_at, updated_at FROM blogs WHERE ${PUBLIC_BLOG_WHERE} ORDER BY published_at DESC, id DESC`).all(nowIso());
  const url = (loc, changefreq, priority, lastmod) => `  <url>\n    <loc>${escapeHtml(loc)}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ''}\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
  const latest = blogs.length ? asIso(blogs[0].updated_at || blogs[0].published_at).slice(0, 10) : '';
  const entries = [
    url(`${SITE_URL}/`, 'weekly', '1.0', ''),
    url(`${SITE_URL}/blog`, 'weekly', '0.8', latest),
    ...blogs.map(b => url(`${SITE_URL}/blog/${b.slug}`, 'monthly', '0.7', asIso(b.updated_at || b.published_at).slice(0, 10)))
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`;
}

async function renderDashboard(user) {
  const stats = (await db.prepare(`SELECT COUNT(*) total, SUM((status='published')::int) published, SUM((status='draft')::int) draft, SUM((status='scheduled')::int) scheduled FROM blogs`).get()) || {};
  const cats = Number((await db.prepare('SELECT COUNT(*) total FROM categories').get())?.total || 0);
  const recent = await db.prepare(`SELECT blogs.*, categories.name AS category_name FROM blogs LEFT JOIN categories ON categories.id = blogs.category_id ORDER BY updated_at DESC LIMIT 6`).all();
  return adminLayout('Dashboard', user, `<section class="page-head"><div><h1>Dashboard</h1><p>Manage ACME Infotech CCTV blogs, SEO and categories.</p></div><a class="btn primary" href="/admin/blogs/new">Add New Blog</a></section><section class="stats"><div><strong>${stats.total || 0}</strong><span>Total Blogs</span></div><div><strong>${stats.published || 0}</strong><span>Published Blogs</span></div><div><strong>${stats.scheduled || 0}</strong><span>Scheduled Blogs</span></div><div><strong>${stats.draft || 0}</strong><span>Draft Blogs</span></div><div><strong>${cats || 0}</strong><span>Categories</span></div></section><section class="panel"><div class="panel-head"><h2>Recent Blogs</h2><a href="/admin/blogs">View all</a></div><table class="admin-table"><thead><tr><th>Title</th><th>Category</th><th>Status</th><th>Updated</th><th></th></tr></thead><tbody>${recent.map(b => `<tr><td>${escapeHtml(b.title)}</td><td>${escapeHtml(b.category_name || '-')}</td><td><span class="status ${b.status}">${b.status}</span></td><td>${formatDate(b.updated_at)}</td><td><a href="/admin/blogs/${b.id}/edit">Edit</a></td></tr>`).join('')}</tbody></table></section>`);
}

async function renderBlogs(user, reqUrl) {
  const url = new URL(reqUrl, 'http://local');
  const search = url.searchParams.get('q') || '';
  const category = url.searchParams.get('category') || '';
  const sort = url.searchParams.get('sort') === 'oldest' ? 'oldest' : 'latest';
  let sql = `SELECT blogs.*, categories.name AS category_name FROM blogs LEFT JOIN categories ON categories.id = blogs.category_id WHERE 1=1`;
  const params = [];
  if (search) { sql += ' AND (blogs.title ILIKE ? OR blogs.excerpt ILIKE ? OR blogs.focus_keyword ILIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (Number(category)) { sql += ' AND blogs.category_id = ?'; params.push(Number(category)); }
  sql += sort === 'oldest' ? ' ORDER BY blogs.created_at ASC' : ' ORDER BY blogs.created_at DESC';
  const blogs = await db.prepare(sql).all(...params);
  const cats = await db.prepare('SELECT * FROM categories ORDER BY name').all();
  return adminLayout('Blogs', user, `<section class="page-head"><div><h1>Blogs</h1><p>Search, filter, publish, schedule, unpublish, edit and delete blog posts.</p></div><a class="btn primary" href="/admin/blogs/new">Add New Blog</a></section>${flashHtml(url.searchParams.get('msg'))}<form class="filters" method="get"><input name="q" placeholder="Search blogs" value="${escapeHtml(search)}"><select name="category"><option value="">All Categories</option>${cats.map(c => `<option value="${c.id}" ${String(c.id) === category ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select><select name="sort"><option value="latest" ${sort === 'latest' ? 'selected' : ''}>Latest</option><option value="oldest" ${sort === 'oldest' ? 'selected' : ''}>Oldest</option></select><button class="btn ghost" type="submit">Apply</button></form><section class="panel"><table class="admin-table"><thead><tr><th>Blog</th><th>Category</th><th>Status</th><th>Publish / Schedule Date</th><th>Actions</th></tr></thead><tbody>${blogs.map(b => `<tr><td><strong>${escapeHtml(b.title)}</strong><small>${escapeHtml(b.slug)}</small></td><td>${escapeHtml(b.category_name || '-')}</td><td><span class="status ${b.status}">${b.status}</span></td><td>${formatDate(b.published_at)}</td><td class="actions"><a href="/blog/${escapeHtml(b.slug)}" target="_blank">View</a><a href="/admin/blogs/${b.id}/edit">Edit</a><form method="post" action="/admin/blogs/${b.id}/toggle"><input type="hidden" name="csrf" value="${escapeHtml(user.csrf_token)}"><button type="submit">${b.status === 'published' ? 'Unpublish' : 'Publish Now'}</button></form><form method="post" action="/admin/blogs/${b.id}/delete" onsubmit="return confirm('Delete this blog permanently?')"><input type="hidden" name="csrf" value="${escapeHtml(user.csrf_token)}"><button class="danger" type="submit">Delete</button></form></td></tr>`).join('')}</tbody></table></section>`);
}

async function renderCategories(user, msg = '') {
  const cats = await db.prepare('SELECT categories.*, COUNT(blogs.id) AS blog_count FROM categories LEFT JOIN blogs ON blogs.category_id = categories.id GROUP BY categories.id ORDER BY categories.name').all();
  return adminLayout('Categories', user, `<section class="page-head"><div><h1>Categories</h1><p>Create categories used by public blog filters and SEO.</p></div></section>${flashHtml(msg)}<section class="category-grid"><form class="panel form-stack" method="post" action="/admin/categories"><input type="hidden" name="csrf" value="${escapeHtml(user.csrf_token)}"><label>Name<input name="name" required></label><label>Slug<input name="slug" placeholder="Auto generated if blank"></label><label>Description<textarea name="description" rows="4"></textarea></label><button class="btn primary" type="submit">Add Category</button></form><div class="panel"><table class="admin-table"><thead><tr><th>Name</th><th>Slug</th><th>Blogs</th></tr></thead><tbody>${cats.map(c => `<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.slug)}</td><td>${c.blog_count}</td></tr>`).join('')}</tbody></table></div></section>`);
}

function asIso(value) {
  return value ? new Date(value).toISOString() : null;
}

async function handleLogin(req, res) {
  const ip = clientIp(req);
  if (loginBlocked(ip)) {
    return sendAdmin(res, 429, loginPage('Too many failed attempts. Please wait 15 minutes and try again.'));
  }
  const { fields: form } = await readForm(req);
  const email = String(form.email || '').trim().toLowerCase();
  const admin = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!admin || !verifyPassword(String(form.password || ''), admin.password)) {
    recordLoginFailure(ip);
    return sendAdmin(res, 401, loginPage('Invalid email or password.'));
  }
  loginFailures.delete(ip);
  return redirectWithCookie(res, '/admin', createSessionCookie(admin));
}

async function saveBlog(res, user, pathname, form, files) {
  const id = pathname === '/admin/blogs/new' ? 0 : Number(pathname.match(/\d+/)[0]);
  const existing = id ? await db.prepare('SELECT * FROM blogs WHERE id = ?').get(id) : {};
  if (id && !existing) {
    return sendAdmin(res, 404, adminLayout('Not found', user, '<div class="alert">Blog not found.</div><p><a href="/admin/blogs">Back to blogs</a></p>'));
  }

  const title = String(form.title || '').trim();
  const excerpt = String(form.excerpt || '').trim();
  const content = sanitizeHtml(form.content);
  const categoryId = Number(form.category_id);
  const status = ['draft', 'published', 'scheduled'].includes(form.status) ? form.status : 'draft';
  const requestedDate = fromLocalInput(form.published_at); // '' (not given) | null (invalid) | ISO string
  const author = String(form.author || '').trim() || 'Acme Infotech Security System';
  const altText = String(form.featured_image_alt || '').trim();

  // If something is wrong the form is shown again with everything the admin typed, so no work is lost.
  const draft = {
    ...existing,
    id: id || undefined,
    title: form.title,
    slug: form.slug,
    excerpt: form.excerpt,
    content,
    featured_image_alt: form.featured_image_alt,
    category_id: form.category_id,
    author,
    status,
    published_at: requestedDate || existing.published_at,
    seo_title: form.seo_title,
    meta_description: form.meta_description,
    focus_keyword: form.focus_keyword,
    canonical_url: form.canonical_url,
    og_image_alt: form.og_image_alt
  };

  const errors = [];
  if (!title) errors.push('Blog title is required.');
  if (!excerpt) errors.push('Short description is required.');
  if (!plainText(content) && !/<(img|iframe)\b/i.test(content)) errors.push('Blog content cannot be empty.');
  if (requestedDate === null) errors.push('Publish / schedule date is not valid.');
  const category = Number.isInteger(categoryId) && categoryId > 0
    ? await db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId)
    : null;
  if (!category) errors.push('Please choose a category.');
  if (errors.length) return sendAdmin(res, 400, await blogForm(user, draft, errors.join(' ')));

  let featured = existing.featured_image || '';
  let og = existing.og_image || '';
  try {
    const newFeatured = await saveImage(files.featured_image);
    const newOg = await saveImage(files.og_image_file);
    const ogFollowsFeatured = !existing.og_image || existing.og_image === existing.featured_image;
    if (newFeatured) featured = newFeatured;
    og = newOg || (ogFollowsFeatured ? featured : existing.og_image);
  } catch (e) {
    console.error('Image upload failed:', e);
    return sendAdmin(res, 400, await blogForm(user, draft, `Image upload failed: ${e.message}`));
  }

  const slug = await ensureUniqueSlug(form.slug || title, id);
  const previousDate = asIso(existing.published_at);
  const publishedAt = status === 'published'
    ? (requestedDate || previousDate || nowIso())
    : status === 'scheduled'
      ? (requestedDate || previousDate || tomorrowIso())
      : (requestedDate || previousDate || null);
  const values = [
    title, slug, excerpt, content, featured, altText || title, categoryId,
    author, status, publishedAt, nowIso(),
    String(form.seo_title || '').trim() || title,
    String(form.meta_description || '').trim() || excerpt,
    String(form.focus_keyword || '').trim(),
    String(form.canonical_url || '').trim() || `${SITE_URL}/blog/${slug}`,
    og,
    String(form.og_image_alt || '').trim() || altText || title
  ];
  if (id) {
    await db.prepare(`UPDATE blogs SET title=?,slug=?,excerpt=?,content=?,featured_image=?,featured_image_alt=?,category_id=?,author=?,status=?,published_at=?,updated_at=?,seo_title=?,meta_description=?,focus_keyword=?,canonical_url=?,og_image=?,og_image_alt=? WHERE id=?`).run(...values, id);
  } else {
    await db.prepare(`INSERT INTO blogs (title,slug,excerpt,content,featured_image,featured_image_alt,category_id,author,status,published_at,updated_at,seo_title,meta_description,focus_keyword,canonical_url,og_image,og_image_alt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...values);
  }
  return redirect(res, '/admin/blogs?msg=saved', 303);
}

async function addCategory(res, form) {
  const name = String(form.name || '').trim();
  if (!name) return redirect(res, '/admin/categories?msg=category_invalid', 303);
  const slug = slugify(form.slug || name);
  const exists = await db.prepare('SELECT id FROM categories WHERE slug = ? OR LOWER(name) = LOWER(?)').get(slug, name);
  if (exists) return redirect(res, '/admin/categories?msg=category_exists', 303);
  await db.prepare('INSERT INTO categories (name,slug,description) VALUES (?,?,?)').run(name, slug, String(form.description || '').trim());
  return redirect(res, '/admin/categories?msg=category_added', 303);
}

async function handleAdminPost(req, res, pathname) {
  if (pathname === '/admin/login') return handleLogin(req, res);
  if (!pathname.startsWith('/admin/')) return send(res, 404, 'Not found');

  const json = 'application/json; charset=utf-8';
  const isUpload = pathname === '/admin/upload';
  const user = await currentUser(req);
  if (!user) {
    return isUpload
      ? sendAdmin(res, 401, JSON.stringify({ error: 'Your session has expired. Please log in again.' }), json)
      : redirect(res, '/admin/login', 303);
  }

  const { fields: form, files } = await readForm(req);
  if (!csrfOk(user, form)) {
    if (isUpload) return sendAdmin(res, 403, JSON.stringify({ error: 'Security token expired. Reload the page and try again.' }), json);
    return sendAdmin(res, 403, adminLayout('Session expired', user, '<div class="alert">Your form session expired or the security token was missing. Please reload the page and try again.</div><p><a href="/admin/blogs">Back to blogs</a></p>'));
  }

  if (pathname === '/admin/logout') {
    res.writeHead(302, { Location: '/admin/login', 'Set-Cookie': `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${IS_PROD ? '; Secure' : ''}` });
    return res.end();
  }
  if (pathname === '/admin/blogs/new' || /^\/admin\/blogs\/\d+\/edit$/.test(pathname)) {
    return saveBlog(res, user, pathname, form, files);
  }
  if (/^\/admin\/blogs\/\d+\/toggle$/.test(pathname)) {
    const id = Number(pathname.match(/\d+/)[0]);
    const blog = await db.prepare('SELECT id, status, published_at FROM blogs WHERE id = ?').get(id);
    if (!blog) return redirect(res, '/admin/blogs', 303);
    const publishing = blog.status !== 'published';
    await db.prepare('UPDATE blogs SET status = ?, published_at = ?, updated_at = ? WHERE id = ?')
      .run(publishing ? 'published' : 'draft', publishing ? nowIso() : asIso(blog.published_at), nowIso(), id);
    return redirect(res, `/admin/blogs?msg=${publishing ? 'published' : 'unpublished'}`, 303);
  }
  if (/^\/admin\/blogs\/\d+\/delete$/.test(pathname)) {
    await db.prepare('DELETE FROM blogs WHERE id = ?').run(Number(pathname.match(/\d+/)[0]));
    return redirect(res, '/admin/blogs?msg=deleted', 303);
  }
  if (pathname === '/admin/categories') return addCategory(res, form);
  if (isUpload) {
    try {
      const url = await saveImage(files.image);
      if (!url) return sendAdmin(res, 400, JSON.stringify({ error: 'No image received.' }), json);
      return sendAdmin(res, 200, JSON.stringify({ url }), json);
    } catch (e) {
      console.error('Editor image upload failed:', e);
      return sendAdmin(res, 400, JSON.stringify({ error: e.message }), json);
    }
  }
  return send(res, 404, 'Not found');
}

function redirectWithCookie(res, location, sid) {
  const secure = IS_PROD ? '; Secure' : '';
  res.writeHead(303, {
    Location: location,
    'Cache-Control': 'no-store',
    'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`
  });
  res.end();
}

const PUBLIC_FILES = new Set(['/index.html', '/404.html', '/robots.txt', '/manifest.webmanifest', '/favicon.ico']);

// Only the website's public files may be served. Source code, .env files, .git, package.json etc. are never public.
function isPublicPath(pathname) {
  if (pathname.split('/').some(segment => segment.startsWith('.'))) return false;
  return PUBLIC_FILES.has(pathname)
    || /^\/(css|js|images|assets)\//.test(pathname)
    || pathname === '/admin/admin.css'
    || pathname === '/admin/admin.js';
}

function sendNotFound(res) {
  fs.readFile(path.join(ROOT, '404.html'), (err, html) => send(res, 404, err ? 'Not found' : html));
}

function serveStatic(res, pathname) {
  if (pathname.startsWith('/uploads/blogs/')) {
    const uploadFile = path.join(UPLOAD_DIR, path.basename(pathname));
    return fs.readFile(uploadFile, (err, data) => {
      if (err) return sendNotFound(res);
      send(res, 200, data, TYPES[path.extname(uploadFile).toLowerCase()] || 'application/octet-stream');
    });
  }
  const publicPath = pathname === '/' ? '/index.html' : pathname;
  const file = path.resolve(ROOT, `.${publicPath}`);
  if (!isPublicPath(publicPath) || !file.startsWith(ROOT + path.sep)) return sendNotFound(res);
  fs.readFile(file, (err, data) => {
    if (err) return sendNotFound(res);
    send(res, 200, data, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
}

// Static files never touch the database, so the public site keeps working even if the database is down.
function needsDatabase(method, pathname) {
  return method === 'POST'
    || pathname === '/blog.html'
    || pathname === '/blog' || pathname.startsWith('/blog/')
    || pathname === '/sitemap.xml'
    || pathname.startsWith('/api/')
    || (pathname.startsWith('/admin') && pathname !== '/admin/admin.css' && pathname !== '/admin/admin.js');
}

async function handleRequest(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/\/+$/, '') || '/';
  } catch {
    return send(res, 400, 'Bad request');
  }
  if (!needsDatabase(req.method, pathname)) return serveStatic(res, pathname);

  await ensureDbReady();

  if (req.method === 'POST') return handleAdminPost(req, res, pathname);

  if (pathname === '/api/blogs/latest') {
    return send(res, 200, JSON.stringify({ blogs: await latestBlogsJson(8) }), 'application/json; charset=utf-8', {
      'Cache-Control': 'public, max-age=0, must-revalidate'
    });
  }
  if (pathname === '/sitemap.xml') {
    return send(res, 200, await renderSitemap(), 'application/xml; charset=utf-8', { 'Cache-Control': 'public, max-age=0, must-revalidate' });
  }

  if (pathname === '/admin/login') {
    if (await currentUser(req)) return redirect(res, '/admin');
    const adminCount = Number((await db.prepare('SELECT COUNT(*) AS total FROM users').get()).total);
    const hint = adminCount === 0
      ? 'No admin account exists yet. Set ADMIN_EMAIL and ADMIN_PASSWORD in the server environment variables, then redeploy/restart.'
      : '';
    return sendAdmin(res, 200, loginPage('', hint));
  }
  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    const user = await requireAdmin(req, res);
    if (!user) return;
    if (pathname === '/admin') return sendAdmin(res, 200, await renderDashboard(user));
    if (pathname === '/admin/blogs') return sendAdmin(res, 200, await renderBlogs(user, req.url));
    if (pathname === '/admin/blogs/new') return sendAdmin(res, 200, await blogForm(user));
    if (/^\/admin\/blogs\/\d+\/edit$/.test(pathname)) {
      const blog = await db.prepare('SELECT * FROM blogs WHERE id = ?').get(Number(pathname.match(/\d+/)[0]));
      return blog ? sendAdmin(res, 200, await blogForm(user, blog)) : sendAdmin(res, 404, 'Blog not found');
    }
    if (pathname === '/admin/categories') {
      const msg = new URL(req.url, 'http://localhost').searchParams.get('msg') || '';
      return sendAdmin(res, 200, await renderCategories(user, msg));
    }
    return sendAdmin(res, 404, 'Not found');
  }

  if (pathname === '/blog.html') return redirect(res, '/blog', 301);
  if (pathname.startsWith('/blog/') && pathname.endsWith('.html')) return redirect(res, pathname.slice(0, -5), 301);
  if (pathname === '/blog') return send(res, 200, await renderBlogList());
  if (pathname.startsWith('/blog/')) {
    const html = await renderBlogDetail(pathname.slice('/blog/'.length));
    return html ? send(res, 200, html) : sendNotFound(res);
  }
  return serveStatic(res, pathname);
}

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (e) {
    console.error(e);
    // Setup problems (missing env vars) are explained to the admin; everything else stays generic.
    if (e.statusCode === 413) return send(res, 413, 'The upload is too large. Please use smaller images.', 'text/plain; charset=utf-8');
    send(res, 500, e instanceof ConfigError ? `Server configuration error: ${e.message}` : 'Server error', 'text/plain; charset=utf-8');
  }
});

process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));

server.listen(PORT, () => {
  console.log(`ACME CMS running on http://localhost:${PORT}`);
});
