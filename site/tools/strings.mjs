// Reads the REAL UI strings used by the illustrations from the app sources (read-only).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

// Minimal TS-to-JS for the plain data files in admin/src/i18n (object literals only).
function tsExports(file, names) {
  const src = read(file)
    .replace(/^import .*$/gm, '')
    .replace(/^export type .*$/gm, '')
    .replace(/export const/g, 'const')
    .replace(/ as const/g, '').replace(/: (typeof \w+|Translation) =/g, ' =');
  return new Function(`${src}\nreturn {${names.join(',')}}`)();
}

const ops = {
  ...tsExports('admin/src/i18n/ops.uz.ts', ['opsUz']),
  ...tsExports('admin/src/i18n/ops.ru.ts', ['opsRu']),
  ...tsExports('admin/src/i18n/ops.en.ts', ['opsEn']),
};
const crmSrc = read('admin/src/i18n/locales.ts')
  .replace(/^import .*$/gm, '').replace(/^export type .*$/gm, '').replace(/export const/g, 'const').replace(/: (typeof \w+|Translation) =/g, ' =')
  .replace(/^\s*\.\.\.ops(Uz|Ru|En),?$/gm, (m, c) => `  ...ops${c},`);
const crm = new Function('opsUz', 'opsRu', 'opsEn', `${crmSrc}\nreturn {uz,ru,en}`)(ops.opsUz, ops.opsRu, ops.opsEn);

export const mobile = Object.fromEntries(['uz', 'ru', 'en'].map((l) => [l, JSON.parse(read(`mobile/src/i18n/${l}.json`))]));
export { crm };

// Bot texts: parsed from messages.py (string literals per language/key).
export function botTexts() {
  const py = read('backend/apps/telegram_bot/messages.py');
  const out = {};
  for (const lang of ['uz', 'ru', 'en']) {
    const block = new RegExp(`"${lang}": \\{([\\s\\S]*?)\\n    \\},`).exec(py)[1];
    out[lang] = {};
    for (const m of block.matchAll(/"(\w+)": (\([\s\S]*?\n        \)|"[^"\n]*"|'[^'\n]*'),/g)) {
      const parts = [...m[2].matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)].map((p) => (p[1] ?? p[2]).replace(/\\n/g, '\n'));
      out[lang][m[1]] = parts.join('');
    }
  }
  return out;
}
