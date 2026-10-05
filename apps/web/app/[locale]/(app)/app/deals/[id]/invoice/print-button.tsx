"use client";

export function PrintButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      data-testid="invoice-print"
      className="rounded-md border border-border px-4 py-2 text-sm font-medium"
      onClick={() => window.print()}
    >
      {label}
    </button>
  );
}
