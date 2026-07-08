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
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        toneClasses[tone],
        className,
      )}
    >
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

// Badge řízený metadata mapou (viz lib/constants).
export function StatusBadge({
  meta,
  dot,
  className,
}: {
  meta: { label: string; tone: Tone };
  dot?: boolean;
  className?: string;
}) {
  return (
    <Badge tone={meta.tone} dot={dot} className={className}>
      {meta.label}
    </Badge>
  );
}
