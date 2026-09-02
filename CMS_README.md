# ACME Infotech Blog CMS

## Run locally

```bash
npm start
```

Open:

- Public website: `http://localhost:3000/`
- Public blog: `http://localhost:3000/blog`
- Admin login: `http://localhost:3000/admin/login`

## Default admin

On the first run, the CMS creates one admin user if no users exist:

- Email: `admin@acme.local`
- Password: `ChangeMe@12345`

For production, set these environment variables before the first run:

```bash
ADMIN_EMAIL="your-admin@example.com"
ADMIN_PASSWORD="use-a-long-strong-password"
PORT=3000
NODE_ENV=production
```

Passwords are stored with PBKDF2 hashing, never as plain text.

## Database and uploads

The CMS uses SQLite:

```text
data/cms.sqlite
```

Uploaded blog images are stored in:

```text
uploads/blogs/
```

Both database files and uploaded images are ignored by Git. Back them up on the production server.

## Dynamic blog URLs

The public blog is database-driven:

- Blog listing: `/blog`
- Blog detail: `/blog/{slug}`

Draft blogs are hidden from public pages. Published blogs appear automatically.
