import { formatDecimal, isNegative, isZero, toUnits } from "@/lib/api/finance";
import { cn } from "@/lib/utils";

/** A money figure: tabular digits, a real minus sign for negatives, never reformatted through a float. */
export function Amount({ value, currency = true, muteZero = false, className }: {
  value: string | number | null | undefined;
  currency?: boolean;
  muteZero?: boolean;
  className?: string;
}) {
  const zero = isZero(value);
  return (
    <span
      className={cn(
        "num whitespace-nowrap",
        isNegative(value) && "text-status-rejected",
        muteZero && zero && "text-muted-foreground/70",
        className,
      )}
    >
      {formatDecimal(value, { currency })}
    </span>
  );
}

/**
 * A debit-positive balance shown as an absolute figure with Dr / Cr, the way accountants read it.
 * Zero shows as a dash so the eye lands on balances that matter.
 */
export function DrCr({ value, className }: { value: string | number | null | undefined; className?: string }) {
  const units = toUnits(value);
  if (units === BigInt(0)) return <span className={cn("num text-muted-foreground/70", className)}>—</span>;
  const debit = units > BigInt(0);
  return (
    <span className={cn("num whitespace-nowrap", className)}>
      {formatDecimal(value, { sign: false })}
      <span className={cn("ml-1 inline-block w-5 text-left text-xs font-semibold", debit ? "text-foreground" : "text-status-info")}>
        {debit ? "Dr" : "Cr"}
      </span>
    </span>
  );
}

/** A number in a debit or credit column; empty when zero. */
export function Side({ value }: { value: string | number | null | undefined }) {
  if (isZero(value)) return <span className="num text-muted-foreground/50">·</span>;
  return <span className="num whitespace-nowrap">{formatDecimal(value)}</span>;
}
