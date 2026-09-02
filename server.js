const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const RUNTIME_ROOT = process.env.VERCEL ? path.join('/tmp', 'acme-infotech-cms') : ROOT;
const DATA_DIR = path.join(RUNTIME_ROOT, 'data');
const UPLOAD_DIR = path.join(RUNTIME_ROOT, 'uploads', 'blogs');
const DB_PATH = path.join(DATA_DIR, 'cms.sqlite');
const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const SESSION_SECRET = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || 'change-this-session-secret';
const DB_BLOB_PATH = 'cms/cms.sqlite';
const USE_BLOB_DB = Boolean(process.env.BLOB_READ_WRITE_TOKEN || (process.env.BLOB_STORE_ID && process.env.VERCEL_OIDC_TOKEN));
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
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
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon'
};

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let db;
let dbReadyPromise;

function openDatabase() {
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS blogs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      excerpt TEXT NOT NULL,
      content TEXT NOT NULL,
      featured_image TEXT,
      featured_image_alt TEXT,
      category_id INTEGER,
      author TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft','published','scheduled')) DEFAULT 'draft',
      published_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      seo_title TEXT,
      meta_description TEXT,
      focus_keyword TEXT,
      canonical_url TEXT,
      og_image TEXT,
      og_image_alt TEXT,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      csrf_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
}

function migrateScheduledStatus() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'blogs'").get();
  if (!row || row.sql.includes("'scheduled'")) return;
  db.exec(`
    ALTER TABLE blogs RENAME TO blogs_old;
    CREATE TABLE blogs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      excerpt TEXT NOT NULL,
      content TEXT NOT NULL,
      featured_image TEXT,
      featured_image_alt TEXT,
      category_id INTEGER,
      author TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft','published','scheduled')) DEFAULT 'draft',
      published_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      seo_title TEXT,
      meta_description TEXT,
      focus_keyword TEXT,
      canonical_url TEXT,
      og_image TEXT,
      og_image_alt TEXT,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
    );
    INSERT INTO blogs
    (id,title,slug,excerpt,content,featured_image,featured_image_alt,category_id,author,status,published_at,created_at,updated_at,seo_title,meta_description,focus_keyword,canonical_url,og_image,og_image_alt)
    SELECT id,title,slug,excerpt,content,featured_image,featured_image_alt,category_id,author,status,published_at,created_at,updated_at,seo_title,meta_description,focus_keyword,canonical_url,og_image,og_image_alt
    FROM blogs_old;
    DROP TABLE blogs_old;
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
  const [scheme, digest, iter, salt, hash] = String(stored).split('$');
  if (scheme !== 'pbkdf2' || !digest || !iter || !salt || !hash) return false;
  const actual = crypto.pbkdf2Sync(password, salt, Number(iter), 64, digest).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(actual, 'hex'));
}

function seedAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS total FROM users').get().total;
  if (count) return;
  const email = process.env.ADMIN_EMAIL || 'admin@acme.local';
  const password = process.env.ADMIN_PASSWORD || 'ChangeMe@12345';
  db.prepare('INSERT INTO users (name,email,password,role) VALUES (?,?,?,?)')
    .run('ACME Admin', email.toLowerCase(), hashPassword(password), 'admin');
  console.log(`Admin created: ${email}`);
  if (!process.env.ADMIN_PASSWORD) console.log('Default password: ChangeMe@12345');
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

function ensureUniqueSlug(slug, id = 0) {
  let base = slugify(slug);
  let candidate = base;
  let i = 2;
  while (db.prepare('SELECT id FROM blogs WHERE slug = ? AND id != ?').get(candidate, id)) {
    candidate = `${base}-${i++}`;
  }
  return candidate;
}

function seedCategoriesAndBlogs() {
  const categories = [
    ['CCTV Tips', 'cctv-tips', 'CCTV planning, placement and installation advice.'],
    ['Attendance', 'attendance', 'Biometric attendance machine guides.'],
    ['Buying Guide', 'buying-guide', 'Security product buying guidance.'],
    ['How To', 'how-to', 'Setup and troubleshooting guides.'],
    ['Business Tips', 'business-tips', 'Security advice for businesses.'],
    ['Home Security', 'home-security', 'Home and society CCTV guidance.']
  ];
  const catStmt = db.prepare('INSERT OR IGNORE INTO categories (name,slug,description) VALUES (?,?,?)');
  categories.forEach(c => catStmt.run(...c));
  if (db.prepare('SELECT COUNT(*) AS total FROM blogs').get().total) return;
  const getCat = db.prepare('SELECT id FROM categories WHERE slug = ?');
  const insert = db.prepare(`
    INSERT INTO blogs
    (title, slug, excerpt, content, featured_image, featured_image_alt, category_id, author, status, published_at,
     seo_title, meta_description, focus_keyword, canonical_url, og_image, og_image_alt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
  rows.forEach(b => insert.run(
    b.title, b.slug, b.excerpt, b.content, b.image, b.title, getCat.get(b.category).id, 'Acme Infotech Security System',
    'published', b.date, b.title, b.excerpt, b.focus, `https://www.acmeinfotechsecuritysystem.com/blog/${b.slug}`,
    b.image, b.title
  ));
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function restoreDbFromBlob() {
  if (!USE_BLOB_DB) return;
  try {
    const { get } = await import('@vercel/blob');
    const stored = await get(DB_BLOB_PATH, { access: 'private', useCache: false });
    if (!stored) return;
    fs.writeFileSync(DB_PATH, await streamToBuffer(stored.stream));
  } catch (e) {
    if (!String(e?.message || '').toLowerCase().includes('not found')) {
      console.error('Could not restore CMS database from Blob:', e);
    }
  }
}

async function persistDbToBlob() {
  if (!USE_BLOB_DB) return;
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const { put } = await import('@vercel/blob');
    await put(DB_BLOB_PATH, fs.readFileSync(DB_PATH), {
      access: 'private',
      allowOverwrite: true,
      contentType: 'application/vnd.sqlite3',
      cacheControlMaxAge: 60
    });
  } catch (e) {
    console.error('Could not persist CMS database to Blob:', e);
  }
}

async function ensureDbReady() {
  if (dbReadyPromise) return dbReadyPromise;
  dbReadyPromise = (async () => {
    await restoreDbFromBlob();
    openDatabase();
    migrateScheduledStatus();
    seedAdmin();
    seedCategoriesAndBlogs();
    await persistDbToBlob();
  })();
  return dbReadyPromise;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[ch]));
}

function sanitizeHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?src=["']?javascript:[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, '')
    .replace(/\s(?:href|src)\s*=\s*(['"])\s*javascript:.*?\1/gi, '');
}

function excerptText(html, fallback) {
  return escapeHtml(String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 170) || fallback || '');
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').filter(Boolean).map(v => {
    const idx = v.indexOf('=');
    return [decodeURIComponent(v.slice(0, idx).trim()), decodeURIComponent(v.slice(idx + 1).trim())];
  }));
}

function signValue(value) {
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
  if (!encoded || !signature || signValue(encoded) !== signature) return null;
  try {
    const session = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!session.expires_at || session.expires_at < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

function send(res, status, body, type = 'text/html; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseUrlEncoded(buffer) {
  return Object.fromEntries(new URLSearchParams(buffer.toString('utf8')));
}

function parseMultipart(buffer, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.[1] || /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.[2];
  if (!boundary) return { fields: {}, files: {} };
  const raw = buffer.toString('binary');
  const fields = {};
  const files = {};
  raw.split(`--${boundary}`).forEach(part => {
    if (!part || part === '--\r\n' || part === '--') return;
    const idx = part.indexOf('\r\n\r\n');
    if (idx === -1) return;
    const header = part.slice(0, idx);
    let body = part.slice(idx + 4);
    if (body.endsWith('\r\n')) body = body.slice(0, -2);
    const name = /name="([^"]+)"/i.exec(header)?.[1];
    if (!name) return;
    const filename = /filename="([^"]*)"/i.exec(header)?.[1];
    if (filename) {
      const mime = /Content-Type:\s*([^\r\n]+)/i.exec(header)?.[1]?.trim() || 'application/octet-stream';
      files[name] = { filename, mime, buffer: Buffer.from(body, 'binary') };
    } else {
      fields[name] = Buffer.from(body, 'binary').toString('utf8');
    }
  });
  return { fields, files };
}

