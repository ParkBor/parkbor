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
const pin = (x, y, c = BLUE) => `<g transform="translate(${x} ${y})"><path d="M0 0C-9-12-12-19-12-24a12 12 0 1 1 24 0C12-19 9-12 0 0z" fill="${c}"/><circle cy="-24" r="5" fill="#fff"/></g>`;

// QR-LIKE pattern (decorative, NOT a real, scannable QR code)
function qrLike(x, y, size) {
  const n = 19, c = size / n; let seed = 7, d = '';
  const finder = (i, j) => (i < 7 && j < 7) || (i < 7 && j >= n - 7) || (i >= n - 7 && j < 7);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    if (finder(i, j)) continue;
    if ((seed >> 8) % 2) d += `M${num(x + j * c)} ${num(y + i * c)}h${num(c)}v${num(c)}h${num(-c)}z`;
  }
  let out = `<path d="${d}" fill="${INK}"/>`;
  for (const [fi, fj] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    const fx = x + fj * c, fy = y + fi * c;
    out += rect(fx, fy, 7 * c, 7 * c, INK) + rect(fx + c, fy + c, 5 * c, 5 * c, '#fff') + rect(fx + 2 * c, fy + 2 * c, 3 * c, 3 * c, INK);
  }
  return out;
}

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
function browser(inner, sidebar = null) {
  let side = '';
  if (sidebar) {
    side = rect(0, 36, 150, 364, '#fff') + rect(150, 36, 1, 364, LINE) + mark(24, 62, 11) +
      `<text x="42" y="67" font-size="12" font-weight="700" fill="${INK}">${esc(sidebar.title)}</text>` +
      sidebar.items.map((it, i) => (it.active ? rect(8, 84 + i * 30, 134, 26, '#e3eefb', 6) : '') +
        `<text x="18" y="${102 + i * 30}" font-size="12" font-weight="${it.active ? 700 : 400}" fill="${it.active ? BLUE : INK}">${esc(it.label)}</text>`).join('');
  }
  return `<clipPath id="b"><rect x="0" y="0" width="640" height="400" rx="12"/></clipPath>
<g clip-path="url(#b)">${rect(0, 0, 640, 400, SURF)}${rect(0, 0, 640, 36, '#e3e9f2')}
<circle cx="18" cy="18" r="5" fill="#c9d4e3"/><circle cx="36" cy="18" r="5" fill="#c9d4e3"/><circle cx="54" cy="18" r="5" fill="#c9d4e3"/>
${rect(120, 8, 260, 20, '#fff', 10)}<text x="132" y="22" font-size="11" fill="${MUTED}">crm.parkbor.uz</text>
${side}${inner}</g>${rect(0.5, 0.5, 639, 399, 'none', 12, LINE)}`;
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
  '07-vehicle: phone': (L, M) => {
    const V = M.vehicles, c = chips(0, 0, [V.type_CAR, V.type_TRUCK, V.type_EV], 0);
    return phone(bar(V.addTitle) + field(24, 110, 312, V.plate, V.platePlaceholder, { ph: true }) + ring(24, 127, 312, 44, 8) + callout(1, 346, 124) +
      T(24, 184, V.plateHint, { s: 11, f: MUTED, max: 312 }) + T(24, 236, V.type, { s: 11, f: MUTED }) + `<g transform="translate(24 254)">${c.svg}</g>` +
      btn(24, 320, 312, 48, V.save) + callout(2, 346, 318));
  },
  '08-map: phone': (L, M) => {
    const m = M.map;
    const roads = '<path d="M0 120L360 200M60 40L140 400M220 40L300 400M0 300L360 260" stroke="#fff" stroke-width="9" fill="none"/>';
    return phone(rect(0, 36, 360, 380, '#e4eee0') + '<path d="M250 60Q340 90 330 170Q290 150 250 120z" fill="#cfe3f5"/>' + roads +
      pin(90, 170) + pin(240, 250) + pin(160, 330) + pin(280, 330) + pin(120, 100, GREENTXT) + callout(1, 150, 80) +
      rect(0, 380, 360, 252, '#fff', 24) + rect(150, 390, 60, 5, LINE, 3) +
      T(24, 406, m.sheetTitle, { s: 16, w: 700, max: 220 }) + T(24, 430, tpl(m.sheetFound, { count: 3 }), { s: 11, f: MUTED, max: 300 }) +
      rect(16, 454, 328, 150, SURF, 14, LINE) + skel(30, 470, 160, 11) + T(30, 494, tpl(m.freeOfTotal, { free: 12, total: 40 }), { s: 13, w: 600, max: 190 }) +
      rect(252, 468, 78, 24, '#dcf3e2', 12) + `<text x="291" y="485" font-size="11" font-weight="700" fill="${GREENTXT}" text-anchor="middle">${esc(m.open)}</text>` +
      ghost(30, 540, 140, 40, m.route, 13) + btn(180, 540, 150, 40, m.details, { s: 13 }) + ring(180, 540, 150, 40) + callout(2, 338, 538));
  },
  '09-booking: phone': (L, M) => {
    const f = M.booking.form, c = chips(0, 0, [M.map.slot.STANDARD, M.map.slot.EV], 0);
    return phone(bar(f.title) + T(24, 100, f.slotType, { s: 11, f: MUTED }) + `<g transform="translate(24 118)">${c.svg}</g>` + ring(24, 118, c.w, 30, 15) + callout(1, num(34 + c.w), 114) +
      T(24, 170, f.day + ' / ' + f.start, { s: 11, f: MUTED, max: 312 }) + rect(24, 188, 312, 44, '#fff', 8, LINE) +
      T(36, 200, tpl(f.period, { day: f.today, from: '10:00', to: '12:00' }), { s: 14, max: 290 }) + ring(24, 188, 312, 44, 8) + callout(2, 346, 186) +
      T(24, 250, f.vehicle, { s: 11, f: MUTED }) + `<g transform="translate(24 268)">${chip(0, 0, M.vehicles.platePlaceholder, true).svg}</g>` +
      T(24, 324, f.total, { s: 13, w: 700 }) + skel(240, 328, 96, 12) +
      btn(24, 360, 312, 50, f.submit) + ring(24, 360, 312, 50) + callout(3, 346, 358) + T(24, 424, f.holdNote, { s: 11, f: MUTED, max: 312 }));
  },
  '10-qr: phone': (L, M) => {
    const d = M.booking.detail;
    return phone(bar(d.title) + rect(24, 96, 150, 26, '#dcf3e2', 13) + `<text x="99" y="114" font-size="12" font-weight="700" fill="${GREENTXT}" text-anchor="middle">${esc(M.booking.status.CONFIRMED)}</text>` +
      rect(60, 128, 240, 240, '#fff', 16, LINE) + qrLike(90, 158, 180) + ring(60, 128, 240, 240, 16) + callout(1, 306, 126) +
      T(24, 388, d.slot, { s: 11, f: MUTED }) + skel(24, 408, 200) + T(24, 430, d.time, { s: 11, f: MUTED }) + skel(24, 450, 160) +
      ghost(24, 490, 150, 42, d.navigate, 12) + ghost(186, 490, 150, 42, d.cancel, 13));
  },
  '11-permissions: phone': (L, M) => {
    const p = M.permissions;
    const row = (y, t, txt) => rect(24, y, 312, 136, SURF, 14, LINE) + T(40, y + 14, t, { s: 15, w: 700, max: 280 }) + T(40, y + 38, txt, { s: 12, f: MUTED, max: 280 }) + btn(40, y + 90, 120, 34, p.allow, { s: 13 });
    return phone(bar(p.title) + T(24, 96, p.subtitle, { s: 13, f: MUTED, max: 312 }) +
      row(150, p.locationTitle, p.locationText) + ring(40, 240, 120, 34) + callout(1, 168, 238) +
      row(310, p.notificationsTitle, p.notificationsText) + ring(40, 400, 120, 34) + callout(2, 168, 398) +
      ghost(24, 470, 312, 44, p.later, 14));
  },
  '12-bookings: phone': (L, M) => {
    const b = M.booking.list, tabs = M.tabs;
    const c = chips(0, 0, [b.active, b.upcoming, b.history], 0);
    return phone(bar(b.title) + `<g transform="translate(24 96)">${c.svg}</g>` +
      rect(24, 144, 312, 190, SURF, 14, LINE) + skel(40, 162, 170, 11) + skel(40, 184, 120) + rect(40, 206, 120, 24, '#dcf3e2', 12) +
      `<text x="100" y="223" font-size="11" font-weight="700" fill="${GREENTXT}" text-anchor="middle">${esc(M.booking.status.CONFIRMED)}</text>` +
      rect(220, 158, 90, 90, '#fff', 8, LINE) + qrLike(230, 168, 70) +
      ghost(40, 270, 280, 42, M.booking.detail.cancel, 14) + ring(40, 270, 280, 42) + callout(1, 330, 268) +
      rect(0, 576, 360, 56, '#fff') + rect(0, 576, 360, 1, LINE) +
      [tabs.map, tabs.bookings, tabs.profile].map((t, i) => `<text x="${60 + i * 120}" y="610" font-size="12" font-weight="${i === 1 ? 700 : 400}" fill="${i === 1 ? BLUE : MUTED}" text-anchor="middle">${esc(t)}</text>`).join(''));
  },
  '13-profile: phone': (L, M) => {
    const p = M.profile, tabs = M.tabs;
    const row = (y, label, hint) => rect(24, y, 312, 54, SURF, 12, LINE) + T(40, y + 9, label, { s: 14, w: 600, max: 250 }) + T(40, y + 31, hint, { s: 11, f: MUTED, max: 270 });
    return phone(bar(tabs.profile) +
      row(96, p.editName, 'Ali') + row(160, p.language, tpl(p.languageCurrent, { language: M.languages[L] })) + ring(24, 160, 312, 54, 12) + callout(1, 346, 158) +
      row(224, M.vehicles.title, M.vehicles.menuHint) + row(288, M.operator.join.link, M.operator.join.linkHint) + row(352, M.common.logout, '') +
      row(416, p.deleteTitle, p.deleteHint) + ring(24, 416, 312, 54, 12) + callout(2, 346, 414) +
      rect(0, 576, 360, 56, '#fff') + rect(0, 576, 360, 1, LINE) +
      [tabs.map, tabs.bookings, tabs.profile].map((t, i) => `<text x="${60 + i * 120}" y="610" font-size="12" font-weight="${i === 2 ? 700 : 400}" fill="${i === 2 ? BLUE : MUTED}" text-anchor="middle">${esc(t)}</text>`).join(''));
  },
  'crm-00-userinfo: phone': (L, M, B, C) => {
    const u = bubble(0, 110, '/start', { right: true, w: 90 });
    const b = bubble(10, 110 + u.h + 10, 'Id: 123456789', { w: 200, s: 14 });
    return phone(rect(0, 0, 360, 640, '#e9eef5') + chatHeader('userinfobot', 'bot') + u.svg + b.svg +
      ring(10, 120 + u.h, 200, b.h, 14) + callout(1, 218, 118 + u.h), '#e9eef5');
  },
  'crm-01-login: browser': (L, M, B, C) => browser(rect(170, 80, 300, 250, '#fff', 16, LINE) + mark(320, 128, 24) +
    T(320, 166, C.app.title, { s: 20, w: 700, a: 'middle' }) + T(320, 196, C.auth.subtitle, { s: 12, f: MUTED, a: 'middle', max: 250 }) +
    btn(220, 250, 200, 44, 'Telegram') + ring(220, 250, 200, 44) + callout(1, 430, 248)),
  'crm-02-add-lot: browser': (L, M, B, C) => {
    const p = C.parkings;
    return browser(T(170, 52, p.new, { s: 18, w: 700 }) +
      field(170, 90, 210, p.name, '', { h: 34 }) + field(170, 148, 210, p.owner, '123456789', { h: 34 }) + ring(170, 165, 210, 34, 8) + callout(2, 380, 160) +
      field(170, 206, 210, p.address, '', { h: 34 }) + field(170, 264, 100, p.openTime, '08:00', { h: 34 }) + field(280, 264, 100, p.closeTime, '22:00', { h: 34 }) +
      rect(396, 90, 224, 160, '#e4eee0', 10, LINE) + '<path d="M396 150L620 190M470 90L500 250" stroke="#fff" stroke-width="7" fill="none"/>' + pin(520, 190) +
      ring(396, 90, 224, 160, 10) + callout(1, 612, 94) + T(396, 258, p.mapHint, { s: 11, f: MUTED, max: 224 }) +
      btn(170, 336, 130, 38, C.common.create, { s: 13 }), crmSide(C, 0));
  },
  'crm-03-slots: browser': (L, M, B, C) => {
    const s = C.slots;
    return browser(T(170, 52, s.bulkTitle, { s: 18, w: 700 }) +
      field(170, 90, 200, s.zone, 'A', { h: 34 }) + field(390, 90, 220, s.prefix, 'A', { h: 34 }) +
      field(170, 150, 200, s.start, '1', { h: 34 }) + field(390, 150, 220, s.end, '20', { h: 34 }) + ring(170, 167, 440, 34, 8) + callout(1, 622, 164) +
      btn(170, 224, 170, 38, s.bulkSubmit, { s: 13 }) + ring(170, 224, 170, 38) + callout(2, 352, 222) +
      rect(170, 286, 440, 36, '#dcf3e2', 8) + T(184, 295, tpl(s.bulkDone, { count: 20 }), { s: 13, w: 600, f: GREENTXT, max: 410 }),
    crmSide(C, 1));
  },
  'crm-04-approve: browser': (L, M, B, C) => {
    const p = C.parkings;
    const row = (y, st, act) => rect(170, y, 440, 40, '#fff', 6, LINE) + skel(184, y + 15, 110) + `<text x="330" y="${y + 25}" font-size="12" fill="${INK}">${esc(st)}</text>` + act;
    return browser(T(170, 52, p.title, { s: 18, w: 700 }) +
      T(184, 90, p.name, { s: 11, f: MUTED }) + T(330, 90, p.status, { s: 11, f: MUTED }) +
      row(110, p.statuses.PENDING_REVIEW, btn(500, 116, 100, 28, p.approve, { s: 12 })) + ring(500, 116, 100, 28, 8) + callout(1, 610, 112) +
      row(156, p.statuses.ACTIVE, '') + row(202, p.statuses.ACTIVE, '') +
      rect(300, 252, 300, 100, '#fff', 12, LINE) + T(316, 266, C.moderation.confirm.approve, { s: 14, w: 600, max: 270 }) +
      ghost(316, 306, 110, 32, C.common.cancel, 12) + btn(436, 306, 150, 32, p.approve, { s: 12 }) + callout(2, 596, 304), crmSide(C, 0));
  },
  'crm-05-invite: browser': (L, M, B, C) => {
    const o = C.operators;
    return browser(T(170, 52, o.title, { s: 18, w: 700 }) +
      chip(170, 88, o.tabOperators, false).svg + chip(170 + chip(170, 88, o.tabOperators).w + 8, 88, o.tabInvites, true).svg +
      btn(170, 140, 220, 38, o.createInvite, { s: 13 }) + ring(170, 140, 220, 38) + callout(1, 402, 138) +
      rect(170, 200, 440, 160, '#fff', 12, LINE) + T(186, 214, o.codeTitle, { s: 14, w: 700 }) +
      T(186, 244, 'K7QF-3MZD-W4XN-P2RT-6HBY-J5', { s: 17, w: 700, f: BLUE, max: 410 }) + ring(186, 240, 300, 26, 6) + callout(2, 494, 238) +
      T(186, 282, o.codeOnce, { s: 11, f: MUTED, max: 410 }) + ghost(186, 320, 200, 28, o.codeClose, 11), crmSide(C, 4));
  },
  'crm-06-reports: browser': (L, M, B, C) => {
    const rows = [0, 1, 2, 3].map((i) => rect(170, 120 + i * 44, 440, 36, '#fff', 6, LINE) + skel(184, 135 + i * 44, 90) + skel(310, 135 + i * 44, 70) + skel(420, 135 + i * 44, 50)).join('');
    return browser(T(170, 52, C.nav.bookings, { s: 18, w: 700 }) + btn(430, 44, 180, 32, C.export.button, { s: 12 }) + ring(430, 44, 180, 32) + callout(2, 620, 42) + rows + ring(8, 174, 134, 26, 6) + callout(1, 146, 172), crmSide(C, 3));
  },
};

function crmSide(C, active) {
  const n = C.nav, keys = [n.parkings, n.zonesSlots, n.tariffs, n.bookings, n.operators, n.payments, n.refunds];
  // Reorder so highlighted index maps to a stable label list.
  return { title: C.app.title, items: keys.map((label, i) => ({ label, active: i === active })) };
}

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
