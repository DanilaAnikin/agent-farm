import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/cn";

const base =
  "w-full rounded-lg border border-(--color-border-strong) bg-(--color-surface-2) px-3 py-2 text-sm text-(--color-fg) placeholder:text-(--color-muted) focus:border-(--color-accent) focus:outline-none focus:ring-1 focus:ring-(--color-accent) disabled:opacity-50";

/**
 * Popisek pole. Nápověda (`hint`) je SAMOSTATNÝ prvek vpravo — dřív byla
 * vložená do téhož řádku jako inline span a na obrazovce se slila s popiskem
 * („Brand barvykaždá na řádek").
 */
export function Label({
  children,
  htmlFor,
  hint,
}: {
  children: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
}) {
  return (
    <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-(--color-muted)">
        {children}
      </label>
      {hint ? <span className="text-[11px] font-normal text-(--color-faint)">{hint}</span> : null}
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
  className,
}: {
  label?: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      {label ? (
        <Label htmlFor={htmlFor} hint={hint}>
          {label}
        </Label>
      ) : null}
      {children}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn(base, className)} {...props} />;
  },
);

/**
 * Pole na částku v US$. `type="text"` + `inputMode="decimal"`: číselné pole
 * prohlížeče v češtině odmítá čárku a na desktopu posouvá hodnotu kolečkem.
 * Parsování čárky i tečky dělá `parseDecimalInput` (lib/admin-guards).
 */
export const MoneyInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { suffix?: string; wrapperClassName?: string }
>(function MoneyInput({ className, wrapperClassName, suffix = "US$", ...props }, ref) {
  return (
    <div className={cn("relative", wrapperClassName)}>
      <input
        ref={ref}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        step={0.01}
        min={0}
        className={cn(base, "pr-11 text-right tabular-nums", className)}
        {...props}
      />
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-(--color-muted)">
        {suffix}
      </span>
    </div>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={cn(base, "min-h-24 resize-y", className)} {...props} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <select ref={ref} className={cn(base, "appearance-none", className)} {...props}>
        {children}
      </select>
    );
  },
);
