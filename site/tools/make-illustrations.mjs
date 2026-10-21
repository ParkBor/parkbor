// Generates SCHEMATIC guide illustrations (NOT real screenshots) as SVG into site/assets/guide/<name>.<lang>.svg.
// Run: node site/tools/make-illustrations.mjs && node site/tools/build.mjs
// Texts are read from the real app sources (mobile i18n, CRM i18n, bot messages.py). Deterministic output.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mobile, crm, botTexts } from './strings.mjs';
import { ALT } from './i18n/guide.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'guide');
const BLUE = '#0057B5', GREEN = '#3CC755', INK = '#0b1220', MUTED = '#475467', SURF = '#f3f7fc', LINE = '#c9d4e3', GREENTXT = '#177a32';
const FONT = 'system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tpl = (s, o) => String(s).replace(/\{\{(\w+)\}\}/g, (_, k) => o[k]);
const num = (n) => Math.round(n * 10) / 10;

// ---- text helpers (manual wrapping, ~0.58em per character) ----
function wrap(str, maxPx, s) {
  const per = Math.max(4, Math.floor(maxPx / (s * 0.58)));
  const out = [];
  for (const para of String(str).split('\n')) {
    let line = '';
    for (const w of para.split(' ')) {
      if (line && (line + ' ' + w).length > per) { out.push(line); line = w; } else line = line ? line + ' ' + w : w;
    }
    out.push(line);
  }
  return out;
}
const H = (str, max, s, lh = 1.35) => wrap(str, max, s).length * s * lh;
function T(x, y, str, { s = 13, w = 400, f = INK, a = 'start', max = 1e9, lh = 1.35 } = {}) {
  return wrap(str, max, s).map((l, i) =>
    `<text x="${num(x)}" y="${num(y + s + i * s * lh)}" font-size="${s}" font-weight="${w}" fill="${f}" text-anchor="${a}">${esc(l)}</text>`).join('');
}
const shrink = (label, wpx, s) => Math.min(s, Math.max(8, Math.floor((wpx - 16) / (label.length * 0.58))));

// ---- UI primitives ----
const rect = (x, y, w, h, fill, r = 0, stroke = '') => `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="${r}" fill="${fill}"${stroke ? ` stroke="${stroke}"` : ''}/>`;
function btn(x, y, w, h, label, { fill = BLUE, color = '#fff', stroke = '', s = 14 } = {}) {
  const fs = shrink(label, w, s);
  return rect(x, y, w, h, fill, 10, stroke) + `<text x="${num(x + w / 2)}" y="${num(y + h / 2 + fs * 0.35)}" font-size="${fs}" font-weight="600" fill="${color}" text-anchor="middle">${esc(label)}</text>`;
}
const ghost = (x, y, w, h, label, s = 13) => btn(x, y, w, h, label, { fill: '#fff', color: BLUE, stroke: BLUE, s });
function chip(x, y, label, sel = false, s = 12) {
  const w = Math.ceil(label.length * s * 0.6 + 22);
  return { w, svg: rect(x, y, w, 30, sel ? BLUE : '#fff', 15, sel ? BLUE : LINE) + `<text x="${num(x + w / 2)}" y="${y + 20}" font-size="${s}" font-weight="600" fill="${sel ? '#fff' : INK}" text-anchor="middle">${esc(label)}</text>` };
}
function chips(x, y, labels, selIdx = 0, gap = 8) {
  let cx = x, out = '';
  labels.forEach((l, i) => { const c = chip(cx, y, l, i === selIdx); out += c.svg; cx += c.w + gap; });
  return { svg: out, w: cx - gap - x };
}
const field = (x, y, w, label, value, { ph = false, h = 44 } = {}) =>
  T(x, y, label, { s: 11, f: MUTED, max: w }) + rect(x, y + 17, w, h, '#fff', 8, LINE) +
  `<text x="${x + 12}" y="${y + 17 + h / 2 + 5}" font-size="14" fill="${ph ? MUTED : INK}">${esc(value)}</text>`;
const skel = (x, y, w, h = 9) => rect(x, y, w, h, '#dfe6f0', h / 2);
const ring = (x, y, w, h, r = 10) => `<rect x="${num(x - 3)}" y="${num(y - 3)}" width="${num(w + 6)}" height="${num(h + 6)}" rx="${r + 3}" fill="none" stroke="${GREEN}" stroke-width="3"/>`;
const callout = (n, x, y) => `<circle cx="${x}" cy="${y}" r="12" fill="${GREEN}"/><text x="${x}" y="${y + 5}" font-size="14" font-weight="700" fill="${INK}" text-anchor="middle">${n}</text>`;
const mark = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${BLUE}"/><text x="${cx}" y="${num(cy + r * 0.38)}" font-size="${num(r * 1.1)}" font-weight="700" fill="#fff" text-anchor="middle">P</text>`;

