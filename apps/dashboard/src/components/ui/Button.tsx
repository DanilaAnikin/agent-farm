import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "success";
type Size = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

// Jeden systém: každá fill barva má svůj -ink fg (text-white na brandu je zakázán).
// Primary konečně nese brand glow i UVNITŘ appky (ne jen na landingu).
const variants: Record<Variant, string> = {
  primary:
    "bg-[linear-gradient(180deg,var(--color-brand),var(--color-brand-strong))] text-(--color-brand-ink) elev-brand hover:brightness-105 disabled:opacity-50",
  secondary:
    "bg-(--color-surface-2) text-(--color-fg) border border-(--color-border) hover:bg-(--color-surface-3) hover:border-(--color-border-strong) disabled:opacity-50",
  ghost:
    "text-(--color-muted) hover:text-(--color-fg) hover:bg-(--color-surface-2) disabled:opacity-50",
  danger: "bg-(--color-danger) text-(--color-danger-ink) hover:brightness-105 disabled:opacity-50",
  success: "bg-(--color-ok) text-(--color-success-ink) hover:brightness-105 disabled:opacity-50",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-9 px-4 text-sm",
  lg: "h-11 px-6 text-[15px]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "primary", size = "md", loading, disabled, type = "button", children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        "ring-focus inline-flex items-center justify-center gap-2 rounded-(--radius-sm) font-medium transition-[transform,box-shadow,background,filter] duration-150 active:scale-[.98] disabled:cursor-not-allowed disabled:active:scale-100",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {loading && (
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {children}
    </button>
  );
});