function currentUser(req) {
  const session = verifySessionCookie(parseCookies(req).sid);
  if (!session) return null;
  const admin = db.prepare('SELECT id, name, email, role FROM users WHERE email = ?').get(String(session.email || '').toLowerCase());
  if (!admin || admin.role !== 'admin') return null;
  return { ...admin, csrf_token: session.csrf_token, expires_at: session.expires_at };
}

function requireAdmin(req, res) {
  const user = currentUser(req);
  if (!user || user.role !== 'admin') {
    redirect(res, '/admin/login');
    return null;
  }
  return user;
}

function checkCsrf(req, form) {
  const user = currentUser(req);
  return user && form.csrf === user.csrf_token;
}

function adminLayout(title, user, content) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${escapeHtml(title)} | ACME Admin</title><link rel="stylesheet" href="/admin/admin.css"><script src="/admin/admin.js" defer></script></head><body><div class="admin-shell"><aside class="admin-side"><a class="admin-brand" href="/admin"><span>AI</span><strong>ACME CMS</strong></a><nav><a href="/admin">Dashboard</a><a href="/admin/blogs">Blogs</a><a href="/admin/blogs/new">Add New Blog</a><a href="/admin/categories">Categories</a><a href="/blog" target="_blank">Public Blog</a></nav></aside><div class="admin-main"><header class="admin-top"><div><p>Logged in as</p><strong>${escapeHtml(user.name)} · ${escapeHtml(user.email)}</strong></div><form method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${escapeHtml(user.csrf_token)}"><button class="btn ghost" type="submit">Logout</button></form></header>${content}</div></div></body></html>`;
}

function loginPage(error = '') {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Admin Login | ACME Infotech CCTV</title><link rel="stylesheet" href="/admin/admin.css"></head><body class="login-body"><main class="login-card"><div class="login-mark">AI</div><h1>Admin Login</h1><p>Secure blog management for ACME Infotech CCTV.</p>${error ? `<div class="alert">${escapeHtml(error)}</div>` : ''}<form method="post" action="/admin/login"><label>Email / Username<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button class="btn primary full" type="submit">Login</button></form></main></body></html>`;
}

function categoryOptions(selected) {
  return db.prepare('SELECT * FROM categories ORDER BY name').all().map(c => `<option value="${c.id}" ${String(c.id) === String(selected || '') ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
}

function blogForm(user, blog = {}) {
  const isEdit = Boolean(blog.id);
  const action = isEdit ? `/admin/blogs/${blog.id}/edit` : '/admin/blogs/new';
  const title = isEdit ? 'Edit Blog' : 'Add New Blog';
  return adminLayout(title, user, `<section class="page-head"><div><h1>${title}</h1><p>Create SEO-ready public blog posts with images, categories and rich content.</p></div><a class="btn ghost" href="/admin/blogs">Back</a></section><form class="editor-form" method="post" action="${action}" enctype="multipart/form-data"><input type="hidden" name="csrf" value="${escapeHtml(user.csrf_token)}"><div class="form-grid"><label>Blog Title<input name="title" id="titleInput" required value="${escapeHtml(blog.title || '')}"></label><label>URL Slug<input name="slug" id="slugInput" required value="${escapeHtml(blog.slug || '')}"></label><label class="wide">Short Description / Excerpt<textarea name="excerpt" rows="3" required>${escapeHtml(blog.excerpt || '')}</textarea></label><label>Featured Image<input name="featured_image" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label><label>Featured Image Alt Text<input name="featured_image_alt" value="${escapeHtml(blog.featured_image_alt || '')}"></label><label>Blog Category<select name="category_id" required>${categoryOptions(blog.category_id)}</select></label><label>Author<input name="author" required value="${escapeHtml(blog.author || 'Acme Infotech Security System')}"></label><label>Publish / Schedule Date<input name="published_at" type="datetime-local" value="${escapeHtml(toLocalInput(blog.published_at))}"><small>Scheduled blog aa date/time sudhi public website par nahi dekhay.</small></label><label>Status<select name="status"><option value="draft" ${blog.status !== 'published' && blog.status !== 'scheduled' ? 'selected' : ''}>Draft</option><option value="scheduled" ${blog.status === 'scheduled' ? 'selected' : ''}>Scheduled</option><option value="published" ${blog.status === 'published' ? 'selected' : ''}>Published</option></select></label><label>SEO Title<input name="seo_title" value="${escapeHtml(blog.seo_title || '')}"></label><label class="wide">Meta Description<textarea name="meta_description" rows="3">${escapeHtml(blog.meta_description || '')}</textarea></label><label>Focus Keyword<input name="focus_keyword" value="${escapeHtml(blog.focus_keyword || '')}"></label><label>Canonical URL<input name="canonical_url" value="${escapeHtml(blog.canonical_url || '')}"></label><label>Open Graph Image<input name="og_image_file" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label><label>OG Image Alt Text<input name="og_image_alt" value="${escapeHtml(blog.og_image_alt || '')}"></label></div><section class="editor-box"><div class="toolbar"><button type="button" data-cmd="formatBlock" data-value="h1">H1</button><button type="button" data-cmd="formatBlock" data-value="h2">H2</button><button type="button" data-cmd="formatBlock" data-value="h3">H3</button><button type="button" data-cmd="bold">B</button><button type="button" data-cmd="italic">I</button><button type="button" data-cmd="insertUnorderedList">List</button><button type="button" data-cmd="insertOrderedList">1. List</button><button type="button" data-action="link">Link</button><button type="button" data-action="quote">Quote</button><button type="button" data-action="table">Table</button><button type="button" data-action="youtube">YouTube</button><button type="button" data-action="image">Image</button><button type="button" data-action="code">HTML</button></div><input id="editorImageInput" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden><div id="editor" class="rich-editor" contenteditable="true">${sanitizeHtml(blog.content || '<p>Write your blog content here...</p>')}</div><textarea name="content" id="contentInput" hidden></textarea></section><div class="form-actions"><button class="btn primary" type="submit">${isEdit ? 'Update Blog' : 'Save Blog'}</button><a class="btn ghost" href="/admin/blogs">Cancel</a></div></form>`);
}

function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function saveImage(file) {
  if (!file || !file.filename || file.buffer.length === 0) return '';
  if (!MIME_EXT[file.mime]) throw new Error('Only JPG, PNG, WEBP and GIF images are allowed.');
  if (file.buffer.length > MAX_IMAGE_BYTES) throw new Error('Image must be smaller than 3MB.');
  if (process.env.VERCEL) {
    return `data:${file.mime};base64,${file.buffer.toString('base64')}`;
  }
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${MIME_EXT[file.mime]}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), file.buffer);
  return `/uploads/blogs/${filename}`;
}

