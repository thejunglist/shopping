/**
 * Parse a price written in pounds ("1.25", "£1.25", "2", "1,299.00") into
 * integer pence. Returns null if it is not a valid amount. Works on the digits
 * rather than multiplying a float, so 1.15 becomes 115 and never 114.99999.
 */
export function parsePence(input) {
  const text = String(input ?? '')
    .trim()
    .replace(/^£/, '')
    .replaceAll(',', '');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}
