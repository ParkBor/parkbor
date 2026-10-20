// Dev-only generator: `node site/tools/build.mjs` writes the static HTML pages and sitemap.xml.
// Cloudflare Pages does NOT run it; the generated files are committed. Text lives in tools/i18n/*.mjs.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import uz from './i18n/uz.mjs';
import ru from './i18n/ru.mjs';
import en from './i18n/en.mjs';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://parkbor.uz';
const V = '1'; // bump when assets/* change (cache busting; /assets/* is cached for a year)
const UPDATED = '2026-10-20';
const LANGS = [uz, ru, en];
const PAGES = ['', 'privacy', 'terms', 'delete-account']; // '' = home
const PHONES = [['+998 93 725 23 13', '+998937252313'], ['+998 94 498 45 48', '+998944984548']];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const path = (l, slug) => `${l.base}/${slug ? slug + '/' : ''}`;
const url = (l, slug) => ORIGIN + path(l, slug);
const sub = (l, html) => html.replaceAll('{B}', l.base);

function write(rel, html) {
  const file = join(SITE, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
}

function head(l, { title, desc, slug, noindex = false }) {
  const canon = noindex ? '' : `<link rel="canonical" href="${url(l, slug)}">
${LANGS.map((x) => `<link rel="alternate" hreflang="${x.code}" href="${url(x, slug)}">`).join('\n')}
<link rel="alternate" hreflang="x-default" href="${url(uz, slug)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="ParkBor">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${url(l, slug)}">
<meta property="og:locale" content="${l.ogLocale}">
<meta property="og:image" content="${ORIGIN}/assets/og-image.png?v=${V}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${ORIGIN}/assets/og-image.png?v=${V}">
`;
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
${noindex ? '<meta name="robots" content="noindex">\n' : canon}<meta name="theme-color" content="#0057b5">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.png" sizes="64x64" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="/assets/site.css?v=${V}">
<script src="/assets/site.js?v=${V}" defer></script>`;
}

const jsonLd = () => `<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'Organization', name: 'ParkBor', url: ORIGIN + '/',
  logo: ORIGIN + '/assets/parkbor-logo.png',
  contactPoint: [{ '@type': 'ContactPoint', contactType: 'customer support', email: 'parkbooor@gmail.com', telephone: '+998937252313', availableLanguage: ['uz', 'ru', 'en'] }],
})}</script>`;

function header(l, slug) {
  const nav = [['how', '#how'], ['benefits', '#benefits'], ['drivers', '#drivers'], ['faq', '#faq'], ['contact', '#contact']]
    .map(([k, h]) => `<a href="${l.base}/${h}">${l.nav[k]}</a>`).join('');
  const langs = LANGS.map((x) => x.code === l.code
    ? `<span aria-current="page" lang="${x.code}">${x.label}</span>`
    : `<a href="${path(x, slug)}" hreflang="${x.code}" lang="${x.code}">${x.label}</a>`).join('');
  return `<a class="skip" href="#main">${l.ui.skip}</a>
<header class="site-header"><div class="wrap bar">
<a class="logo" href="${l.base}/" aria-label="${l.ui.home}"><img src="/assets/parkbor-logo.png?v=${V}" width="640" height="216" alt="${l.ui.logoAlt}"></a>
<nav class="nav" id="site-nav" aria-label="${l.ui.menu}">${nav}</nav>
<div class="lang" role="group" aria-label="${l.ui.langNav}">${langs}</div>
<button class="menu-btn" type="button" data-menu-toggle aria-expanded="false" aria-controls="site-nav">${l.ui.menu}</button>
</div></header>`;
}

function footer(l) {
  const f = l.footer;
  return `<footer class="site-footer"><div class="wrap">
<ul>
<li><a href="${l.base}/privacy/">${f.privacy}</a></li>
<li><a href="${l.base}/terms/">${f.terms}</a></li>
<li><a href="${l.base}/delete-account/">${f.del}</a></li>
<li><a href="https://crm.parkbor.uz" rel="noopener">${f.crm}</a></li>
<li><a href="https://t.me/parkborbot" rel="noopener">${f.bot} @parkborbot</a></li>
</ul>
<p>&copy; 2026 ${f.rights}</p>
</div></footer>`;
}

function page(l, slug, opts, body) {
  return `<!doctype html>
<html lang="${l.htmlLang}">
<head>
${head(l, { ...opts, slug })}
${opts.noindex ? '' : jsonLd()}
</head>
<body>
${header(l, ['b', '404'].includes(slug) ? '' : slug)}
<main id="main">
${body}
</main>
${footer(l)}
</body>
</html>
`;
}

function home(l) {
  const h = l.home;
  const cards = (items) => `<ul class="cards">${items.map(([t, d]) => `<li class="card"><h3>${t}</h3><p>${d}</p></li>`).join('')}</ul>`;
  const steps = h.how.items.map(([t, d]) => `<li><h3>${t}</h3><p>${d}</p></li>`).join('');
  const faq = h.faq.items.map(([q, a]) => `<details><summary>${q}</summary><p>${sub(l, a)}</p></details>`).join('\n');
  const dr = h.drivers;
  return `<section class="hero"><div class="wrap grid"><div>
