# ACME Infotech Blog CMS

Node.js server (`server.js`) + PostgreSQL + Vercel Blob (image storage).
The public blog (`/blog`, `/blog/{slug}`), the homepage blog cards (`/api/blogs/latest`) and `/sitemap.xml`
are generated from the database. Draft blogs are hidden; scheduled blogs appear automatically at their date/time (IST).

## Environment variables

Copy `.env.example` to `.env.local` for local work. On Vercel add the same names in
**Project -> Settings -> Environment Variables**, then redeploy.

| Name | Required | Purpose |
| --- | --- | --- |
| `POSTGRES_URL` (or `DATABASE_URL`) | yes | PostgreSQL connection string. Vercel Storage (Neon) adds `POSTGRES_URL` automatically. |
| `SESSION_SECRET` | yes (production) | Long random text that signs admin login cookies. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | yes (production) | Admin login. The password is stored hashed. |
| `BLOB_READ_WRITE_TOKEN` | yes on Vercel | Image uploads. Added automatically when a Blob store is connected. |

Generate a secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

### Admin password

`ADMIN_EMAIL` / `ADMIN_PASSWORD` are the source of truth. To change the password, change `ADMIN_PASSWORD` and
redeploy/restart. If you use a new `ADMIN_EMAIL`, the old default account (`admin@acme.local`) is removed automatically.
In development, if no admin variables are set, `admin@acme.local` / `ChangeMe@12345` is created (never in production).

## Run locally

```bash
npm install
# .env.local needs POSTGRES_URL or DATABASE_URL (any PostgreSQL database)
npm start
```

- Website: http://localhost:3000/
- Blog: http://localhost:3000/blog
- Admin: http://localhost:3000/admin/login

Without `BLOB_READ_WRITE_TOKEN`, uploaded images are saved in `uploads/blogs/` (local development only).
Tables are created automatically on first start.

## Check that everything works

```bash
BASE_URL=http://localhost:3000 ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=secret npm run smoke
BASE_URL=https://your-site.com ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=secret npm run smoke
```

The smoke test logs in, creates a draft with an image, publishes it, checks the public pages, edits, schedules,
checks HTML sanitizing and CSRF protection, then deletes what it created (the tiny test image stays in Blob storage).

## Deploy

```bash
npx vercel --prod
```

Only public website files are published (see `vercel.json` and `.vercelignore`). Source code, `.env*`, `data/` and
helper scripts are never public.

## Limits and notes

- Images: JPG, PNG, WEBP, GIF, max 3MB each. The editor resizes big photos in the browser first.
  Vercel limits a whole request to 4.5MB, so keep featured + OG images small.
- Blog HTML is sanitized on save and on display. Allowed: headings, lists, links, tables, images, quotes, and
  YouTube/Vimeo iframes. Scripts, inline styles, event handlers and other iframes are removed.
- Login is rate-limited (8 wrong attempts per 15 minutes per IP).
- Old static files (`blog.html`, `blog/*.html`, `sitemap.xml`) are no longer used; `/blog/*.html` URLs redirect to the
  new URLs. They can be deleted.
