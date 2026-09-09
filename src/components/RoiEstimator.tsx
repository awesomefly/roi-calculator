import { useMemo, useRef, useState } from "react";
import type { Cohort, InputMode, RoiObservation } from "../domain/types";
import { estimateWithModelPackage, type EstimateResult } from "../forecast/savedCurve";
import type { ModelPackageV4 } from "../io/savedCurves";
import { parseMetric } from "../validation/normalize";
import { parseObservationRows, type ObservationRowDraft } from "../validation/observationRows";
import ImportDialog from "./ImportDialog";
import ModelCurvesChart from "./ModelCurvesChart";
import ModelPrinciple from "./ModelPrinciple";

type EstimateRow = ObservationRowDraft;

export default function RoiEstimator({ packages, onNavigateToFit }: { packages: ModelPackageV4[]; onNavigateToFit: () => void }): JSX.Element {
  const [selectedId, setSelectedId] = useState(packages[0]?.id ?? "");
  const [rows, setRows] = useState<EstimateRow[]>([{ id: "estimate-1", day: "", value: "", cac: "", retention: "" }]);
  const [targetRoi, setTargetRoi] = useState("1.37");
  const [targetDay, setTargetDay] = useState("360");
  const [run, setRun] = useState<{ signature: string; result: EstimateResult; observations: RoiObservation[]; targetRoi: number; targetDay: number }>();
  const [error, setError] = useState<string>();
  const [importOpen, setImportOpen] = useState(false);
  const importTrigger = useRef<HTMLButtonElement>(null);
  const selected = packages.find((item) => item.id === selectedId) ?? packages[0];
  const mode: InputMode = selected?.sourceSnapshots[0]?.mode ?? "roi";
  const parsedRows = useMemo(() => parseObservationRows(rows, mode), [mode, rows]);
  const parsedTarget = parseMetric(targetRoi);
  const parsedHorizon = Number(targetDay);
  const validTarget = parsedTarget !== null && parsedTarget > 0 && Number.isInteger(parsedHorizon) && parsedHorizon >= 1 && parsedHorizon <= 360;
  const retentionPointCount = parsedRows.roiObservations.filter((point) => point.retention !== undefined).length;
  const canStart = !!selected && parsedRows.issues.length === 0 && parsedRows.roiObservations.length > 0
    && (mode !== "roi_retention" || retentionPointCount >= 2) && validTarget;
  const currentSignature = useMemo(() => JSON.stringify({ selected: selected?.id, mode, rows, targetRoi, targetDay }), [mode, rows, selected?.id, targetDay, targetRoi]);
  const stale = !!run && run.signature !== currentSignature;
  const targetEstimatePoint = run?.result.ensemble?.predictions[run.targetDay - 1];
  if (!selected) return <section className="roi-estimator empty-state" aria-labelledby="roi-estimator-title"><h1 id="roi-estimator-title">ROI 预估</h1><p>请先在“预估曲线拟合”中完成拟合并保存模型包。</p><button type="button" onClick={onNavigateToFit}>去拟合模型包</button></section>;

  const updateRow = (id: string, patch: Partial<EstimateRow>) => setRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  const selectPackage = (id: string) => {
    const next = packages.find((item) => item.id === id);
    const nextMode = next?.sourceSnapshots[0]?.mode ?? "roi";
    if (nextMode !== mode) {
      setRows([{ id: `estimate-${Date.now()}`, day: "", value: "", cac: "", retention: "" }]);
      setRun(undefined);
      setError(undefined);
    }
    setSelectedId(id);
  };
  const importCohort = (cohorts: Cohort[]) => {
    const cohort = cohorts[0];
    if (!cohort) return;
    if (cohort.mode !== mode) { setError(`当前模型包要求“${mode === "roi_retention" ? "ROI + 留存率" : mode === "ltv_cac" ? "LTV + CAC" : "ROI"}”输入，请导入相同模式的数据。`); return; }
    setRows(cohort.observations.map((point, index) => ({
      id: `estimate-import-${Date.now()}-${index}`,
      day: String(point.day),
      value: String(point.value),
      cac: cohort.mode === "ltv_cac" ? String(point.cac) : "",
      retention: cohort.mode === "roi_retention" && "retention" in point && point.retention !== undefined ? String(point.retention) : "",
    })));
    setError(undefined);
  };
  const start = () => {
    const target = parseMetric(targetRoi);
    const horizon = Number(targetDay);
    if (parsedRows.issues.length > 0 || parsedRows.roiObservations.length === 0) { setError("请先修正观测数据。"); return; }
    if (mode === "roi_retention" && retentionPointCount < 2) { setError("ROI + 留存率模式至少需要 2 个包含对应留存率的观测点。"); return; }
    if (target === null || target <= 0 || !Number.isInteger(horizon) || horizon < 1 || horizon > 360) { setError("目标 ROI 必须大于 0，目标周期必须为 D1–D360。"); return; }
    setError(undefined);
    setRun({ signature: currentSignature, observations: parsedRows.roiObservations, targetRoi: target, targetDay: horizon, result: estimateWithModelPackage({ modelPackage: selected, observations: parsedRows.roiObservations, targetRoi: target, targetDay: horizon }) });
  };

  return (
    <div className="roi-estimator">
      <div className="workspace-title"><div><h1 id="roi-estimator-title">ROI 预估</h1><p>选择完整模型包，用新批次全部真实观测综合校准。</p></div></div>
      <section className="estimate-setup" aria-labelledby="estimate-setup-title"><h2 id="estimate-setup-title">预估条件</h2>
        <div className="estimate-controls">
          <label>选择模型包<select value={selected.id} onChange={(event) => selectPackage(event.currentTarget.value)}>{packages.map((item) => <option key={item.id} value={item.id}>{item.name} · {new Date(item.createdAt).toLocaleString("zh-CN")}</option>)}</select></label>
          <label>目标 ROI<input inputMode="decimal" value={targetRoi} onChange={(event) => setTargetRoi(event.currentTarget.value)} /></label>
          <label>目标周期（天）<input inputMode="numeric" value={targetDay} onChange={(event) => setTargetDay(event.currentTarget.value)} /></label>
        </div>
        <p className="estimate-input-mode">输入模式：<strong>{mode === "roi_retention" ? "ROI + 留存率" : mode === "ltv_cac" ? "LTV + CAC" : "ROI"}</strong>（由模型包自动匹配）</p>
        <div className="table-scroll"><table aria-label="新批次观测数据"><thead><tr><th scope="col" className="observation-index">序号</th><th scope="col">天数</th><th scope="col">累计 {mode === "ltv_cac" ? "LTV" : "ROI"}</th>{mode === "roi_retention" && <th scope="col">对应留存率</th>}{mode === "ltv_cac" && <th scope="col">CAC</th>}<th scope="col">操作</th></tr></thead><tbody>{rows.map((row, index) => {
          const dayLabel = row.day.trim() || String(index + 1);
          const issues = parsedRows.issues.filter((issue) => issue.rowId === row.id);
          const dayIssue = issues.find((issue) => issue.field === "day");
          const valueIssue = issues.find((issue) => issue.field === "value");
          const cacIssue = issues.find((issue) => issue.field === "cac");
          const retentionIssue = issues.find((issue) => issue.field === "retention");
          const roiIssue = issues.find((issue) => issue.field === "roi");
          return <tr key={row.id} className={roiIssue ? "observation-row--error" : undefined} aria-invalid={roiIssue ? "true" : undefined}><th scope="row" className="observation-index">{index + 1}</th><td><label><span>观测天数</span><input aria-label={`第 ${index + 1} 行观测天数`} inputMode="numeric" value={row.day} onChange={(event) => updateRow(row.id, { day: event.currentTarget.value })} /></label>{dayIssue && <p role="alert">{dayIssue.message}</p>}</td><td><label><span>D{dayLabel} {mode === "ltv_cac" ? "LTV" : "ROI"}</span><input inputMode="decimal" value={row.value} onChange={(event) => updateRow(row.id, { value: event.currentTarget.value })} /></label>{valueIssue && <p role="alert">{valueIssue.message}</p>}</td>{mode === "roi_retention" && <td><label><span>D{dayLabel} 对应留存率</span><input inputMode="decimal" value={row.retention ?? ""} onChange={(event) => updateRow(row.id, { retention: event.currentTarget.value })} /></label>{retentionIssue && <p role="alert">{retentionIssue.message}</p>}</td>}{mode === "ltv_cac" && <td><label><span>D{dayLabel} CAC</span><input aria-label={`第 ${index + 1} 行 CAC`} inputMode="decimal" value={row.cac} onChange={(event) => updateRow(row.id, { cac: event.currentTarget.value })} /></label>{cacIssue && <p role="alert">{cacIssue.message}</p>}{roiIssue && <p className="observation-row__error" role="alert">{roiIssue.message}</p>}</td>}<td><button type="button" onClick={() => setRows((current) => current.filter((item) => item.id !== row.id))} aria-label={`删除 D${dayLabel} 观测`}>删除</button></td></tr>;
        })}</tbody></table></div>
        <div className="estimate-actions"><button ref={importTrigger} type="button" onClick={() => setImportOpen(true)}>导入 CSV</button><button type="button" onClick={() => setRows((current) => [...current, { id: `estimate-${Date.now()}-${current.length}`, day: "", value: "", cac: "", retention: "" }])}>添加观测日</button><button type="button" className="primary" onClick={start} disabled={!canStart}>开始预估</button></div>
        {mode === "roi_retention" && retentionPointCount < 2 && <p className="field-hint">至少填写 2 个观测日对应的留存率后才能开始预估。</p>}
        {error && <p role="alert">{error}</p>}
        {importOpen && <ImportDialog onImport={importCohort} onClose={() => { setImportOpen(false); importTrigger.current?.focus(); }} />}
      </section>
      {run && <section className={`estimate-results ${stale ? "is-stale" : ""}`} aria-labelledby="ensemble-title">
        {stale && <p className="stale-notice" role="status">预估结果已过期，请重新预估</p>}
        {run.result.ensemble ? <>
          <h2 id="ensemble-title">综合预估结论</h2>
          <div className="ensemble-summary"><article><span>D{run.targetDay} ROI</span><div className="ensemble-summary__roi"><strong>{run.result.ensemble.roiAtTargetDay.toFixed(3)}</strong><div className="ensemble-summary__range" title="取参与多模型等权综合曲线的有效模型在目标日预测值的最低值和最高值，不是统计置信区间。"><span>预估误差范围</span><b>{run.result.validModelCount < 2 || targetEstimatePoint?.lower === undefined || targetEstimatePoint.upper === undefined ? "暂无误差范围" : `${targetEstimatePoint.lower.toFixed(3)}–${targetEstimatePoint.upper.toFixed(3)}`}</b></div></div></article><article><span>相对目标 {run.targetRoi.toFixed(3)} 的差距</span><strong>{run.result.ensemble.targetGap >= 0 ? "+" : ""}{run.result.ensemble.targetGap.toFixed(3)}</strong></article><article><span>首次达到目标</span><strong>{run.result.ensemble.targetDay === undefined ? `D${run.targetDay} 内未达到` : `D${run.result.ensemble.targetDay}`}</strong></article><article><span>D{run.targetDay} 是否达成</span><strong>{run.result.ensemble.reachesTarget ? "达成" : "未达成"}</strong></article></div>
          <p>有效模型 {run.result.validModelCount} 个，全部参与多模型等权综合曲线并采用逐日等权平均。</p>
          <ModelCurvesChart title="多模型等权综合曲线与模型分歧范围" observed={run.observations} target={run.targetRoi} ensemble={run.result.ensemble.predictions} series={run.result.models.filter((model) => model.status === "ok").map((model) => ({ id: model.id, label: `${model.label}模型综合曲线`, predictions: model.predictions }))} />
        </> : <h2 id="ensemble-title">综合预估结论不可用</h2>}
        <section aria-labelledby="estimate-models-title"><h2 id="estimate-models-title">各模型预估结果</h2><div className="model-status-grid">{run.result.models.map((model) => <article className="model-status-card" data-status={model.status} key={model.id}><ModelPrinciple modelId={model.id} label={model.label} /><p>{model.status === "ok" ? "有效模型｜参与多模型等权综合曲线" : "非有效模型｜不参与多模型等权综合曲线"}</p>{model.roiAtTargetDay !== undefined && <p>D{run.targetDay} ROI {model.roiAtTargetDay.toFixed(3)}</p>}{model.targetDay !== undefined && <p>首次达到目标 D{model.targetDay}</p>}{model.calibration && <p>校准偏差 {(model.calibration.error * 100).toFixed(1)}%</p>}{model.reason && <p>{model.reason}</p>}</article>)}</div></section>
        {run.result.warnings.length > 0 && <aside className="risk-notices" aria-labelledby="estimate-risks-title"><h2 id="estimate-risks-title">风险与数据提示</h2><ul>{run.result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></aside>}
      </section>}
    </div>
  );
}
