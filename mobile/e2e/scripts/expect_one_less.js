/* eslint-disable no-var, no-undef -- Maestro (GraalJS) script: globals output/http/json/maestro and env vars are injected */
// Input: copied text like "20 / 20 free" (maestro.copiedText). Output: output.lessText = "19 / 20 free".
var match = /(\d+)\s*\/\s*(\d+)\s*free/.exec(maestro.copiedText || '');
if (!match) {
  throw new Error('no "<free> / <total> free" text was copied: ' + maestro.copiedText);
}
output.lessText = (parseInt(match[1], 10) - 1) + ' / ' + match[2] + ' free';
