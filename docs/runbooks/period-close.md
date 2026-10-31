# Month-end and year-end close (finance)

**Who:** accountant prepares; finance controller closes (needs `finance.period.manage`, MFA). Periods close in order.

1. Post everything for the month: goods receipts, supplier invoices, sales invoices, payroll, expenses, depreciation run (Assets › Depreciation), production order closes.
2. Bank: import statements and reconcile every account (Finance › Banking) — unmatched lines explained.
3. Finance › Accounting setup › **Period close**: the sub-ledger checks run first (stock, receivables, payables vs GL). Investigate any difference — never force a close to hide one. Close the period; postings into it are then refused.
4. GST: Finance › GST — review GSTR-1 and GSTR-3B figures for the month before filing.
5. Year-end, after the last period: **Close year** posts the profit/loss to retained earnings and opens the next year's balances. Export the trial balance (Insights › Report exports) for the auditors.

Corrections after close are made in an open period with a reversing or adjusting journal, never by reopening and editing posted entries.
