import Link from "next/link";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";

interface ChecklistItem {
  label: string;
  done: boolean;
  href: string;
}

// First-run checklist: GitHub klíč / stropy (plně autonomní provoz, bez Telegramu).
export function FirstRunChecklist({
  hasGithub,
  hasCaps,
}: {
  hasGithub: boolean;
  hasCaps: boolean;
}) {
  const items: ChecklistItem[] = [
    { label: "Připoj GitHub (PAT pro git operace)", done: hasGithub, href: "/settings" },
    { label: "Zkontroluj denní stropy útraty", done: hasCaps, href: "/costs" },
  ];
  const remaining = items.filter((i) => !i.done).length;
  if (remaining === 0) return null;

  return (
    <Card>
      <CardHeader
        title="Než začneš"
        description={`Zbývá ${remaining} ${remaining === 1 ? "krok" : "kroky"} k plnému provozu.`}
      />
      <CardBody className="space-y-2">
        {items.map((item) => (
          <Link
            key={item.label}
            href={item.href}
            className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-[--color-surface-2]"
          >
            <span
              className={
                "flex h-5 w-5 items-center justify-center rounded-full border text-xs " +
                (item.done
                  ? "border-[--color-ok] bg-[--color-ok-bg] text-[--color-ok]"
                  : "border-[--color-border-strong] text-[--color-muted]")
              }
            >
              {item.done ? "✓" : ""}
            </span>
            <span className={item.done ? "text-[--color-muted] line-through" : "text-[--color-fg]"}>
              {item.label}
            </span>
          </Link>
        ))}
      </CardBody>
    </Card>
  );
}
