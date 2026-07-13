import { CheckCircle2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Dynamická stavová / chybová hláška u formulářů a akcí. Klíčové pro přístupnost:
 * chyby dostanou role="alert" (čtečka je oznámí okamžitě), úspěch aria-live="polite".
 * Dřív byly tyhle hlášky prosté <p> bez role → uživatel čtečky nedostal žádnou zpětnou
 * vazbu, že akce selhala/prošla. Používej všude, kde se po akci ukazuje výsledek.
 */
export function FormMessage({
  tone,
  children,
  className,
  icon = true,
}: {
  tone: "error" | "success";
  children: React.ReactNode;
  className?: string;
  icon?: boolean;
}) {
  if (!children) return null;
  const isError = tone === "error";
  return (
    <p
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      className={cn(
        "inline-flex items-center gap-1.5 text-xs",
        isError ? "text-[--color-danger]" : "text-[--color-brand]",
        className,
      )}
    >
      {icon ? (
        isError ? (
          <AlertCircle className="size-3.5 shrink-0" />
        ) : (
          <CheckCircle2 className="size-3.5 shrink-0" />
        )
      ) : null}
      {children}
    </p>
  );
}
