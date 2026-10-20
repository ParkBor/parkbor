'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { isValidBookingId, bookingIdFromPath } = require('../assets/site.js');

const ROOT = path.join(__dirname, '..');
const ORIGIN = 'https://parkbor.uz';

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'tests' || e.name === 'tools') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const htmlFiles = walk(ROOT).filter((f) => f.endsWith('.html'));
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
const read = (f) => fs.readFileSync(f, 'utf8');
const SPECIAL = new Set(['b/index.html', '404.html']);
const content = htmlFiles.filter((f) => !SPECIAL.has(rel(f)));

const LANG_OF = (r) => (r.startsWith('ru/') ? 'ru' : r.startsWith('en/') ? 'en' : 'uz');
const urlOf = (r) => ORIGIN + '/' + r.replace(/index\.html$/, '');

test('expected page set exists (3 languages x 4 pages + b + 404)', () => {
  assert.strictEqual(content.length, 12);
  assert.ok(htmlFiles.length === 14);
});

for (const f of htmlFiles) {
  const r = rel(f);
  const html = read(f);
  test(`${r}: structure`, () => {
    assert.ok(/^<!doctype html>/i.test(html));
    assert.strictEqual((html.match(/<h1[\s>]/g) || []).length, 1, 'exactly one h1');
    assert.strictEqual((html.match(/<main[\s>]/g) || []).length, 1);
    assert.ok(html.includes(`<html lang="${LANG_OF(r)}">`), 'lang matches folder');
    for (const tag of ['html', 'head', 'body', 'main', 'header', 'footer']) {
      assert.strictEqual((html.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length, (html.match(new RegExp(`</${tag}>`, 'g')) || []).length, tag);
    }
    assert.ok(!/<img(?![^>]*\swidth=)[^>]*>/.test(html), 'img has width');
    assert.ok(!/<img(?![^>]*\salt=)[^>]*>/.test(html), 'img has alt');
  });
  test(`${r}: CSP-safe (no inline script, handlers or style)`, () => {
    for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
      assert.ok(/\ssrc="\/assets\/site\.js\?v=\d+"/.test(m[1]) || /type="application\/ld\+json"/.test(m[1]), 'script: ' + m[1]);
    }
    assert.ok(!/\son[a-z]+\s*=/i.test(html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, '')), 'no on* handlers');
    assert.ok(!/\sstyle\s*=/i.test(html) && !/<style/i.test(html), 'no inline style');
    assert.ok(!/javascript:/i.test(html));
  });
  test(`${r}: local links and assets resolve`, () => {
    for (const m of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
      const v = m[1];
      if (/^(https?:|mailto:|tel:|#)/.test(v)) continue;
      assert.ok(v.startsWith('/'), 'root-relative expected: ' + v);
      const p = v.split('#')[0].split('?')[0];
      if (r === 'b/index.html' && p === '/b/') continue; // placeholder href, replaced by JS
      const target = path.join(ROOT, p.endsWith('/') ? p + 'index.html' : p);
      assert.ok(fs.existsSync(target), `${r}: missing ${v}`);
    }
  });
  test(`${r}: only allowlisted external and contact links`, () => {
    const allowed = new Set([
      'https://crm.parkbor.uz', 'https://t.me/parkborbot', 'https://t.me/habibullo_2313',
      'mailto:parkbooor@gmail.com', 'tel:+998937252313', 'tel:+998944984548',
    ]);
    for (const m of html.matchAll(/\shref="((?:https?:|mailto:|tel:)[^"]*)"/g)) {
      const v = m[1];
      if (v.startsWith(ORIGIN + '/')) continue; // canonical / alternates
      assert.ok(allowed.has(v), 'not allowed: ' + v);
    }
    assert.ok(!/<form\b/i.test(html) && !/<input\b/i.test(html));
  });
}