function publicLayout({ title, description, canonical, image, type = 'website', body, schema = '' }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}"><meta name="robots" content="index, follow"><link rel="canonical" href="${escapeHtml(canonical)}"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:type" content="${escapeHtml(type)}"><meta property="og:url" content="${escapeHtml(canonical)}"><meta property="og:image" content="${escapeHtml(image || 'https://www.acmeinfotechsecuritysystem.com/images/blog_cctv.png')}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeHtml(title)}"><meta name="twitter:description" content="${escapeHtml(description)}"><meta name="twitter:image" content="${escapeHtml(image || 'https://www.acmeinfotechsecuritysystem.com/images/blog_cctv.png')}"><meta name="theme-color" content="#2563EB"><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet"><link rel="stylesheet" href="/css/style.css"><script src="https://unpkg.com/lucide@latest"></script>${schema}</head><body class="page-shell"><nav id="nav"><a href="/" class="nav-logo"><div class="logo-mark"><svg viewBox="0 0 24 24"><path d="M15 10l4.553-2.069A1 1 0 0121 8.87v6.26a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" /></svg></div>Acme Infotech</a><ul class="nav-links"><li><a href="/#services">Services</a></li><li><a href="/#products">Products</a></li><li><a href="/blog">Blog</a></li><li><a href="/#contact" class="nav-pill">Get Quote</a></li></ul><div class="ham" onclick="toggleMob()"><span></span><span></span><span></span></div><div class="mob-nav" id="mobNav"><a href="/#services">Services</a><a href="/#products">Products</a><a href="/blog">Blog</a><a href="/#contact">Contact / Quote</a></div></nav>${body}<footer><div class="foot-wrap"><div class="foot-bottom"><span>&copy; 2025 Acme Infotech Security System. All Rights Reserved.</span><span>GST: 24AMZPV7358R1ZG | Prop: Dhaval Variya</span></div></div></footer><script>function toggleMob(){document.getElementById('mobNav').classList.toggle('open')}window.addEventListener('scroll',function(){document.getElementById('nav').classList.toggle('solid',window.scrollY>40)});lucide.createIcons();</script></body></html>`;
}

