import { Children, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { splitVisible } from "@/lib/show-more";

/**
 * Seznam, který ukáže prvních `initial` položek a zbytek schová pod nativní
 * `<details>` „Zobrazit vše (N)" — bez klientského JS, funguje i v Server
 * Componentě. Potomci jsou hotové `<li key=…>`.
 */
export function ShowMore({
  children,
  initial,
  className,
  ordered = false,
}: {
  children: ReactNode;
  initial: number;
  className?: string;
  ordered?: boolean;
}) {
  const polozky = Children.toArray(children);
  const { visible, rest } = splitVisible(polozky, initial);
  const Seznam = ordered ? "ol" : "ul";
  return (
    <>
      <Seznam className={className}>{visible}</Seznam>
      {rest.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium text-(--color-brand) hover:underline">
            Zobrazit vše ({polozky.length})
          </summary>
          <Seznam className={cn("mt-3", className)}>{rest}</Seznam>
        </details>
      ) : null}
    </>
  );
}
