import { useEffect, useMemo, useState } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from "recharts";
import type { ForecastPoint, ModelResult, Observation } from "../domain/types";

export interface CurveSeries {
  id: string;
  label: string;
  predictions: ForecastPoint[];
}

export interface ObservedGroup {
  id: string;
  label: string;
  observations: Observation[];
}

const COLORS: Record<ModelResult["id"], string> = {
  historical_multiplier: "#b45309",
  logarithmic: "#7c3aed",
  power: "#0369a1",
  saturation: "#0f766e",
  retention_multiplier: "#b45309", retention_logarithmic: "#7c3aed", retention_power: "#0369a1",
  retention_saturation: "#0f766e", retention_monotone_spline: "#db2777",
};

const COHORT_COLORS = ["#2563eb", "#16a34a", "#9333ea", "#db2777", "#0891b2", "#ca8a04"];
const MODEL_IDS = new Set<ModelResult["id"]>(Object.keys(COLORS) as ModelResult["id"][]);

function colorsForSeries(series: CurveSeries[]): Map<string, string> {
  let cohortIndex = 0;
  return new Map(series.map((item) => {
    if (MODEL_IDS.has(item.id as ModelResult["id"])) {
      return [item.id, COLORS[item.id as ModelResult["id"]]];
    }
    const color = COHORT_COLORS[cohortIndex % COHORT_COLORS.length] ?? "#64748b";
    cohortIndex += 1;
    return [item.id, color];
  }));
}

export default function ModelCurvesChart(props: {
  title: string;
  observed: Observation[];
  observedGroups?: ObservedGroup[];
  series: CurveSeries[];
  ensemble?: ForecastPoint[];
  target?: number;
}): JSX.Element {
  const [visible, setVisible] = useState<string[]>(props.series.map((item) => item.id));
  const [ensembleVisible, setEnsembleVisible] = useState(true);
  const seriesColors = useMemo(() => colorsForSeries(props.series), [props.series]);
  const seriesSignature = props.series.map((item) => item.id).join(",");
  useEffect(() => {
    setVisible(props.series.map((item) => item.id));
  }, [seriesSignature]);
  const rows = useMemo(() => Array.from({ length: 360 }, (_, index) => {
    const day = index + 1;
    const observed = props.observed.find((point) => point.day === day)?.value;
    const ensemble = props.ensemble?.[index];
    const row: Record<string, number | undefined> = {
      day,
      observed,
      ensemble: ensemble?.value,
      lower: ensemble?.lower,
      band: ensemble?.lower !== undefined && ensemble.upper !== undefined ? ensemble.upper - ensemble.lower : undefined,
    };
    props.series.forEach((item) => { row[`model_${item.id}`] = item.predictions[index]?.value; });
    props.observedGroups?.forEach((group) => { row[`observed_${group.id}`] = group.observations.find((point) => point.day === day)?.value; });
    return row;
  }), [props.ensemble, props.observed, props.observedGroups, props.series]);
  const hasBand = props.ensemble?.some((point) => point.lower !== undefined && point.upper !== undefined) ?? false;
  const toggle = (id: string) => setVisible((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  return (
    <section className="model-curves-chart" aria-labelledby="model-curves-chart-title">
      <div className="model-curves-chart__heading">
        <h2 id="model-curves-chart-title">{props.title}</h2>
        <div className="model-curves-chart__toggles">
          {props.ensemble && <label>
            <input type="checkbox" checked={ensembleVisible} onChange={() => setEnsembleVisible((current) => !current)} />
            <span className="model-curves-chart__color" style={{ backgroundColor: "#172554" }} aria-hidden="true" />
            多模型等权综合曲线
          </label>}
          {props.series.map((item) => (
          <label key={item.id}>
            <input type="checkbox" checked={visible.includes(item.id)} onChange={() => toggle(item.id)} />
            <span
              className="model-curves-chart__color"
              data-testid={`curve-color-${item.id}`}
              data-color={seriesColors.get(item.id)}
              style={{ backgroundColor: seriesColors.get(item.id) }}
              aria-hidden="true"
            />
            {item.label}
          </label>
          ))}
        </div>
      </div>
      <div className="model-curves-chart__canvas" data-testid="model-curves-chart">
        <ResponsiveContainer width="100%" height={360}>
          <ComposedChart data={rows} margin={{ top: 16, right: 24, bottom: 8, left: 8 }} accessibilityLayer>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="day" type="number" domain={[1, 360]} tickFormatter={(day) => `D${day}`} />
            <YAxis width={52} tickFormatter={(value) => Number(value).toFixed(2)} />
            <Tooltip labelFormatter={(day) => `D${day}`} formatter={(value) => typeof value === "number" ? value.toFixed(3) : value} />
            {props.target !== undefined && <ReferenceLine y={props.target} label={`目标 ${props.target.toFixed(3)}`} stroke="#dc2626" strokeDasharray="6 4" />}
            {ensembleVisible && hasBand && <Area type="monotone" dataKey="lower" stackId="band" stroke="none" fill="transparent" />}
            {ensembleVisible && hasBand && <Area type="monotone" dataKey="band" stackId="band" name="模型分歧范围" stroke="none" fill="#93c5fd" fillOpacity={0.28} />}
            {ensembleVisible && props.ensemble && <Line type="monotone" dataKey="ensemble" name="多模型等权综合曲线" stroke="#172554" strokeWidth={2} dot={false} />}
            {props.series.filter((item) => visible.includes(item.id)).map((item) => (
              <Line key={item.id} type="monotone" dataKey={`model_${item.id}`} name={item.label} stroke={seriesColors.get(item.id)} dot={false} strokeWidth={MODEL_IDS.has(item.id as ModelResult["id"]) ? 2 : 1.5} strokeDasharray={MODEL_IDS.has(item.id as ModelResult["id"]) && !props.ensemble ? undefined : "5 4"} />
            ))}
            {props.observedGroups?.map((group, index) => <Scatter key={group.id} dataKey={`observed_${group.id}`} name={`${group.label}真实观测`} fill={COHORT_COLORS[index % COHORT_COLORS.length]} />)}
            {!props.observedGroups && <Scatter dataKey="observed" name="真实观测" fill="#111827" />}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
