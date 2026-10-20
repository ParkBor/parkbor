'use strict';
// WCAG AA contrast of the colour tokens in assets/site.css (both themes). `node tests/contrast.test.js` prints the table.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '../assets/site.css'), 'utf8');
const vars = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
const light = vars(/:root\s*{([^}]*)}/.exec(css)[1]);
const dark = { ...light, ...vars(/prefers-color-scheme: dark\)\s*{\s*:root\s*{([^}]*)}/.exec(css)[1]) };

const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// [text token, background token]
const PAIRS = [['fg', 'bg'], ['fg', 'surface'], ['muted', 'bg'], ['muted', 'surface'], ['link', 'bg'], ['link', 'surface'],
  ['on-primary', 'primary'], ['accent-text', 'bg'], ['accent-text', 'surface'], ['on-primary', 'primary']];

const rows = [];
for (const [name, t] of [['light', light], ['dark', dark]]) {
  for (const [a, b] of PAIRS) rows.push([name, `${a} ${t[a]} on ${b} ${t[b]}`, ratio(t[a], t[b])]);
}
// Logo: dark-blue "Park" must sit on white plate in dark mode.
rows.push(['dark', `logo plate ${dark['logo-plate']} vs brand blue #0057b5`, ratio(dark['logo-plate'], '#0057b5')]);

test('all text pairs meet WCAG AA 4.5:1', () => {
  for (const [theme, label, r] of rows) assert.ok(r >= 4.5, `${theme}: ${label} = ${r.toFixed(2)}`);
});
if (require.main === module) for (const [t, l, r] of rows) console.log(`${t}\t${r.toFixed(2)}\t${l}`);
