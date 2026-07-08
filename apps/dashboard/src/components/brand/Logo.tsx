import { cn } from "@/lib/cn";

/**
 * Perennial — značka. Symbol = nekonečná smyčka (∞ / perpetuum) prorůstající
 * listem: agenti, kteří nikdy nepřestanou růst. Evergreen (emerald-teal).
 */
export function LogoMark({ className, size = 28 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="perennial-g" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2ee6a6" />
          <stop offset="1" stopColor="#5ad1ff" />
        </linearGradient>
      </defs>
      {/* nekonečná smyčka */}
      <path
        d="M16 16c-2.4-3.6-4.6-5.4-7-5.4-3.1 0-5 2.4-5 5.4s1.9 5.4 5 5.4c2.4 0 4.6-1.8 7-5.4Zm0 0c2.4 3.6 4.6 5.4 7 5.4 3.1 0 5-2.4 5-5.4s-1.9-5.4-5-5.4c-2.4 0-4.6 1.8-7 5.4Z"
        stroke="url(#perennial-g)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      {/* list / výhonek */}
      <path
        d="M16 16c1.2-2.6 1.2-5.2 0-8-1.2 2.8-1.2 5.4 0 8Z"
        fill="url(#perennial-g)"
      />
    </svg>
  );
}

export function Logo({
  className,
  markSize = 26,
  showWord = true,
}: {
  className?: string;
  markSize?: number;
  showWord?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark size={markSize} />
      {showWord && (
        <span className="text-[1.05rem] font-semibold tracking-tight text-fg">Perennial</span>
      )}
    </span>
  );
}
