#!/usr/bin/env node
/*
 * End-to-end check of the blog CMS. Works against a local server or the live website.
 *
 *   BASE_URL=http://localhost:3000 ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=secret npm run smoke
 *   BASE_URL=https://www.your-site.com ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run smoke
 *
 * It logs in, creates a draft blog with an image, publishes it, checks the public pages, edits it,
 * tests scheduling and HTML sanitizing, and finally deletes everything it created.
 */
const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const EMAIL = process.env.ADMIN_EMAIL;
const PASSWORD = process.env.ADMIN_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD (and optionally BASE_URL).');
  process.exit(2);
}

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let cookie = '';
let passed = 0;
let failed = 0;
const created = [];

function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`); }
}

async function http(pathname, options = {}) {
  const res = await fetch(BASE + pathname, { redirect: 'manual', ...options, headers: { ...(cookie ? { cookie } : {}), ...(options.headers || {}) } });
  return res;
}

async function text(pathname, options) {
  const res = await http(pathname, options);
  return { res, body: await res.text() };
}

async function getCsrf() {
  const { body } = await text('/admin/blogs/new');
  const m = /name="csrf" value="([^"]*)"/.exec(body);
  return m ? m[1] : '';
}

function blogForm(csrf, fields, withImage = true) {
  const fd = new FormData();
  fd.append('csrf', csrf);
  const base = {
    title: 'Smoke test blog', slug: '', excerpt: 'Short description for the smoke test.', category_id: '',
    author: 'Smoke Test', status: 'draft', published_at: '', content: '<h2>Hello</h2><p>Smoke test content.</p>'
  };
  for (const [k, v] of Object.entries({ ...base, ...fields })) fd.append(k, v);
  if (withImage) fd.append('featured_image', new Blob([PNG], { type: 'image/png' }), 'pixel.png');
  return fd;
}

async function firstCategoryId() {
  const { body } = await text('/admin/blogs/new');
  const m = /<select name="category_id"[^>]*>\s*<option value="(\d+)"/.exec(body);
  return m ? m[1] : '1';
}

async function findBlogId(title) {
  const { body } = await text(`/admin/blogs?q=${encodeURIComponent(title)}`);
  const row = body.split('<tr>').find(r => r.includes(`<strong>${title}</strong>`));
  const m = row && /\/admin\/blogs\/(\d+)\/edit/.exec(row);
  return m ? m[1] : null;
}

async function main() {
  console.log(`Testing ${BASE}\n`);

  console.log('Public site');
  let r = await text('/');
  check('home page loads', r.res.status === 200);
  r = await text('/blog');
  check('blog list loads', r.res.status === 200 && r.body.includes('blog-grid'), `status ${r.res.status}`);
  r = await text('/api/blogs/latest');
  let json = null;
  try { json = JSON.parse(r.body); } catch { /* ignore */ }
  check('/api/blogs/latest returns JSON', r.res.status === 200 && json && Array.isArray(json.blogs), `status ${r.res.status}`);
  r = await text('/sitemap.xml');
  check('sitemap.xml is served', r.res.status === 200 && r.body.includes('<urlset'), `status ${r.res.status}`);
  for (const secret of ['/.env.local', '/server.js', '/package.json', '/.git/config']) {
    r = await http(secret);
    check(`${secret} is NOT public`, r.status === 404, `status ${r.status}`);
  }

  console.log('\nAdmin login');
  r = await http('/admin', {});
  check('/admin redirects to login when logged out', [302, 303].includes(r.status) && (r.headers.get('location') || '').includes('/admin/login'));
  r = await http('/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'wrong@example.com', password: 'wrong' }).toString()
  });
  check('wrong password is rejected', r.status === 401, `status ${r.status}`);
  r = await http('/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: EMAIL, password: PASSWORD }).toString()
  });
  const cookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || ''];
  const sid = cookies.map(c => /(?:^|,\s*)(sid=[^;]+)/.exec(c)).find(Boolean);
  check('login works', [302, 303].includes(r.status) && Boolean(sid), `status ${r.status}`);
  if (!sid) throw new Error('Cannot continue without a login.');
  cookie = sid[1];

  const csrf = await getCsrf();
  check('form contains a CSRF token', csrf.length > 10);
  const categoryId = await firstCategoryId();

  console.log('\nCreate, publish, edit, delete');
  const stamp = Date.now();
  const title = `Smoke test blog ${stamp}`;
  r = await http('/admin/blogs/new', {
    method: 'POST',
    body: blogForm(csrf, {
      title, category_id: categoryId,
      content: '<h2>Hello</h2><p onclick="steal()">Smoke test content.</p><script>alert(1)</script><a href="javascript:alert(2)">bad link</a>'
    })
  });
  check('saving a new blog works (redirects to list)', [302, 303].includes(r.status) && (r.headers.get('location') || '').startsWith('/admin/blogs'), `status ${r.status}`);
  const id = await findBlogId(title);
  check('new blog appears in the admin list', Boolean(id));
  if (!id) throw new Error('Blog was not saved.');
  created.push(id);
  const slug = `smoke-test-blog-${stamp}`;

  r = await http(`/blog/${slug}`);
  check('draft is NOT public', r.status === 404, `status ${r.status}`);

  r = await http(`/admin/blogs/${id}/toggle`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf }).toString() });
  check('publish button works', [302, 303].includes(r.status), `status ${r.status}`);

  r = await text(`/blog/${slug}`);
  check('published blog page loads', r.res.status === 200 && r.body.includes('Smoke test content'), `status ${r.res.status}`);
  const articleHtml = (r.body.split('class="article-content">')[1] || '').split('class="article-cta"')[0];
  check('article HTML is kept', articleHtml.includes('<h2>Hello</h2>'), 'article content not found');
  check('script tags, on* handlers and javascript: links are removed from the article', articleHtml.length > 0 && !/<script/i.test(articleHtml) && !/onclick=/i.test(articleHtml) && !/javascript:/i.test(articleHtml));
  const imgMatch = new RegExp(`class="article-cover"><img src="([^"]+)"`).exec(r.body);
  if (imgMatch) {
    const imgUrl = imgMatch[1].replace(/&amp;/g, '&');
    const imgRes = await fetch(imgUrl.startsWith('http') ? imgUrl : BASE + imgUrl);
    check('uploaded featured image is reachable', imgRes.status === 200 && /^image\//.test(imgRes.headers.get('content-type') || ''), `status ${imgRes.status}`);
  } else {
    check('uploaded featured image is reachable', false, 'no image found on page');
  }
  r = await text('/blog');
  check('blog list shows the new blog', r.body.includes(title));
  r = await text('/api/blogs/latest');
  check('homepage API shows the new blog', r.body.includes(slug));
  r = await text('/sitemap.xml');
  check('sitemap contains the new blog', r.body.includes(slug));

  r = await http(`/admin/blogs/${id}/edit`, { method: 'POST', body: blogForm(csrf, { title: `${title} edited`, slug, category_id: categoryId, status: 'published' }, false) });
  check('editing a blog works', [302, 303].includes(r.status), `status ${r.status}`);
  r = await text(`/blog/${slug}`);
  check('edit is visible on the public page', r.body.includes(`${title} edited`));

  console.log('\nScheduling');
  const futureTitle = `Smoke scheduled ${stamp}`;
  const futureSlug = `smoke-scheduled-${stamp}`;
  const future = new Date(Date.now() + 5.5 * 3600 * 1000 + 3 * 24 * 3600 * 1000).toISOString().slice(0, 16); // ~3 days ahead (IST)
  r = await http('/admin/blogs/new', { method: 'POST', body: blogForm(csrf, { title: futureTitle, category_id: categoryId, status: 'scheduled', published_at: future }, false) });
  check('saving a scheduled blog works', [302, 303].includes(r.status), `status ${r.status}`);
  const futureId = await findBlogId(futureTitle);
  if (futureId) created.push(futureId);
  r = await http(`/blog/${futureSlug}`);
  check('scheduled (future) blog is NOT public yet', r.status === 404, `status ${r.status}`);

  console.log('\nValidation and security');
  r = await http('/admin/blogs/new', { method: 'POST', body: blogForm(csrf, { title: '   ', category_id: categoryId }, false) });
  const invalid = await r.text();
  check('empty title shows an error and keeps the form', r.status === 400 && invalid.includes('Blog title is required'), `status ${r.status}`);
  r = await http('/admin/blogs/new', { method: 'POST', body: blogForm('wrong-token', { title: 'x', category_id: categoryId }, false) });
  check('wrong CSRF token is rejected', r.status === 403, `status ${r.status}`);
  r = await text('/admin/categories');
  check('categories page loads', r.res.status === 200 && r.body.includes('Add Category'), `status ${r.res.status}`);
  if (process.env.SMOKE_ADD_CATEGORY === '1') { // categories cannot be deleted from the admin, so this is opt-in
    r = await http('/admin/categories', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, name: `Smoke cat ${stamp}` }).toString() });
    check('adding a category works', [302, 303].includes(r.status), `status ${r.status}`);
    r = await text('/admin/categories');
    check('new category is listed', r.body.includes(`Smoke cat ${stamp}`));
  }
}

async function cleanup() {
  if (!cookie) return;
  console.log('\nCleanup');
  try {
    const csrf = await getCsrf();
    for (const id of created) {
      const r = await http(`/admin/blogs/${id}/delete`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf }).toString() });
      check(`test blog ${id} deleted`, [302, 303].includes(r.status), `status ${r.status}`);
    }
  } catch (e) {
    console.log('  (cleanup failed:', e.message, ')');
  }
}

main()
  .catch(e => { failed += 1; console.log(`\nERROR: ${e.message}`); })
  .then(cleanup)
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