for (const f of content) {
  const r = rel(f);
  const html = read(f);
  test(`${r}: canonical, hreflang trio, OG/Twitter, JSON-LD`, () => {
    assert.ok(html.includes(`<link rel="canonical" href="${urlOf(r)}">`));
    const slug = r.replace(/^(ru|en)\//, '');
    for (const [code, pre] of [['uz', ''], ['ru', 'ru/'], ['en', 'en/']]) {
      assert.ok(html.includes(`hreflang="${code}" href="${urlOf(pre + slug)}"`), 'hreflang ' + code);
    }
    assert.ok(html.includes('hreflang="x-default"'));
    for (const k of ['og:title', 'og:description', 'og:image', 'og:url']) assert.ok(html.includes(`property="${k}"`), k);
    assert.ok(html.includes('name="twitter:card"') && html.includes('name="description"'));
    const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(ld, 'json-ld');
    const o = JSON.parse(ld[1]);
    assert.strictEqual(o['@type'], 'Organization');
    assert.strictEqual(o.name, 'ParkBor');
    assert.ok(o.logo && o.url && o.contactPoint);
  });
}

test('home pages contain all contact links', () => {
  for (const r of ['index.html', 'ru/index.html', 'en/index.html']) {
    const html = read(path.join(ROOT, r));
    for (const v of ['https://t.me/habibullo_2313', 'tel:+998937252313', 'tel:+998944984548', 'mailto:parkbooor@gmail.com', 'https://crm.parkbor.uz', 'https://t.me/parkborbot']) {
      assert.ok(html.includes(`href="${v}"`), `${r} ${v}`);
    }
    for (const id of ['how', 'benefits', 'drivers', 'faq', 'contact']) assert.ok(html.includes(`id="${id}"`), id);
  }
});

test('legal pages carry operator placeholder and date', () => {
  for (const r of ['privacy', 'terms'].flatMap((s) => [`${s}/`, `ru/${s}/`, `en/${s}/`])) {
    const html = read(path.join(ROOT, r, 'index.html'));
    assert.ok(html.includes('[Operator: ParkBor, contact email parkbooor@gmail.com]'));
    assert.ok(html.includes('2026-10-20'));
  }
});

test('sitemap lists every content page with alternates; not b/404', () => {
  const xml = read(path.join(ROOT, 'sitemap.xml'));
  for (const f of content) assert.ok(xml.includes(`<loc>${urlOf(rel(f))}</loc>`), rel(f));
  assert.strictEqual((xml.match(/<loc>/g) || []).length, content.length);
  assert.ok(!xml.includes('/b/') && !xml.includes('404'));
  assert.strictEqual((xml.match(/hreflang="x-default"/g) || []).length, content.length);
});

test('deployment files', () => {
  const h = read(path.join(ROOT, '_headers'));
  assert.ok(h.includes("script-src 'self'") && h.includes("frame-ancestors 'none'") && h.includes('X-Frame-Options: DENY'));
  assert.ok(read(path.join(ROOT, '_redirects')).includes('/b/*  /b/index.html  200'));
  assert.ok(read(path.join(ROOT, 'robots.txt')).includes('Sitemap: https://parkbor.uz/sitemap.xml'));
  const s = read(path.join(ROOT, '.well-known/security.txt'));
  assert.ok(s.includes('mailto:parkbooor@gmail.com') && s.includes('Expires: 2027-10-20'));
});

test('booking id validator', () => {
  const ok = '123e4567-e89b-12d3-a456-426614174000';
  assert.ok(isValidBookingId(ok));
  assert.ok(isValidBookingId(ok.toUpperCase()));
  for (const bad of ['', '../x', '<script>', ok + '0', ok.slice(0, 35), ok.replace('4567', 'zzzz'), ok + '/', ' ' + ok, null, undefined, 5]) {
    assert.ok(!isValidBookingId(bad), String(bad));
  }
  assert.strictEqual(bookingIdFromPath('/b/' + ok), ok);
  assert.strictEqual(bookingIdFromPath('/b/' + ok + '/'), ok);
  for (const bad of ['/b/', '/b', '/b/../x', '/b/%3Cscript%3E', '/b/' + ok + '/x', '/x/' + ok, '/b/' + ok + '?x=1']) {
    assert.strictEqual(bookingIdFromPath(bad), null, bad);
  }
});
