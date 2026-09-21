# Acme Infotech Security System - Official Website

![Acme Infotech](images/favicon.ico)

> Official website of Acme Infotech Security System - Surat's leading dealer of CCTV cameras, biometric attendance machines, and security systems.

## Project Description

This is a modern, ultra-fast, static HTML website developed for **Acme Infotech Security System**. It serves as their digital storefront, showcasing their product catalog (CCTV, Access Control, EPABX), services, customer reviews, and contact information. The design features a dark-themed aesthetic with neon green accents, built to convert visitors into inquiries.

## Folder Structure

```
acme-infotech-website/
├── css/
│   └── style.css          # Minified and extracted CSS rules
├── js/
│   └── script.js          # Interactive UI scripts (modals, active states)
├── assets/                # General assets
├── images/                # Images and favicons
├── index.html             # Main entry point (HTML5)
├── 404.html               # Custom 404 error page
├── vercel.json            # Deployment config & security headers
├── robots.txt             # Search engine crawling rules
├── sitemap.xml            # Sitemap for Google Indexing
├── manifest.webmanifest   # PWA setup for mobile devices
├── README.md              # Project documentation
└── .gitignore             # Git ignored files
```

## Installation (Local Development)

To run this project locally, simply clone the repository and open the `index.html` file in any modern web browser. 
Alternatively, use a local server for the best experience:

```bash
# 1. Clone the repository
git clone https://github.com/creatwithavi-lang/acme-infotech-website.git

# 2. Navigate into the project
cd acme-infotech-website

# 3. Start a local server (using Python or Node)
# (Option A) npx serve
npx serve
# (Option B) Python 3
python -m http.server 3000
```

## Deployment

This website is configured for seamless deployment on **Vercel**.

1. Connect your GitHub repository to Vercel.
2. Ensure the Framework Preset is set to **Other**.
3. Leave Build Command and Output Directory **empty**.
4. The site will automatically build and deploy from the `main` branch.

## SEO Features

- **Semantic HTML5:** Using header tags (`<h1>`, `<h2>`) and section semantic blocks correctly.
- **Meta Tags:** Complete Open Graph tags for Facebook/LinkedIn and Twitter Cards.
- **Schema.org Markup:** JSON-LD scripts for LocalBusiness and FAQPage for rich search results.
- **robots.txt & Sitemap:** Automatically guides search bots.
- **Canonical URLs:** Configured to prevent duplicate content issues.

## Performance Features

- **No Framework Overhead:** Built purely with HTML, CSS, and Vanilla JS.
- **Extracted Assets:** CSS and JS are moved into separate files allowing browser caching.
- **Webmanifest & Favicon:** Ensures fast mobile-app-like experience.
- **Vercel Edge Network:** Served globally on one of the fastest CDNs.
- **Security Headers:** Enforced via `vercel.json` (HSTS, XSS Protection).

## Technology Used

- **HTML5:** Core structure.
- **Vanilla CSS3:** Styling with CSS Variables, Flexbox, Grid, and Animations.
- **Vanilla JavaScript (ES6):** Functionality without any heavy libraries.
- **Vercel:** Hosting and continuous deployment.

## Author

**Creatwithavi** - [GitHub](https://github.com/creatwithavi-lang)

## License

Copyright © 2026 Acme Infotech Security System. All rights reserved.
