/** Plate problem (see lotPolicy / walkInForm) -> i18n key. Shared with the vehicle screens' texts. */
export function plateProblemKey(problem: 'empty' | 'length' | 'charset' | 'mix' | 'ascii'): string {
  switch (problem) {
    case 'empty':
      return 'operator.walkIn.plateEmpty';
    case 'length':
      return 'vehicles.validation.plateLength';
    case 'charset':
      return 'vehicles.validation.plateCharset';
    case 'mix':
      return 'vehicles.validation.plateMix';
    case 'ascii':
      return 'vehicles.validation.plateAscii';
  }
}
