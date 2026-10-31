/** "250.000000" -> "250", "12.500" -> "12.5": display only, string-based (no float rounding). */
export function qty(value: string | null | undefined): string {
  if (value == null || value === "") return "—";
  if (!value.includes(".")) return value;
  const trimmed = value.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "-0" ? "0" : trimmed;
}
