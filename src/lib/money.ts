/**
 * Money as integer cents in memory, NUMERIC(18,2) in Postgres, a decimal string
 * on the wire.
 *
 * The one thing never permitted is arithmetic on a JS number: 0.1 + 0.2 is not
 * 0.3, and an accounting system that rounds a hundredth of a cent per line
 * produces a trial balance that is out by an amount nobody can find.
 */
export type Cents = number;

const MAX = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER, in cents ≈ $90 trillion

export function parseMoney(input: unknown, field = 'amount'): Cents {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error(`${field} is not a finite number`);
    // Accept a number at the boundary but convert immediately and exactly.
    return roundCents(input * 100, field);
  }
  if (typeof input !== 'string') throw new Error(`${field} must be a number or a decimal string`);
  const s = input.trim().replace(/[$£€¥,\s]/g, '');
  if (!s) throw new Error(`${field} is empty`);
  // Parentheses are how accountants write negatives, and every export uses them.
  const negated = /^\((.*)\)$/.exec(s);
  const body = negated ? negated[1]! : s;
  if (!/^-?\d*(\.\d+)?$/.test(body) || body === '' || body === '-') {
    throw new Error(`${field} is not a valid amount`);
  }
  const neg = negated ? true : body.startsWith('-');
  const [wholeRaw, fracRaw = ''] = body.replace(/^-/, '').split('.') as [string, string?];
  const whole = wholeRaw === '' ? '0' : wholeRaw;
  // Truncate beyond two places rather than rounding: a third decimal in a money
  // field is a data error, and rounding it silently invents a cent.
  const frac = (fracRaw ?? '').padEnd(2, '0').slice(0, 2);
  const cents = Number(whole) * 100 + Number(frac);
  if (!Number.isSafeInteger(cents) || cents > MAX) throw new Error(`${field} is out of range`);
  return neg ? -cents : cents;
}

function roundCents(v: number, field: string): Cents {
  const r = Math.round(v * 1e6) / 1e6; // kill float noise before rounding to cents
  const c = Math.round(r);
  if (!Number.isSafeInteger(c)) throw new Error(`${field} is out of range`);
  return c;
}

/** Cents to the decimal string Postgres NUMERIC expects. */
export function toDecimal(cents: Cents): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}

/** Postgres NUMERIC (always a string from node-postgres) back to cents. */
export function fromDb(v: string | null | undefined): Cents {
  if (v == null) return 0;
  return parseMoney(v, 'db value');
}

export function sum(values: Cents[]): Cents {
  return values.reduce((a, b) => a + b, 0);
}
