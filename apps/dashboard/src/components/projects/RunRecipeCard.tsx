import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { formatRelative } from "@/lib/format";
import { runRecipeView, stepStateLabel, type DiscoveryEvent, type StepState } from "./run-recipe";

const STEP_TONE: Record<StepState, "ok" | "warn" | "neutral"> = {
  ok: "ok",
  failed: "warn",
  skipped: "neutral",
  unknown: "neutral",
};

/**
 * „Jak farma projekt spouští" — ČTECÍ karta. Ukazuje, co si farma o projektu
 * zjistila sama: příkazy, potřebné služby, názvy proměnných a výsledek ověření
 * per krok, včetně toho, kdy a z jakého commitu.
 *
 * Schválně bez jakéhokoli formuláře a bez výzvy k zásahu — recept zjišťuje a
 * opravuje farma; člověk se sem dívá, ne aby něco vyplňoval.
 */
export function RunRecipeCard({
  envRecipe,
  lastEvent,
}: {
  envRecipe: unknown;
  lastEvent?: DiscoveryEvent | null;
}) {
  const view = runRecipeView(envRecipe, lastEvent ?? null);

  return (
    <Card>
      <CardHeader
        title="Jak farma projekt spouští"
        description="Zjištěno z repozitáře a ověřeno skutečným během."
        action={<Badge tone={view.tone}>{stateLabel(view.state)}</Badge>}
      />
      <CardBody className="space-y-3">
        <p className="text-sm text-(--color-muted)">{view.headline}</p>

        {view.steps.length > 0 ? (
          <ul className="space-y-1.5">
            {view.steps.map((step) => (
              <li key={step.key} className="flex items-start justify-between gap-3">
                <span className="min-w-0">
                  <span className="block text-xs text-(--color-muted)">{step.label}</span>
                  <code className="block truncate font-mono text-xs text-(--color-fg)" title={step.command}>
                    {step.command}
                  </code>
                </span>
                <Badge tone={STEP_TONE[step.state]} className="shrink-0">
                  {stepStateLabel(step.state)}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}

        {view.port || view.healthcheck ? (
          <p className="text-xs text-(--color-muted)">
            {view.port ? `port ${view.port}` : null}
            {view.port && view.healthcheck ? " · " : null}
            {view.healthcheck ? `kontrola na ${view.healthcheck}` : null}
          </p>
        ) : null}

        {view.services.length > 0 ? (
          <p className="text-xs text-(--color-muted)">
            Potřebné služby: {view.services.join(", ")} — v izolovaném prostředí je farma nespouští, takže kontroly, které
            je vyžadují, se přeskakují.
          </p>
        ) : null}

        {view.envNames.length > 0 ? (
          <p className="text-xs text-(--color-muted)">
            Proměnné prostředí (jen názvy, hodnoty jsou neškodné zástupné): {view.envNames.join(", ")}
          </p>
        ) : null}

        {view.notes ? <p className="text-xs text-(--color-faint)">{view.notes}</p> : null}

        {view.discoveredAt ? (
          <p className="text-[11px] text-(--color-faint)">
            Zjištěno {formatRelative(view.discoveredAt)}
            {view.commit ? ` z commitu ${view.commit.slice(0, 8)}` : ""}
            {view.attempts && view.attempts > 1 ? ` · pokusů: ${view.attempts}` : ""}
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}

function stateLabel(state: ReturnType<typeof runRecipeView>["state"]): string {
  switch (state) {
    case "discovering":
      return "zkoumá se";
    case "verified":
      return "ověřeno";
    case "failed":
      return "neověřeno";
    case "manual":
      return "ruční";
    case "missing":
      return "zatím nic";
  }
}
