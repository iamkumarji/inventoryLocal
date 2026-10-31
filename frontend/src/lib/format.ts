import { formatDistanceToNowStrict, format, parseISO } from "date-fns";

const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

/** Money arrives as a decimal string; format with Indian digit grouping (lakh/crore). */
export function money(value: string | null | undefined, currency = "INR"): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (Number.isNaN(n)) return value;
  // The sign goes before the currency symbol: "-₹50,000.00", not "₹-50,000.00".
  const sign = n < 0 ? "-" : "";
  const amount = inr.format(Math.abs(n));
  return currency === "INR" ? `${sign}₹${amount}` : `${sign}${currency} ${amount}`;
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return format(parseISO(value), "d MMM yyyy, HH:mm");
}

export function date(value: string | null | undefined): string {
  if (!value) return "—";
  return format(parseISO(value), "d MMM yyyy");
}

export function ago(value: string | null | undefined): string {
  if (!value) return "—";
  return `${formatDistanceToNowStrict(parseISO(value))} ago`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}
