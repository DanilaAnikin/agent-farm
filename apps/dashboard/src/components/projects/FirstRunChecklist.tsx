import Link from "next/link";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { plural } from "@/lib/plural";

interface ChecklistItem {
  label: string;
  done: boolean;
  href: string;
}

const KROK = ["krok", "kroky", "kroků"] as const;

/**
 * Úvodní kontrola před prvním během farmy.
 *
 * - GitHub: orchestrátor má přístup z prostředí, ne nutně přes připojení v UI.
 *   Hotovo je tedy aktivní připojení NEBO `farm_settings.github_status.ok`.
 * - Stropy: hlídá se strop FARMY (denní i měsíční > 0), ne osobní strop profilu.
 * - Jakmile farma jednou dokončila úkol, karta nemá co říct a zmizí úplně.
 */
export function FirstRunChecklist({
  hasGithub,
  hasCaps,
  farmHasRun,
}: {
  hasGithub: boolean;
  hasCaps: boolean;
  farmHasRun: boolean;
}) {
  if (farmHasRun) return null;
  const items: ChecklistItem[] = [
    { label: "GitHub je dostupný pro git operace farmy", done: hasGithub, href: "/settings" },
    { label: "Denní i měsíční strop farmy je nastavený", done: hasCaps, href: "/costs" },
  ];
  const remaining = items.filter((i) => !i.done).length;
  if (remaining === 0) return null;

  return (
    <Card>
      <CardHeader
        title="Než farma poprvé naběhne"
        description={`Zbývá ${remaining} ${plural(remaining, KROK)} k plnému provozu.`}
      />
      <CardBody className="space-y-2">
        {items.map((item) => (
          <Link
            key={item.label}
            href={item.href}
            className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-(--color-surface-2)"
          >
            <span
              className={
                "flex h-5 w-5 items-center justify-center rounded-full border text-xs " +
                (item.done
                  ? "border-(--color-ok) bg-(--color-ok-bg) text-(--color-ok)"
                  : "border-(--color-border-strong) text-(--color-muted)")
              }
            >
              {item.done ? "✓" : ""}
            </span>
            <span className={item.done ? "text-(--color-muted) line-through" : "text-(--color-fg)"}>
              {item.label}
            </span>
          </Link>
        ))}
      </CardBody>
    </Card>
  );
}
