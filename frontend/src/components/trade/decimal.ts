/**
 * Exact decimal arithmetic for previews (no floats). Values are BigInt scaled by 10^12.
 * Authoritative amounts always come from the API; this is only for labelled estimates and
 * quantity checks before submitting.
 */
const SCALE = 12;
const B0 = BigInt(0);
const B1 = BigInt(1);
const B2 = BigInt(2);
const B10 = BigInt(10);
const B100 = BigInt(100);
const ONE = pow10(SCALE);

function pow10(n: number): bigint {
  let out = B1;
  for (let i = 0; i < n; i++) out *= B10;
  return out;
}
const DECIMAL_RE = /^-?\d*(\.\d*)?$/;

export type Dec = bigint;

export function isDecimal(value: string): boolean {
  const v = value.trim();
  return v !== "" && v !== "-" && v !== "." && DECIMAL_RE.test(v);
}

/** Parses "12.5" into a scaled BigInt; empty or invalid input gives null. */
export function dec(value: string | null | undefined): Dec | null {
  if (value === null || value === undefined) return null;
  const v = value.trim();
  if (!isDecimal(v)) return null;
  const negative = v.startsWith("-");
  const [whole = "0", frac = ""] = (negative ? v.slice(1) : v).split(".");
  const scaled = BigInt(whole || "0") * ONE + BigInt((frac + "0".repeat(SCALE)).slice(0, SCALE) || "0");
  return negative ? -scaled : scaled;
}

/** Like dec() but treats missing values as zero. */
export function dec0(value: string | null | undefined): Dec {
  return dec(value) ?? B0;
}

function roundDiv(n: bigint, d: bigint): bigint {
  const negative = n < B0 !== d < B0;
  const a = n < B0 ? -n : n;
  const b = d < B0 ? -d : d;
  const q = (a * B2 + b) / (B2 * b); // round half up (away from zero)
  return negative ? -q : q;
}

export const add = (...values: Dec[]): Dec => values.reduce((a, b) => a + b, B0);
export const sub = (a: Dec, b: Dec): Dec => a - b;
export const mul = (a: Dec, b: Dec): Dec => roundDiv(a * b, ONE);
export const cmp = (a: Dec, b: Dec): number => (a === b ? 0 : a < b ? -1 : 1);
export const max = (a: Dec, b: Dec): Dec => (a > b ? a : b);
export const min = (a: Dec, b: Dec): Dec => (a < b ? a : b);
export const ZERO: Dec = B0;

/** value × pct / 100 */
export function percentOf(value: Dec, pct: Dec): Dec {
  return roundDiv(value * pct, B100 * ONE);
}

/** Formats with exactly `dp` decimals (rounded half up). */
export function fixed(value: Dec, dp = 2): string {
  const factor = pow10(SCALE - dp);
  const rounded = roundDiv(value, factor);
  const negative = rounded < B0;
  const abs = negative ? -rounded : rounded;
  const s = abs.toString().padStart(dp + 1, "0");
  const whole = s.slice(0, s.length - dp) || "0";
  const frac = dp > 0 ? `.${s.slice(s.length - dp)}` : "";
  return `${negative ? "-" : ""}${whole}${frac}`;
}

/** Drops trailing zeros: "12.500000" -> "12.5". Works on API decimal strings without floats. */
export function trim(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  if (!value.includes(".")) return value;
  const out = value.replace(/0+$/, "").replace(/\.$/, "");
  return out === "-0" ? "0" : out;
}

/** Scaled value back to a plain decimal string with up to `dp` decimals, trailing zeros removed. */
export function toPlain(value: Dec, dp = 6): string {
  return trim(fixed(value, dp));
}

/** Estimated taxable value of a priced line: qty × rate × (1 − discount%). */
export function lineTaxable(quantity: string, rate: string, discountPct: string): Dec | null {
  const q = dec(quantity);
  const r = dec(rate);
  if (q === null || r === null) return null;
  const gross = mul(q, r);
  return gross - percentOf(gross, dec0(discountPct));
}