function renderBlogList() {
  const blogs = db.prepare(`SELECT blogs.*, categories.name AS category_name FROM blogs LEFT JOIN categories ON categories.id = blogs.category_id WHERE status = 'published' OR (status = 'scheduled' AND published_at IS NOT NULL AND datetime(published_at) <= datetime(?)) ORDER BY datetime(published_at) DESC, id DESC`).all(nowIso());
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

function renderBlogDetail(slug) {
  const b = db.prepare(`SELECT blogs.*, categories.name AS category_name FROM blogs LEFT JOIN categories ON categories.id = blogs.category_id WHERE blogs.slug = ? AND (blogs.status = 'published' OR (blogs.status = 'scheduled' AND blogs.published_at IS NOT NULL AND datetime(blogs.published_at) <= datetime(?)))`).get(slug, nowIso());
  if (!b) return null;
  const title = b.seo_title || b.title;
  const desc = b.meta_description || b.excerpt;
  const canonical = b.canonical_url || `https://www.acmeinfotechsecuritysystem.com/blog/${b.slug}`;
  const image = absoluteUrl(b.og_image || b.featured_image || '/images/blog_cctv.png');
  const schema = `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'BlogPosting', headline: b.title, description: desc, image, datePublished: b.published_at || b.created_at, dateModified: b.updated_at, author: { '@type': 'Organization', name: b.author }, publisher: { '@type': 'Organization', name: 'Acme Infotech Security System' }, mainEntityOfPage: canonical, keywords: b.focus_keyword })}</script><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home', item: 'https://www.acmeinfotechsecuritysystem.com/' }, { '@type': 'ListItem', position: 2, name: 'Blog', item: 'https://www.acmeinfotechsecuritysystem.com/blog' }, { '@type': 'ListItem', position: 3, name: b.title, item: canonical }] })}</script>`;
  const related = db.prepare(`SELECT title, slug FROM blogs WHERE (status = 'published' OR (status = 'scheduled' AND published_at IS NOT NULL AND datetime(published_at) <= datetime(?))) AND id != ? ORDER BY datetime(published_at) DESC LIMIT 4`).all(nowIso(), b.id);
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
  return /^https?:\/\//i.test(url) ? url : `https://www.acmeinfotechsecuritysystem.com${url}`;
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function readTime(html) {
  const words = String(html || '').replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 180));
}

