import { useMemo, useState } from "react";
import { invertAssessmentStandards, type AssessmentStandardsResult, type JointBoundaryPoint, type StandardValue } from "../forecast/assessmentStandards";
import type { ModelPackageV4 } from "../io/savedCurves";
import { parseMetric } from "../validation/normalize";

function modeLabel(mode: ModelPackageV4["sourceSnapshots"][number]["mode"] | undefined): string {
  return mode === "roi_retention" ? "ROI + 留存率" : mode === "ltv_cac" ? "LTV + CAC" : "ROI";
}

function StandardCard({ label, value, retention = false, unavailable }: { label: string; value?: StandardValue; retention?: boolean; unavailable?: string }): JSX.Element {
  const format = (number: number) => retention ? `${(number * 100).toFixed(1)}%` : number.toFixed(3);
  return <article className="assessment-standard-card"><span>{label}</span>{value ? retention
    ? <><strong>{format(value.recommended)}</strong><p>范围 {format(value.lower)}–{format(value.upper)}</p></>
    : <><p>ROI模型基准 <strong>{format(value.baseline ?? value.recommended)}</strong></p><span>最终推荐值</span><strong>{format(value.recommended)}</strong><p>误差范围 {format(value.lower)}–{format(value.upper)}</p></>
    : <><strong>无法反推</strong><p>{unavailable}</p></>}</article>;
}

function strategyLabel(strategy: JointBoundaryPoint["strategy"]): string {
  return strategy === "roi_first" ? "ROI 优先型" : strategy === "balanced" ? "均衡型（推荐）" : "留存优先型";
}
function extrapolationLabel(result: AssessmentStandardsResult): string | undefined {
  if (!result.extrapolation) return undefined;
  if (result.extrapolation === "within_history") return "历史范围内反推";
  const direction = result.extrapolation === "upward" ? "向上外推" : "向下外推";
  return `${direction}（目标为历史边界的 ${((result.extrapolationRatio ?? 1) * 100).toFixed(1)}%）`;
}

function JointBoundaryTable({ points, targetDay }: { points: JointBoundaryPoint[]; targetDay: number }): JSX.Element | null {
  if (!points.length) return null;
  return <section><h3>联合达标边界</h3><p>每行必须作为完整组合使用，不能跨方案拆分取值。</p><div className="table-scroll"><table aria-label="联合达标边界"><thead><tr><th>方案</th><th>D1 ROI</th><th>D7 ROI</th><th>次留</th><th>7留</th><th>D{targetDay} ROI保守下界</th></tr></thead><tbody>{points.map((point) => <tr key={point.strategy}><th scope="row">{strategyLabel(point.strategy)}</th><td>{point.roi1.toFixed(3)}</td><td>{point.roi7.toFixed(3)}</td><td>{(point.retention1 * 100).toFixed(1)}%</td><td>{(point.retention7 * 100).toFixed(1)}%</td><td>{point.conservativeTargetRoi.toFixed(3)}</td></tr>)}</tbody></table></div></section>;
}