// ---- frames ----
function svgDoc(w, h, title, desc, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" font-family="${FONT}">
<title>${esc(title)}</title><desc>${esc(desc)}</desc>
${body}
</svg>
`;
}
function phone(inner, bg = '#fff') {
  return `<clipPath id="s"><rect x="8" y="8" width="344" height="624" rx="30"/></clipPath>
${rect(0, 0, 360, 640, '#1b2433', 38)}${rect(8, 8, 344, 624, bg, 30)}
<g clip-path="url(#s)">${inner}</g>
<text x="30" y="32" font-size="12" font-weight="700" fill="${INK}">9:41</text>${rect(300, 22, 24, 11, INK, 3)}<circle cx="180" cy="20" r="4" fill="#1b2433"/>`;
}
function browser(inner) {
  return `<clipPath id="b"><rect x="0" y="0" width="640" height="400" rx="12"/></clipPath>
<g clip-path="url(#b)">${rect(0, 0, 640, 400, SURF)}${rect(0, 0, 640, 36, '#e3e9f2')}
<circle cx="18" cy="18" r="5" fill="#c9d4e3"/><circle cx="36" cy="18" r="5" fill="#c9d4e3"/><circle cx="54" cy="18" r="5" fill="#c9d4e3"/>
${rect(120, 8, 260, 20, '#fff', 10)}<text x="132" y="22" font-size="11" fill="${MUTED}">crm.parkbor.uz</text>
${inner}</g>${rect(0.5, 0.5, 639, 399, 'none', 12, LINE)}`;
}
const bar = (title, s = 22) => T(24, 52, title, { s, w: 700, max: 300 });

// ---- chat UI (generic, no Telegram branding) ----
function chatHeader(name, sub) {
  return rect(0, 0, 360, 92, BLUE) + `<circle cx="38" cy="66" r="16" fill="#fff"/><text x="38" y="72" font-size="16" font-weight="700" fill="${BLUE}" text-anchor="middle">P</text>` +
    `<text x="62" y="62" font-size="15" font-weight="700" fill="#fff">${esc(name)}</text><text x="62" y="78" font-size="11" fill="#e3eefb">${esc(sub)}</text>`;
}
function bubble(x, y, str, { right = false, w = 270, s = 12 } = {}) {
  const h = H(str, w - 24, s) + 20, bx = right ? 352 - w - 4 : x;
  return { h, svg: rect(bx, y, w, h, right ? '#cfe5ff' : '#fff', 14) + T(bx + 12, y + 8, str, { s, max: w - 24 }) };
}

// ---- screens ----
const BOT_START = 'START';
const INSTALL = {
  uz: { title: 'ParkBor ilovasini o‘rnatish', install: 'O‘rnatish', warn: 'Play Protect', more: 'Batafsil', anyway: 'Baribir o‘rnatish' },
  ru: { title: 'Установить приложение ParkBor', install: 'Установить', warn: 'Play Protect', more: 'Подробнее', anyway: 'Всё равно установить' },
  en: { title: 'Install the ParkBor app', install: 'Install', warn: 'Play Protect', more: 'More details', anyway: 'Install anyway' },
};
const SAMPLE_CODE = '482915';

const screens = {
  '01-install: phone': (L, M) => {
    const I = INSTALL[L];
    return phone(rect(0, 0, 360, 640, '#e8edf4') + rect(24, 110, 312, 190, '#fff', 20) + mark(70, 160, 24) +
      T(108, 148, I.title, { s: 15, w: 700, max: 215 }) + skel(40, 208, 280) + skel(40, 228, 200) +
      ghost(150, 252, 84, 36, M.common.cancel, 12) + btn(244, 252, 84, 36, I.install, { s: 13 }) + ring(244, 252, 84, 36) + callout(1, 336, 250) +
      rect(24, 330, 312, 150, '#fff', 20) + `<text x="44" y="362" font-size="14" font-weight="700" fill="${INK}">${esc(I.warn)}</text>` +
      skel(44, 378, 270) + skel(44, 396, 220) + `<text x="44" y="436" font-size="13" font-weight="600" fill="${BLUE}">${esc(I.more)}</text>` +
      ghost(190, 424, 130, 36, I.anyway, 12) + ring(190, 424, 130, 36) + callout(2, 324, 422));
  },
  '02-language: phone': (L, M) => {
    const names = [M.languages.uz, M.languages.ru, M.languages.en], sel = ['uz', 'ru', 'en'].indexOf(L);
    const c = chips(0, 0, names, sel); const x0 = 180 - c.w / 2;
    return phone(mark(180, 130, 36) + T(180, 182, M.login.title, { s: 24, w: 700, a: 'middle' }) +
      T(180, 216, M.login.subtitle, { s: 14, f: MUTED, a: 'middle', max: 280 }) +
      T(180, 296, M.login.language, { s: 12, f: MUTED, a: 'middle' }) + `<g transform="translate(${num(x0)} 318)">${c.svg}</g>` +
      ring(x0, 318, c.w, 30, 15) + callout(1, num(x0 + c.w + 18), 318) +
      btn(30, 392, 300, 48, M.login.telegramButton) + T(180, 456, M.login.terms, { s: 11, f: MUTED, a: 'middle', max: 280 }));
  },
  '03-bot-start: phone': (L, M, B) => {
    const b = bubble(10, 110, B[L].help);
    return phone(rect(0, 0, 360, 640, '#e9eef5') + chatHeader('ParkBor', '@parkborbot') + b.svg +
      rect(0, 570, 360, 62, '#fff') + btn(24, 580, 312, 42, BOT_START, { s: 14 }) + ring(24, 580, 312, 42) + callout(1, 346, 578), '#e9eef5');
  },
  '04-share-phone: phone': (L, M, B) => {
    const u = bubble(0, 110, '/start', { right: true, w: 90 });
    const b = bubble(10, 110 + u.h + 10, B[L].ask_contact);
    return phone(rect(0, 0, 360, 640, '#e9eef5') + chatHeader('ParkBor', '@parkborbot') + u.svg + b.svg +
      rect(0, 560, 360, 72, '#fff') + btn(20, 574, 320, 44, B[L].share_button, { fill: '#e3e9f2', color: INK, s: 14 }) + ring(20, 574, 320, 44) + callout(1, 346, 572), '#e9eef5');
  },
  '05-code: phone': (L, M, B) => {
    const msg = tpl(B[L].code_sent.replace('{code}', '{{c}}'), { c: SAMPLE_CODE });
    const b = bubble(10, 44, msg, { w: 340, s: 11 }); const y0 = 44 + b.h + 30;
    let cells = ''; for (let i = 0; i < 6; i++) cells += rect(30 + i * 52, y0 + 66, 44, 52, '#fff', 8, LINE) + `<text x="${52 + i * 52}" y="${y0 + 100}" font-size="22" font-weight="700" fill="${INK}" text-anchor="middle">${SAMPLE_CODE[i]}</text>`;
    return phone(rect(0, 0, 360, 640, '#fff') + rect(0, 36, 360, b.h + 16, '#e9eef5') + b.svg +
      T(30, y0, M.code.title, { s: 20, w: 700 }) + T(30, y0 + 28, M.code.subtitle, { s: 12, f: MUTED, max: 300 }) + cells + ring(30, y0 + 66, 316, 52) + callout(1, 352, y0 + 62) +
      T(30, y0 + 130, tpl(M.code.timerLabel, { time: '04:32' }), { s: 12, f: MUTED }) +
      btn(30, y0 + 158, 300, 46, M.code.verify) + ring(30, y0 + 158, 300, 46) + callout(2, 342, y0 + 156) +
      T(30, y0 + 220, M.code.phishingWarning, { s: 10.5, f: MUTED, max: 300 }));
  },
  '06-name: phone': (L, M) => phone(bar(M.profile.title) + T(24, 98, M.profile.subtitle, { s: 14, f: MUTED, max: 310 }) +
    field(24, 150, 312, M.profile.firstName, 'Ali') + ring(24, 167, 312, 44, 8) + callout(1, 346, 164) +
    btn(24, 240, 312, 48, M.profile.save) + ring(24, 240, 312, 48) + callout(2, 346, 238)),
  'crm-00-userinfo: phone': (L, M, B, C) => {
    const u = bubble(0, 110, '/start', { right: true, w: 90 });
    const b = bubble(10, 110 + u.h + 10, 'Id: 123456789', { w: 200, s: 14 });
    return phone(rect(0, 0, 360, 640, '#e9eef5') + chatHeader('userinfobot', 'bot') + u.svg + b.svg +
      ring(10, 120 + u.h, 200, b.h, 14) + callout(1, 218, 118 + u.h), '#e9eef5');
  },
  'crm-01-login: browser': (L, M, B, C) => browser(rect(170, 80, 300, 250, '#fff', 16, LINE) + mark(320, 128, 24) +
    T(320, 166, C.app.title, { s: 20, w: 700, a: 'middle' }) + T(320, 196, C.auth.subtitle, { s: 12, f: MUTED, a: 'middle', max: 250 }) +
    btn(220, 250, 200, 44, 'Telegram') + ring(220, 250, 200, 44) + callout(1, 430, 248)),
};

const altFor = (name, lang) => ALT[lang][name] ?? name;

mkdirSync(OUT, { recursive: true });
const B = botTexts();
let count = 0;
for (const key of Object.keys(screens)) {
  const [name, kind] = key.split(': ');
  for (const L of ['uz', 'ru', 'en']) {
    const body = screens[key](L, mobile[L], B, crm[L]);
    const [w, h] = kind === 'phone' ? [360, 640] : [640, 400];
    const alt = altFor(name, L);
    const svg = svgDoc(w, h, alt, `${alt} (${L})`, body);
    if (/<script|foreignObject|href=|\son\w+=/i.test(svg)) throw new Error(`unsafe svg ${name}`);
    if (svg.length > 12000) throw new Error(`${name}.${L}.svg too big: ${svg.length}`);
    writeFileSync(join(OUT, `${name}.${L}.svg`), svg);
    count++;
  }
}
console.log(`wrote ${count} SVG files to ${OUT}`);