function latestBlogsJson(limit = 8) {
  const blogs = db.prepare(`SELECT blogs.*, categories.name AS category_name FROM blogs LEFT JOIN categories ON categories.id = blogs.category_id WHERE status = 'published' OR (status = 'scheduled' AND published_at IS NOT NULL AND datetime(published_at) <= datetime(?)) ORDER BY datetime(published_at) DESC, id DESC LIMIT ?`).all(nowIso(), limit);
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

function renderDashboard(user) {
  const stats = db.prepare(`SELECT COUNT(*) total, SUM(status='published') published, SUM(status='draft') draft, SUM(status='scheduled') scheduled FROM blogs`).get();
  const cats = db.prepare('SELECT COUNT(*) total FROM categories').get().total;
  const recent = db.prepare(`SELECT blogs.*, categories.name AS category_name FROM blogs LEFT JOIN categories ON categories.id = blogs.category_id ORDER BY datetime(updated_at) DESC LIMIT 6`).all();
  return adminLayout('Dashboard', user, `<section class="page-head"><div><h1>Dashboard</h1><p>Manage ACME Infotech CCTV blogs, SEO and categories.</p></div><a class="btn primary" href="/admin/blogs/new">Add New Blog</a></section><section class="stats"><div><strong>${stats.total || 0}</strong><span>Total Blogs</span></div><div><strong>${stats.published || 0}</strong><span>Published Blogs</span></div><div><strong>${stats.scheduled || 0}</strong><span>Scheduled Blogs</span></div><div><strong>${stats.draft || 0}</strong><span>Draft Blogs</span></div><div><strong>${cats || 0}</strong><span>Categories</span></div></section><section class="panel"><div class="panel-head"><h2>Recent Blogs</h2><a href="/admin/blogs">View all</a></div><table class="admin-table"><thead><tr><th>Title</th><th>Category</th><th>Status</th><th>Updated</th><th></th></tr></thead><tbody>${recent.map(b => `<tr><td>${escapeHtml(b.title)}</td><td>${escapeHtml(b.category_name || '-')}</td><td><span class="status ${b.status}">${b.status}</span></td><td>${formatDate(b.updated_at)}</td><td><a href="/admin/blogs/${b.id}/edit">Edit</a></td></tr>`).join('')}</tbody></table></section>`);
}

function renderBlogs(user, reqUrl) {
  const url = new URL(reqUrl, 'http://local');
  const search = url.searchParams.get('q') || '';
  const category = url.searchParams.get('category') || '';
  const sort = url.searchParams.get('sort') === 'oldest' ? 'oldest' : 'latest';
  let sql = `SELECT blogs.*, categories.name AS category_name FROM blogs LEFT JOIN categories ON categories.id = blogs.category_id WHERE 1=1`;
  const params = [];
  if (search) { sql += ' AND (blogs.title LIKE ? OR blogs.excerpt LIKE ? OR blogs.focus_keyword LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (category) { sql += ' AND blogs.category_id = ?'; params.push(category); }
  sql += sort === 'oldest' ? ' ORDER BY datetime(blogs.created_at) ASC' : ' ORDER BY datetime(blogs.created_at) DESC';
  const blogs = db.prepare(sql).all(...params);
  const cats = db.prepare('SELECT * FROM categories ORDER BY name').all();
  return adminLayout('Blogs', user, `<section class="page-head"><div><h1>Blogs</h1><p>Search, filter, publish, schedule, unpublish, edit and delete blog posts.</p></div><a class="btn primary" href="/admin/blogs/new">Add New Blog</a></section><form class="filters" method="get"><input name="q" placeholder="Search blogs" value="${escapeHtml(search)}"><select name="category"><option value="">All Categories</option>${cats.map(c => `<option value="${c.id}" ${String(c.id) === category ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select><select name="sort"><option value="latest" ${sort === 'latest' ? 'selected' : ''}>Latest</option><option value="oldest" ${sort === 'oldest' ? 'selected' : ''}>Oldest</option></select><button class="btn ghost" type="submit">Apply</button></form><section class="panel"><table class="admin-table"><thead><tr><th>Blog</th><th>Category</th><th>Status</th><th>Publish / Schedule Date</th><th>Actions</th></tr></thead><tbody>${blogs.map(b => `<tr><td><strong>${escapeHtml(b.title)}</strong><small>${escapeHtml(b.slug)}</small></td><td>${escapeHtml(b.category_name || '-')}</td><td><span class="status ${b.status}">${b.status}</span></td><td>${formatDate(b.published_at)}</td><td class="actions"><a href="/blog/${escapeHtml(b.slug)}" target="_blank">View</a><a href="/admin/blogs/${b.id}/edit">Edit</a><form method="post" action="/admin/blogs/${b.id}/toggle"><input type="hidden" name="csrf" value="${escapeHtml(user.csrf_token)}"><button type="submit">${b.status === 'published' ? 'Unpublish' : 'Publish Now'}</button></form><form method="post" action="/admin/blogs/${b.id}/delete" onsubmit="return confirm('Delete this blog permanently?')"><input type="hidden" name="csrf" value="${escapeHtml(user.csrf_token)}"><button class="danger" type="submit">Delete</button></form></td></tr>`).join('')}</tbody></table></section>`);
}

function renderCategories(user) {
  const cats = db.prepare('SELECT categories.*, COUNT(blogs.id) AS blog_count FROM categories LEFT JOIN blogs ON blogs.category_id = categories.id GROUP BY categories.id ORDER BY categories.name').all();
  return adminLayout('Categories', user, `<section class="page-head"><div><h1>Categories</h1><p>Create categories used by public blog filters and SEO.</p></div></section><section class="category-grid"><form class="panel form-stack" method="post" action="/admin/categories"><input type="hidden" name="csrf" value="${escapeHtml(user.csrf_token)}"><label>Name<input name="name" required></label><label>Slug<input name="slug" placeholder="Auto generated if blank"></label><label>Description<textarea name="description" rows="4"></textarea></label><button class="btn primary" type="submit">Add Category</button></form><div class="panel"><table class="admin-table"><thead><tr><th>Name</th><th>Slug</th><th>Blogs</th></tr></thead><tbody>${cats.map(c => `<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.slug)}</td><td>${c.blog_count}</td></tr>`).join('')}</tbody></table></div></section>`);
}

async function handleAdminPost(req, res, pathname) {
  const user = currentUser(req);
  if (pathname === '/admin/login') {
    const form = parseUrlEncoded(await readBody(req));
    const admin = db.prepare('SELECT * FROM users WHERE email = ?').get(String(form.email || '').toLowerCase());
    if (!admin || !verifyPassword(form.password || '', admin.password)) return send(res, 401, loginPage('Invalid email or password.'));
    return redirectWithCookie(res, '/admin', createSessionCookie(admin));
  }
  if (!user || user.role !== 'admin') return redirect(res, '/admin/login');
  const contentType = req.headers['content-type'] || '';
  const raw = await readBody(req);
  const parsed = contentType.includes('multipart/form-data') ? parseMultipart(raw, contentType) : { fields: parseUrlEncoded(raw), files: {} };
  const form = parsed.fields;
  if (!checkCsrf(req, form)) return send(res, 403, 'Invalid CSRF token.');
  if (pathname === '/admin/logout') {
    res.writeHead(302, { Location: '/admin/login', 'Set-Cookie': 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
    return res.end();
  }
  if (pathname === '/admin/blogs/new' || /^\/admin\/blogs\/\d+\/edit$/.test(pathname)) {
    const id = Number(pathname.match(/\d+/)?.[0] || 0);
    let existing = id ? db.prepare('SELECT * FROM blogs WHERE id = ?').get(id) : {};
    let featured = existing.featured_image || '';
    let og = existing.og_image || '';
    try {
      featured = saveImage(parsed.files.featured_image) || featured;
      og = saveImage(parsed.files.og_image_file) || form.og_image || og || featured;
    } catch (e) {
      return send(res, 400, adminLayout('Upload Error', user, `<div class="alert">${escapeHtml(e.message)}</div><p><a href="/admin/blogs">Back to blogs</a></p>`));
    }
    const slug = ensureUniqueSlug(form.slug || form.title, id);
    const submittedStatus = ['draft', 'published', 'scheduled'].includes(form.status) ? form.status : 'draft';
    const requestedDate = form.published_at ? new Date(form.published_at).toISOString() : '';
    const publishedAt = submittedStatus === 'published'
      ? (requestedDate || existing.published_at || nowIso())
      : submittedStatus === 'scheduled'
        ? (requestedDate || existing.published_at || tomorrowIso())
        : (requestedDate || existing.published_at || null);
    const values = [
      form.title, slug, form.excerpt, sanitizeHtml(form.content), featured, form.featured_image_alt || form.title, Number(form.category_id),
      form.author || 'Acme Infotech Security System', submittedStatus, publishedAt, nowIso(),
      form.seo_title || form.title, form.meta_description || form.excerpt, form.focus_keyword || '', form.canonical_url || `https://www.acmeinfotechsecuritysystem.com/blog/${slug}`,
      og, form.og_image_alt || form.featured_image_alt || form.title
    ];
    if (id) {
      db.prepare(`UPDATE blogs SET title=?,slug=?,excerpt=?,content=?,featured_image=?,featured_image_alt=?,category_id=?,author=?,status=?,published_at=?,updated_at=?,seo_title=?,meta_description=?,focus_keyword=?,canonical_url=?,og_image=?,og_image_alt=? WHERE id=?`).run(...values, id);
    } else {
      db.prepare(`INSERT INTO blogs (title,slug,excerpt,content,featured_image,featured_image_alt,category_id,author,status,published_at,updated_at,seo_title,meta_description,focus_keyword,canonical_url,og_image,og_image_alt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...values);
    }
    await persistDbToBlob();
    return send(res, 200, renderBlogs(user));
  }
  if (/^\/admin\/blogs\/\d+\/toggle$/.test(pathname)) {
    const id = Number(pathname.match(/\d+/)[0]);
    const b = db.prepare('SELECT * FROM blogs WHERE id = ?').get(id);
    if (b) db.prepare(`UPDATE blogs SET status = ?, published_at = ?, updated_at = ? WHERE id = ?`).run(b.status === 'published' ? 'draft' : 'published', b.status === 'published' ? b.published_at : nowIso(), nowIso(), id);
    await persistDbToBlob();
    return send(res, 200, renderBlogs(user));
  }
  if (/^\/admin\/blogs\/\d+\/delete$/.test(pathname)) {
    db.prepare('DELETE FROM blogs WHERE id = ?').run(Number(pathname.match(/\d+/)[0]));
    await persistDbToBlob();
    return send(res, 200, renderBlogs(user));
  }
  if (pathname === '/admin/categories') {
    const slug = slugify(form.slug || form.name);
    db.prepare('INSERT OR IGNORE INTO categories (name,slug,description) VALUES (?,?,?)').run(form.name, slug, form.description || '');
    await persistDbToBlob();
    return send(res, 200, renderCategories(user));
  }
  if (pathname === '/admin/upload') {
    try {
      const url = saveImage(parsed.files.image);
      return send(res, 200, JSON.stringify({ url }), 'application/json; charset=utf-8');
    } catch (e) {
      return send(res, 400, JSON.stringify({ error: e.message }), 'application/json; charset=utf-8');
    }
  }
  send(res, 404, 'Not found');
}

function redirectWithCookie(res, location, sid) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.writeHead(302, { Location: location, 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}` });
  res.end();
}

function serveStatic(req, res, pathname) {
  if (pathname.startsWith('/uploads/blogs/')) {
    const uploadName = path.basename(pathname);
    const uploadFile = path.join(UPLOAD_DIR, uploadName);
    if (!uploadFile.startsWith(UPLOAD_DIR)) return send(res, 403, 'Forbidden');
    return fs.readFile(uploadFile, (err, data) => {
      if (err) return send(res, 404, 'Not found');
      send(res, 200, data, TYPES[path.extname(uploadFile)] || 'application/octet-stream');
    });
  }

  const cleanPath = pathname === '/' ? 'index.html' : pathname.replace(/^[/\\]+/, '');
  const safe = path.normalize(cleanPath).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(ROOT, safe);
  if (!file.startsWith(ROOT)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) {
      fs.readFile(path.join(ROOT, '404.html'), (e, html) => send(res, 404, e ? 'Not found' : html));
      return;
    }
    send(res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream');
  });
}

const server = http.createServer(async (req, res) => {
  try {
    await ensureDbReady();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname).replace(/\/$/, '') || '/';
    if (req.method === 'GET' && pathname === '/api/blogs/latest') {
      return send(res, 200, JSON.stringify({ blogs: latestBlogsJson(8) }), 'application/json; charset=utf-8', {
        'Cache-Control': 'public, max-age=0, must-revalidate'
      });
    }
    if (req.method === 'POST') return handleAdminPost(req, res, pathname);
    if (pathname === '/admin/login') return send(res, 200, loginPage());
    if (pathname === '/admin') {
      const user = requireAdmin(req, res); if (!user) return;
      return send(res, 200, renderDashboard(user));
    }
    if (pathname === '/admin/blogs') {
      const user = requireAdmin(req, res); if (!user) return;
      return send(res, 200, renderBlogs(user, req.url));
    }
    if (pathname === '/admin/blogs/new') {
      const user = requireAdmin(req, res); if (!user) return;
      return send(res, 200, blogForm(user));
    }
    if (/^\/admin\/blogs\/\d+\/edit$/.test(pathname)) {
      const user = requireAdmin(req, res); if (!user) return;
      const blog = db.prepare('SELECT * FROM blogs WHERE id = ?').get(Number(pathname.match(/\d+/)[0]));
      return blog ? send(res, 200, blogForm(user, blog)) : send(res, 404, 'Blog not found');
    }
    if (pathname === '/admin/categories') {
      const user = requireAdmin(req, res); if (!user) return;
      return send(res, 200, renderCategories(user));
    }
    if (pathname === '/blog.html') return redirect(res, '/blog');
    if (pathname.startsWith('/blog/') && pathname.endsWith('.html')) {
      return redirect(res, pathname.slice(0, -5));
    }
    if (pathname === '/blog') return send(res, 200, renderBlogList());
    if (pathname.startsWith('/blog/')) {
      const html = renderBlogDetail(pathname.replace('/blog/', ''));
      return html ? send(res, 200, html) : send(res, 404, 'Blog not found');
    }
    serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error(e);
    send(res, 500, 'Server error');
  }
});

server.listen(PORT, () => {
  console.log(`ACME CMS running on http://localhost:${PORT}`);
});
