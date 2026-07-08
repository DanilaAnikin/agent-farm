import type { HTMLAttributes, ReactNode, ThHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("w-full overflow-x-auto", className)}>
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return (
    <thead className="border-b border-[--color-border] text-left text-xs uppercase tracking-wide text-[--color-muted]">
      {children}
    </thead>
  );
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-[--color-border]">{children}</tbody>;
}

export function TR({ children, className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className={cn("transition-colors hover:bg-[--color-surface-2]", className)} {...props}>
      {children}
    </tr>
  );
}

export function TH({ children, className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th className={cn("whitespace-nowrap px-4 py-2.5 font-medium", className)} {...props}>
      {children}
    </th>
  );
}

export function TD({ children, className, ...props }: HTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn("px-4 py-2.5 align-middle text-[--color-fg]", className)} {...props}>
      {children}
    </td>
  );
}
