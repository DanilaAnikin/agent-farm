import Link from "next/link";
import type { AnchorHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Sdílené primitivy marketingového webu (Perennial). Drží vertikální rytmus,
 * šířku obsahu a jednotný "editorial" vzhled napříč landing / pricing / features.
 */

export function Container({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mx-auto w-full max-w-6xl px-5 sm:px-8", className)} {...props} />;
}

export function Section({
  className,
  children,
  id,
}: {
  className?: string;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className={cn("relative py-20 sm:py-28", className)}>
      {children}
    </section>
  );
}

/** Malý štítek nad nadpisem sekce. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-brand",
        className,
      )}
    >
      <span className="h-1 w-1 rounded-full bg-brand" aria-hidden />
      {children}
    </span>
  );
}

/** Nadpis sekce + volitelný popis; editorial měřítko. */
export function SectionHeading({
  eyebrow,
  title,
  description,
  align = "left",
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  align?: "left" | "center";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4",
        align === "center" && "items-center text-center",
        className,
      )}
    >
      {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      <h2 className="max-w-2xl text-balance text-3xl font-semibold leading-[1.08] tracking-tight text-fg sm:text-4xl md:text-5xl">
        {title}
      </h2>
      {description ? (
        <p className={cn("max-w-xl text-base leading-relaxed text-muted sm:text-lg", align === "center" && "mx-auto")}>
          {description}
        </p>
      ) : null}
    </div>
  );
}

type CtaProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  variant?: "primary" | "secondary" | "ghost";
  size?: "md" | "lg";
  children: ReactNode;
};

const ctaVariants = {
  primary:
    "brand-gradient-bg text-accent-fg shadow-[0_10px_40px_-12px_rgba(46,230,166,0.5)] hover:brightness-105",
  secondary:
    "border border-border-strong bg-surface-2/60 text-fg hover:bg-surface-2 hover:border-brand/40",
  ghost: "text-muted hover:text-fg",
} as const;

const ctaSizes = {
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-[15px]",
} as const;

/** Odkazové CTA tlačítko (Button je <button>; tady potřebujeme <a>). */
export function CtaLink({ href, variant = "primary", size = "md", className, children, ...props }: CtaProps) {
  const isInternal = href.startsWith("/");
  const cls = cn(
    "group inline-flex select-none items-center justify-center gap-2 rounded-full font-semibold tracking-tight transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60",
    ctaVariants[variant],
    ctaSizes[size],
    className,
  );
  if (isInternal) {
    return (
      <Link href={href} className={cls} {...props}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} className={cls} {...props}>
      {children}
    </a>
  );
}

/** Šipka do CTA, s jemným posunem při hoveru. */
export function ArrowIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn("h-4 w-4 transition-transform group-hover:translate-x-0.5", className)}
      fill="none"
      aria-hidden
    >
      <path d="M3 8h9M8.5 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Jemná horizontální dělící linka se "svítícím" středem. */
export function GlowRule({ className }: { className?: string }) {
  return (
    <div
      className={cn("h-px w-full bg-gradient-to-r from-transparent via-border-strong to-transparent", className)}
      aria-hidden
    />
  );
}
