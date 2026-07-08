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

export interface DayPoint {
  day: string;
  real: number;
  shadow: number;
}
export interface NamedValue {
  name: string;
  value: number;
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

function usd(v: number) {
  return `$${v.toFixed(2)}`;
}

// Recharts Tooltip formatter: hodnota může být number | string | pole.
type ChartValue = number | string | Array<number | string>;
function usdTooltip(value: ChartValue): string {
  return usd(Number(Array.isArray(value) ? value[0] : value));
}

export function CostCharts({
  byDay,
  byProject,
  byModel,
  byProvider,
}: {
  byDay: DayPoint[];
  byProject: NamedValue[];
  byModel: NamedValue[];
  byProvider: NamedValue[];
}) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <CardHeader title="Útrata po dnech" description="Reálná útrata vs. shadow (GLM paušál)." />
        <CardBody>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={byDay}>
                <CartesianGrid strokeDasharray="3 3" stroke="#232a36" vertical={false} />
                <XAxis dataKey="day" tick={axisStyle} />
                <YAxis tick={axisStyle} tickFormatter={usd} />
                <Tooltip contentStyle={tooltipStyle} formatter={usdTooltip} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="real" stackId="a" name="Reálná" fill="#4f8cff" radius={[0, 0, 0, 0]} />
                <Bar dataKey="shadow" stackId="a" name="Shadow" fill="#a78bfa" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Podle projektu" />
        <CardBody>
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={byProject} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#232a36" horizontal={false} />
                <XAxis type="number" tick={axisStyle} tickFormatter={usd} />
                <YAxis type="category" dataKey="name" tick={axisStyle} width={110} />
                <Tooltip contentStyle={tooltipStyle} formatter={usdTooltip} />
                <Bar dataKey="value" name="Útrata" fill="#34d399" radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Podle poskytovatele" />
        <CardBody>
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={byProvider} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80}>
                  {byProvider.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={tooltipStyle} formatter={usdTooltip} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </CardBody>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader title="Podle modelu" />
        <CardBody>
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={byModel}>
                <CartesianGrid strokeDasharray="3 3" stroke="#232a36" vertical={false} />
                <XAxis dataKey="name" tick={axisStyle} />
                <YAxis tick={axisStyle} tickFormatter={usd} />
                <Tooltip contentStyle={tooltipStyle} formatter={usdTooltip} />
                <Bar dataKey="value" name="Útrata" fill="#4f8cff" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
