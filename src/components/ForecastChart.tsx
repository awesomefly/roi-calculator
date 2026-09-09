import { forwardRef, useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AnalysisResult, ModelResult, Observation } from "../domain/types";

interface ForecastChartProps {
  observed: Observation[];
  result: AnalysisResult;
  target: number;
  previewModelId?: ModelResult["id"];
}

interface ChartRow {
  day: number;
  observed?: number;
  preview?: number;
  lower?: number;
  upper?: number;
  intervalBase?: number;
  intervalBand?: number;
  contributorCount?: number;
  contributingSpend?: number;
  [key: `model_${string}`]: number | undefined;
}

function display(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(3);
}

const MODEL_COLORS: Record<ModelResult["id"], string> = {
  logarithmic: "#7c3aed",
  power: "#0369a1",
  saturation: "#0f766e",
  historical_multiplier: "#b45309",
  retention_multiplier: "#b45309", retention_logarithmic: "#7c3aed", retention_power: "#0369a1",
  retention_saturation: "#0f766e", retention_monotone_spline: "#db2777",
};

export const FORECAST_Y_AXIS_CONFIG = {
  width: 48,
  tickMargin: 6,
  tickFormatter: (value: number): string => String(Number(value.toFixed(2))),
} as const;

const ForecastChart = forwardRef<HTMLDivElement, ForecastChartProps>(function ForecastChart(props, ref): JSX.Element {
  const [showComparisons, setShowComparisons] = useState(false);
  const [showRoiReference, setShowRoiReference] = useState(false);
  const preview = props.result.models.find((model) => model.id === props.previewModelId && model.status === "ok");
  const comparisons = props.result.models.filter((model) => model.status === "ok" && model.id !== preview?.id);
  const hasInterval = preview?.predictions.some((point) => point.lower !== undefined && point.upper !== undefined) ?? false;
  const rows = useMemo(() => {
    const byDay = new Map<number, ChartRow>();
    const rowAt = (day: number): ChartRow => {
      const row = byDay.get(day) ?? { day };
      byDay.set(day, row);
      return row;
    };
    props.observed.forEach((point) => {
      const row = rowAt(point.day);
      row.observed = point.value;
      row.contributorCount = point.contributorCount;
      row.contributingSpend = point.contributingSpend;
    });
    preview?.predictions.forEach((point) => {
      const row = rowAt(point.day);
      row.preview = point.value;
      row.lower = point.lower;
      row.upper = point.upper;
      if (point.lower !== undefined && point.upper !== undefined) {
        row.intervalBase = point.lower;
        row.intervalBand = Math.max(0, point.upper - point.lower);
      }
    });
    comparisons.forEach((model) => model.predictions.forEach((point) => {
      rowAt(point.day)[`model_${model.id}`] = point.value;
    }));
    return [...byDay.values()].sort((left, right) => left.day - right.day);
  }, [comparisons, preview, props.observed]);
  const yDomainMax = Math.max(
    0,
    props.target,
    ...(showRoiReference ? [1] : []),
    ...props.observed.map((point) => point.value),
    ...(preview?.predictions.flatMap((point) => [point.value, point.lower ?? 0, point.upper ?? 0]) ?? []),
    ...(showComparisons ? comparisons.flatMap((model) => model.predictions.map((point) => point.value)) : []),
  );
  const hasContributorMetadata = props.observed.some((point) => point.contributorCount !== undefined);

  return (
    <section aria-labelledby="forecast-chart-title" className="forecast-chart">
      <div className="forecast-chart__heading">
        <div>
          <h2 id="forecast-chart-title">预测曲线</h2>
          <p>
            观测点 {props.observed.length} 个；{preview ? `当前预览${preview.label}` : "暂无可预览模型"}；
            {hasInterval ? "含下限与上限预测区间" : "预测区间不可用"}；目标线 ROI {props.target.toFixed(3)}。
          </p>
        </div>
        <div className="forecast-chart__controls">
          <label><input type="checkbox" checked={showComparisons} onChange={(event) => setShowComparisons(event.currentTarget.checked)} />显示其他可用模型</label>
          <label><input type="checkbox" checked={showRoiReference} onChange={(event) => setShowRoiReference(event.currentTarget.checked)} />显示 ROI 1.0 参考线</label>
        </div>
      </div>
      <div ref={ref} className="forecast-chart__canvas" data-testid="forecast-chart-export" data-y-domain-max={yDomainMax}>
        {preview ? (
          <ResponsiveContainer width="100%" height={360}>
            <ComposedChart data={rows} margin={{ top: 16, right: 24, bottom: 8, left: 8 }} accessibilityLayer>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="day" type="number" domain={[1, 360]} tickFormatter={(day) => `D${day}`} />
              <YAxis domain={[0, yDomainMax]} {...FORECAST_Y_AXIS_CONFIG} />
              <Tooltip labelFormatter={(day) => `D${day}`} formatter={(value) => typeof value === "number" ? value.toFixed(3) : value} />
              <ReferenceLine y={props.target} label={`目标 ${props.target.toFixed(3)}`} stroke="#dc2626" strokeDasharray="6 4" />
              {showRoiReference && <ReferenceLine y={1} label="ROI 1.0" stroke="#64748b" strokeDasharray="3 3" />}
              {hasInterval && <Area type="monotone" dataKey="intervalBase" stackId="forecast-interval" name="预测区间基线" stroke="none" fill="transparent" legendType="none" />}
              {hasInterval && <Area type="monotone" dataKey="intervalBand" stackId="forecast-interval" name="预测区间带" stroke="none" fill="#93c5fd" fillOpacity={0.3} />}
              {hasInterval && <Line type="monotone" dataKey="lower" name="预测下限" stroke="#94a3b8" dot={false} strokeDasharray="4 3" />}
              {hasInterval && <Line type="monotone" dataKey="upper" name="预测上限" stroke="#94a3b8" dot={false} strokeDasharray="4 3" />}
              {showComparisons && comparisons.map((model) => (
                <Line key={model.id} type="monotone" dataKey={`model_${model.id}`} name={model.label} stroke={MODEL_COLORS[model.id]} dot={false} strokeDasharray="5 4" />
              ))}
              <Line type="monotone" dataKey="preview" name={preview.label} stroke={MODEL_COLORS[preview.id]} strokeWidth={3} dot={false} />
              <Scatter dataKey="observed" name="观测 ROI" fill="#111827" />
            </ComposedChart>
          </ResponsiveContainer>
        ) : <p>无可用曲线。请参考模型状态和风险提示补充数据。</p>}
      </div>
      <ul className="forecast-chart__legend-summary">
        <li>观测 ROI</li>
        {preview && <li>{preview.label}预览曲线{preview.id === props.result.selectedModelId ? "（自动推荐）" : ""}</li>}
        {hasInterval && <li>半透明区域表示预测下限与上限区间带</li>}
        {showComparisons && comparisons.map((model) => <li key={model.id}>{model.label}对比曲线</li>)}
        <li>红色虚线表示当前目标 {props.target.toFixed(3)}</li>
        {showRoiReference && <li>ROI 1.0 参考线已显示</li>}
      </ul>
      <details>
        <summary>查看图表数据表</summary>
        <div className="table-scroll">
          <table aria-label="图表数据">
            <thead><tr>
              <th scope="col">日期</th><th scope="col">观测 ROI</th><th scope="col">预测 ROI</th><th scope="col">下限</th><th scope="col">上限</th>
              {hasContributorMetadata && <><th scope="col">贡献批次数</th><th scope="col">贡献成本</th></>}
              {showComparisons && comparisons.map((model) => <th scope="col" key={model.id}>{model.label} ROI</th>)}
            </tr></thead>
            <tbody>{rows.map((row) => (
              <tr key={row.day}>
                <td>D{row.day}</td><td>{display(row.observed)}</td><td>{display(row.preview)}</td><td>{display(row.lower)}</td><td>{display(row.upper)}</td>
                {hasContributorMetadata && <><td>{row.contributorCount ?? "—"}</td><td>{display(row.contributingSpend)}</td></>}
                {showComparisons && comparisons.map((model) => <td key={model.id}>{display(row[`model_${model.id}`])}</td>)}
              </tr>
            ))}</tbody>
          </table>
        </div>
      </details>
    </section>
  );
});

export default ForecastChart;
