"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { formatDayShort, formatPercent, formatUsd, formatUsdAxis } from "@/lib/format";
import type { NamedValue } from "@/lib/admin-guards";
import { splitMinorSlices } from "@/lib/chart-slices";

export type { NamedValue };

export interface DayPoint {
  /** Klíč UTC dne „2026-09-14". */
  day: string;
  real: number;
}

const PIE_COLORS = ["#4f8cff", "#a78bfa", "#34d399", "#fbbf24", "#f87171", "#60a5fa", "#94a3b8"];

const axisStyle = { fontSize: 11, fill: "#8b95a7" };
const tooltipStyle = {
  backgroundColor: "#12151c",
  border: "1px solid #303a4a",
  borderRadius: 8,
  fontSize: 12,
  color: "#e6e9ef",
};
const osaUsd = { value: "US$", angle: -90, position: "insideLeft" as const, style: axisStyle, offset: 12 };

// Recharts Tooltip formatter: hodnota může být number | string | pole.
type ChartValue = number | string | Array<number | string>;
function usdTooltip(value: ChartValue): string {
  return formatUsd(Number(Array.isArray(value) ? value[0] : value), "precise");
}
function denTooltip(label: unknown): string {
  return formatDayShort(typeof label === "string" ? label : String(label ?? ""));
}

/**
 * Místo grafu s jedinou položkou stačí věta — koláč o jedné výseči nic neřekne.
 * `total` = celek včetně drobných položek mimo graf; bez něj je položka celek.
 */
function JedinaPolozka({ items, total }: { items: NamedValue[]; total?: number }) {
  if (items.length === 0) return <p className="text-sm text-(--color-muted)">Zatím žádná útrata.</p>;
  const podil = total && total > 0 ? Math.min(1, items[0]!.value / total) : 1;
  return (
    <p className="text-sm text-(--color-fg)">
      {podil >= 0.9995 ? "Veškerá útrata" : "Většina útraty"}: <span className="font-medium">{items[0]!.name}</span> (
      {formatPercent(podil)})
    </p>
  );
}

export function CostCharts({
  byDay,
  byProject,
  byModel,
  byPoskytovatel,
}: {
  byDay: DayPoint[];
  byProject: NamedValue[];
  byModel: NamedValue[];
  byPoskytovatel: NamedValue[];
}) {
  const projekty = byProject.slice(0, 8);
  const rozpadModelu = splitMinorSlices(byModel);
  const modely = rozpadModelu.major.slice(0, 8);

  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <CardHeader title="Útrata po dnech" description="UTC dny, přepočteno na skutečnou cenu DeepSeeku." />
        <CardBody>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={byDay} margin={{ left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#232a36" vertical={false} />
                <XAxis dataKey="day" tick={axisStyle} tickFormatter={(v: string) => formatDayShort(v)} />
                <YAxis tick={axisStyle} tickFormatter={(v: number) => formatUsdAxis(v)} label={osaUsd} />
                <Tooltip contentStyle={tooltipStyle} formatter={usdTooltip} labelFormatter={denTooltip} />
                <Bar dataKey="real" name="Útrata" fill="#4f8cff" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Podle projektu" description="Systém = plánování a hodnocení mimo projekty." />
        <CardBody>
          {projekty.length <= 1 ? (
            <JedinaPolozka items={projekty} />
          ) : (
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={projekty} layout="vertical" margin={{ bottom: 12 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#232a36" horizontal={false} />
                  <XAxis
                    type="number"
                    tick={axisStyle}
                    tickFormatter={(v: number) => formatUsdAxis(v)}
                    label={{ value: "US$", position: "insideBottomRight", style: axisStyle, offset: -8 }}
                  />
                  <YAxis type="category" dataKey="name" tick={axisStyle} width={140} />
                  <Tooltip contentStyle={tooltipStyle} formatter={usdTooltip} />
                  <Bar dataKey="value" name="Útrata" fill="#34d399" radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Podle poskytovatele" />
        <CardBody>
          {byPoskytovatel.length <= 1 ? (
            <JedinaPolozka items={byPoskytovatel} />
          ) : (
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={byPoskytovatel}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={80}
                    stroke="none"
                  >
                    {byPoskytovatel.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} formatter={usdTooltip} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardBody>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader title="Podle modelu" description="Aliasy okruhů (worker, manager…) přeložené na skutečný model." />
        <CardBody>
          {modely.length <= 1 ? (
            <JedinaPolozka items={modely} total={rozpadModelu.total} />
          ) : (
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={modely} margin={{ left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#232a36" vertical={false} />
                  <XAxis dataKey="name" tick={axisStyle} />
                  <YAxis tick={axisStyle} tickFormatter={(v: number) => formatUsdAxis(v)} label={osaUsd} />
                  <Tooltip contentStyle={tooltipStyle} formatter={usdTooltip} />
                  <Bar dataKey="value" name="Útrata" fill="#4f8cff" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          {rozpadModelu.minor.length > 0 ? (
            <p className="t-meta mt-2">
              Pod 5 % útraty, v grafu vynecháno:{" "}
              {rozpadModelu.minor.map((m) => `${m.name} ${formatUsd(m.value)}`).join(", ")}.
            </p>
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}
