import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { Tone } from "@/lib/constants";

const toneClasses: Record<Tone, string> = {
  ok: "bg-[--color-ok-bg] text-[--color-ok] border-[--color-ok]/30",
  warn: "bg-[--color-warn-bg] text-[--color-warn] border-[--color-warn]/30",
  danger: "bg-[--color-danger-bg] text-[--color-danger] border-[--color-danger]/30",
  info: "bg-[--color-info-bg] text-[--color-info] border-[--color-info]/30",
  neutral: "bg-[--color-neutral-bg] text-[--color-neutral] border-[--color-border-strong]",
  violet: "bg-[--color-violet-bg] text-[--color-violet] border-[--color-violet]/30",
};

export function Badge({
  tone = "neutral",
  children,
  className,
  dot,
  pulse,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  dot?: boolean;
  /** Dýchající tečka — JEN pro živé/běžící stavy (dává „něčemu žije" význam). */
  pulse?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium tracking-wide",
        toneClasses[tone],
        className,
      )}
    >
      {dot || pulse ? (
        <span className={cn("h-1.5 w-1.5 rounded-full bg-current", pulse && "status-pulse")} />
      ) : null}
      {children}
    </span>
  );
}

// Badge řízený metadata mapou (viz lib/constants).
export function StatusBadge({
  meta,
  dot,
  pulse,
  className,
}: {
  meta: { label: string; tone: Tone };
  dot?: boolean;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <Badge tone={meta.tone} dot={dot} pulse={pulse} className={className}>
      {meta.label}
    </Badge>
  );
}