<p class="eyebrow">${h.eyebrow}</p>
<h1>${h.h1}</h1>
<p class="lead">${h.sub}</p>
<div class="actions"><a class="btn" href="https://crm.parkbor.uz" rel="noopener">${h.cta1}</a><a class="btn ghost" href="#contact">${h.cta2}</a></div>
</div><img class="mark" src="/assets/parkbor-mark.png?v=${V}" width="256" height="256" alt="" loading="lazy"></div></section>
<section id="how"><div class="wrap"><h2>${h.how.h}</h2><ol class="steps">${steps}</ol></div></section>
<section id="benefits" class="alt"><div class="wrap"><h2>${h.benefits.h}</h2><p class="muted">${h.benefits.intro}</p>${cards(h.benefits.items)}</div></section>
<section id="drivers"><div class="wrap"><h2>${dr.h}</h2><p>${dr.p}</p>
<ul class="checks">${dr.points.map((p) => `<li>${p}</li>`).join('')}</ul>
<div class="actions"><span class="btn" aria-disabled="true">App Store: ${dr.soon}</span><span class="btn" aria-disabled="true">Google Play: ${dr.soon}</span><a class="btn ghost" href="https://t.me/parkborbot" rel="noopener">${dr.bot}</a></div>
<p class="muted small">${dr.botNote}</p></div></section>
<section id="faq" class="alt"><div class="wrap"><h2>${h.faq.h}</h2>
${faq}
</div></section>
<section id="contact"><div class="wrap"><h2>${h.contact.h}</h2><p>${h.contact.p}</p>
<div class="contact-list">
<a class="btn" href="https://t.me/habibullo_2313" rel="noopener">${h.contact.tg}</a>
${PHONES.map(([label, num]) => `<a class="btn ghost" href="tel:${num}">${label}</a>`).join('\n')}
<a class="btn ghost" href="mailto:parkbooor@gmail.com">${h.contact.email}</a>
</div></div></section>`;
}

function legal(l, key) {
  const d = l[key];
  const secs = d.sections.map(([t, html]) => `<h2>${t}</h2>\n${sub(l, html)}`).join('\n');
  return `<article class="wrap doc">
<h1>${d.h1}</h1>
<p class="muted">${l.legalCommon.updated}: <time datetime="${UPDATED}">${UPDATED}</time></p>
<p class="draft">${l.legalCommon.draft}</p>
${secs}
</article>`;
}

const sitemapEntries = [];
for (const l of LANGS) {
  PAGES.forEach((slug) => {
    const key = { '': 'home', privacy: 'privacy', terms: 'terms', 'delete-account': 'del' }[slug];
    const d = key === 'home' ? l.home : l[key];
    const body = key === 'home' ? home(l) : legal(l, key);
    write(join(l.base.slice(1), slug, 'index.html'), page(l, slug, { title: d.title, desc: d.desc }, body));
    sitemapEntries.push(slug);
  });
}

// Booking helper: Cloudflare _redirects rewrites /b/* to this file; assets use absolute paths.
{
  const b = uz.b, r = ru.b, e = en.b;
  const body = `<section><div class="wrap doc">
<h1>${b.h1}</h1>
<div id="good-link" hidden>
<p><a id="open-booking" class="btn" href="/b/">${b.open}</a></p>
<p class="muted">${b.hint}</p>
<p class="muted small"><span lang="ru">${r.open}</span> &middot; <span lang="en">${e.open}</span></p>
</div>
<div id="bad-link" hidden>
<p><strong>${b.bad}</strong></p>
<p class="muted">${b.badHint}</p>
<p class="muted small"><span lang="ru">${r.bad}</span> &middot; <span lang="en">${e.bad}</span></p>
</div>
<noscript><p>${b.noscript}</p></noscript>
<p><a href="/">${b.home}</a></p>
</div></section>`;
  write('b/index.html', page(uz, 'b', { title: b.title + ' | ParkBor', desc: b.title, noindex: true }, body));
}

{
  const n = uz.notFound;
  const body = `<section><div class="wrap doc"><h1>${n.h1}</h1><p>${n.p}</p><p><a class="btn" href="/">${n.home}</a></p></div></section>`;
  write('404.html', page(uz, '404', { title: n.title, desc: n.p, noindex: true }, body));
}

const urlset = LANGS.flatMap((l) => PAGES.map((slug) => {
  const alts = LANGS.map((x) => `    <xhtml:link rel="alternate" hreflang="${x.code}" href="${url(x, slug)}"/>`)
    .concat(`    <xhtml:link rel="alternate" hreflang="x-default" href="${url(uz, slug)}"/>`).join('\n');
  return `  <url>\n    <loc>${url(l, slug)}</loc>\n    <lastmod>${UPDATED}</lastmod>\n${alts}\n  </url>`;
})).join('\n');
write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urlset}\n</urlset>\n`);
console.log('site built');
