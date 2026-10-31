/**
 * Quantities and money arrive as decimal strings (up to 6 places). Arithmetic in the UI is done on
 * scaled BigInts so we never lose precision to floating point; display formatting is string-based.
 */

const SCALE = 6;
const FACTOR = BigInt(10) ** BigInt(SCALE);
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/** True when `value` is a plain decimal number with at most `places` fractional digits. */
export function isDecimal(value: string, places = SCALE): boolean {
  const v = value.trim();
  if (!DECIMAL_RE.test(v)) return false;
  const fraction = v.split(".")[1] ?? "";
  return fraction.length <= places;
}

/** Parses a decimal string into micro-units. Throws on malformed input; check with isDecimal first. */
export function toMicro(value: string | null | undefined): bigint {
  const v = (value ?? "0").trim() || "0";
  if (!DECIMAL_RE.test(v)) throw new Error(`Not a decimal: ${v}`);
  const negative = v.startsWith("-");
  const [whole, fraction = ""] = (negative ? v.slice(1) : v).split(".");
  const micro = BigInt(whole) * FACTOR + BigInt((fraction + "000000").slice(0, SCALE));
  return negative ? -micro : micro;
}

/** Formats micro-units back into a normalised decimal string ("12.5", "-3", "0.000125"). */
export function fromMicro(micro: bigint): string {
  const negative = micro < BigInt(0);
  const abs = negative ? -micro : micro;
  const whole = abs / FACTOR;
  const fraction = (abs % FACTOR).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export const dec = {
  add: (a: string, b: string) => fromMicro(toMicro(a) + toMicro(b)),
  sub: (a: string, b: string) => fromMicro(toMicro(a) - toMicro(b)),
  cmp: (a: string, b: string) => {
    const d = toMicro(a) - toMicro(b);
    return d === BigInt(0) ? 0 : d > BigInt(0) ? 1 : -1;
  },
  isZero: (a: string) => toMicro(a) === BigInt(0),
  isNegative: (a: string) => toMicro(a) < BigInt(0),
  abs: (a: string) => {
    const m = toMicro(a);
    return fromMicro(m < BigInt(0) ? -m : m);
  },
  normalize: (a: string) => fromMicro(toMicro(a)),
};

function groupIndian(whole: string): string {
  if (whole.length <= 3) return whole;
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${rest},${last3}`;
}

/** Display a quantity: trailing zeros trimmed, Indian digit grouping. Never parses to a float. */
export function qty(value: string | null | undefined, uom?: string): string {
  if (value === null || value === undefined || value === "") return "—";
  if (!DECIMAL_RE.test(value.trim())) return value;
  const normal = fromMicro(toMicro(value));
  const negative = normal.startsWith("-");
  const [whole, fraction] = (negative ? normal.slice(1) : normal).split(".");
  const text = `${negative ? "−" : ""}${groupIndian(whole)}${fraction ? `.${fraction}` : ""}`;
  return uom ? `${text} ${uom}` : text;
}

/** A signed quantity with an explicit plus for increases (ledger and variance columns). */
export function signedQty(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const text = qty(value);
  return DECIMAL_RE.test(value.trim()) && toMicro(value) > BigInt(0) ? `+${text}` : text;
}
