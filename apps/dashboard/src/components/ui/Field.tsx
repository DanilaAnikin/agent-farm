import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/cn";

const base =
  "w-full rounded-lg border border-[--color-border-strong] bg-[--color-surface-2] px-3 py-2 text-sm text-[--color-fg] placeholder:text-[--color-muted] focus:border-[--color-accent] focus:outline-none focus:ring-1 focus:ring-[--color-accent] disabled:opacity-50";

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
    <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-medium text-[--color-muted]">
      {children}
      {hint ? <span className="ml-1 font-normal text-[--color-faint]">{hint}</span> : null}
    </label>
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