export default function AssessmentStandards({ packages, onNavigateToFit }: { packages: ModelPackageV4[]; onNavigateToFit: () => void }): JSX.Element {
  const [selectedId, setSelectedId] = useState(packages[0]?.id ?? "");
  const [targetRoi, setTargetRoi] = useState("1.37");
  const [targetDay, setTargetDay] = useState("360");
  const [run, setRun] = useState<{ signature: string; result: AssessmentStandardsResult; targetDay: number }>();
  const [error, setError] = useState<string>();
  const selected = packages.find((item) => item.id === selectedId) ?? packages[0];
  const mode = selected?.sourceSnapshots[0]?.mode;
  const parsedRoi = parseMetric(targetRoi); const parsedDay = Number(targetDay);
  const valid = parsedRoi !== null && parsedRoi > 0 && Number.isInteger(parsedDay) && parsedDay >= 7 && parsedDay <= 360;
  const signature = useMemo(() => JSON.stringify({ selected: selected?.id, targetRoi, targetDay }), [selected?.id, targetDay, targetRoi]);
  const stale = !!run && run.signature !== signature;
  if (!selected) return <section className="assessment-standards empty-state"><h1>考核标准反推</h1><p>请先在“预估曲线拟合”中保存模型包。</p><button type="button" onClick={onNavigateToFit}>去拟合模型包</button></section>;

  const start = () => {
    if (!valid || parsedRoi === null) { setError("目标累计 ROI 必须大于 0，目标周期必须为 D7–D360。"); return; }
    setError(undefined);
    setRun({ signature, targetDay: parsedDay, result: invertAssessmentStandards({ modelPackage: selected, targetRoi: parsedRoi, targetDay: parsedDay }) });
  };
  const retentionUnavailable = "当前模型包不包含留存率数据，只能反推 ROI 标准。如需反推留存率，请选择 ROI + 留存率模型包。";
  return <div className="assessment-standards"><div className="workspace-title"><div><h1>考核标准反推</h1><p>根据已保存模型包反推短期 ROI 与留存考核标准。</p></div></div>
    <section className="estimate-setup"><h2>反推条件</h2><div className="assessment-controls">
      <label>选择模型包<select value={selected.id} onChange={(event) => setSelectedId(event.currentTarget.value)}>{packages.map((item) => <option key={item.id} value={item.id}>{item.name} · {modeLabel(item.sourceSnapshots[0]?.mode)}</option>)}</select></label>
      <label>目标累计 ROI<input value={targetRoi} inputMode="decimal" onChange={(event) => setTargetRoi(event.currentTarget.value)} /></label>
      <label>目标周期（天）<input value={targetDay} inputMode="numeric" onChange={(event) => setTargetDay(event.currentTarget.value)} /></label>
    </div><p>模型包模式：<strong>{modeLabel(mode)}</strong></p>
      {mode === "ltv_cac" && <p className="assessment-status">当前模型包为 LTV + CAC，暂不支持考核标准反推。</p>}
      <button className="primary" type="button" disabled={!valid || mode === "ltv_cac"} onClick={start}>开始反推</button>{error && <p role="alert">{error}</p>}
    </section>
    {run && <section className={`assessment-results ${stale ? "is-stale" : ""}`}><h2>推荐考核标准</h2>{stale && <p className="stale-notice">反推结果已过期，请重新反推</p>}
      <div className="assessment-status"><strong>数据资格：{run.result.confidence === "high" ? "高置信度" : run.result.confidence === "medium" ? "中置信度" : "低置信度"}</strong><span>有效模型 {run.result.validModelCount} 个 · 完整成熟样本 {run.result.matureSampleCount} 个</span>{run.result.status === "trial" && <span>试算结果，不建议作为正式考核标准</span>}</div>
      <div className="assessment-standard-grid"><StandardCard label="首日 ROI" value={run.result.roi1} /><StandardCard label="7 日累计 ROI" value={run.result.roi7} /><StandardCard label="次留率" value={run.result.nextDayRetention} retention unavailable={retentionUnavailable} /><StandardCard label="7留率" value={run.result.day7Retention} retention unavailable={retentionUnavailable} /></div>
      {extrapolationLabel(run.result) && <p className="assessment-status">{extrapolationLabel(run.result)}</p>}
      {run.result.conservativeTargetRoi !== undefined && <p>推荐组合对应 D{run.targetDay} ROI 保守下界：<strong>{run.result.conservativeTargetRoi.toFixed(3)}</strong></p>}
      <div className="assessment-boundaries"><JointBoundaryTable points={run.result.jointBoundary} targetDay={run.targetDay} /></div>
      {run.result.boundaryWarning && <p className="assessment-status">{run.result.boundaryWarning}</p>}
      {run.result.warnings.length > 0 && <aside className="risk-notices"><h2>提示</h2><ul>{run.result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></aside>}
    </section>}
  </div>;
}
