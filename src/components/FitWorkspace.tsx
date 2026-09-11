import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Cohort, InputMode, ModelResult } from "../domain/types";
import { aggregateDailyPredictions, fitMultiCohortPackageSource, type AggregateModelResult, type MultiCohortFitResult } from "../forecast/multiCohortFit";
import { equalWeightModelIds } from "../forecast/modelEligibility";
import { createCsvBlob, createLtvTemplate, createRoiRetentionTemplate, createRoiTemplate } from "../io/csv";
import type { IncompatibleModelPackage, ModelPackageV4 } from "../io/savedCurves";
import { parseObservationRows } from "../validation/observationRows";
import CohortEditor, { cohortDraftsFrom, cohortToDraft, createEmptyCohortDraft, draftErrorKey, type CohortDraft, type DraftErrors } from "./CohortEditor";
import ImportDialog from "./ImportDialog";
import type { DownloadFile } from "./InputPanel";
import ModelCurvesChart from "./ModelCurvesChart";
import ModelPrinciple from "./ModelPrinciple";

interface PreparedDraft { cohort?: Cohort; errors: DraftErrors }

export function cohortFromDraft(draft: CohortDraft): PreparedDraft {
  const errors: DraftErrors = {};
  const name = draft.name.trim();
  if (!name) errors[draftErrorKey(draft.id, "name")] = "批次名称不能为空。";
  const parsed = parseObservationRows(draft.observations[draft.mode], draft.mode);
  for (const issue of parsed.issues) errors[draftErrorKey(draft.id, `observation:${draft.mode}:${issue.rowId}:${issue.field}`)] = issue.message;
  if (parsed.sourceObservations.length < 2) errors[draftErrorKey(draft.id, "observations")] = "至少需要两个有效观测点。";
  const cohort: Cohort | undefined = Object.keys(errors).length === 0
    ? (draft.mode === "roi_retention"
      ? { id: draft.id, name, mode: draft.mode, observations: parsed.roiObservations }
      : { id: draft.id, name, mode: draft.mode, observations: parsed.sourceObservations } as Cohort)
    : undefined;
  return { errors, ...(cohort ? { cohort } : {}) };
}

export function cohortsFromDrafts(drafts: CohortDraft[]): { cohorts?: Cohort[]; prepared: PreparedDraft[] } {
  const prepared = drafts.map(cohortFromDraft);
  const cohorts = prepared.every((item) => item.cohort) ? prepared.map((item) => item.cohort!) : undefined;
  return { prepared, ...(cohorts ? { cohorts } : {}) };
}

function signature(cohorts: Cohort[] | undefined): string { return cohorts ? JSON.stringify(cohorts) : "invalid"; }

function CohortFitDetail({ fit }: { fit: AggregateModelResult["cohortFits"][number] }): JSX.Element {
  return <div className="cohort-fit-detail">
    <strong>{fit.cohortName}</strong>
    <span>{fit.status === "ok" ? "拟合成功" : fit.reason ?? "拟合失败"}</span>
    {fit.fitError !== undefined && <span>样本内相对误差 {(fit.fitError * 100).toFixed(1)}%</span>}
    {fit.status === "ok" && fit.observationFits && fit.observationFits.length > 0 && <div className="table-scroll">
      <table aria-label={`${fit.cohortName}误差明细`}>
        <thead><tr><th scope="col">观测日</th><th scope="col">真实 ROI</th><th scope="col">拟合 ROI</th><th scope="col">绝对误差</th><th scope="col">相对误差</th></tr></thead>
        <tbody>{fit.observationFits.map((point) => {
          const absoluteError = Math.abs(point.fitted - point.observed);
          const relativeError = absoluteError / Math.max(point.observed, 0.01);
          return <tr key={point.day}><th scope="row">D{point.day}</th><td>{point.observed.toFixed(3)}</td><td>{point.fitted.toFixed(3)}</td><td>{absoluteError.toFixed(3)}</td><td>{(relativeError * 100).toFixed(1)}%</td></tr>;
        })}</tbody>
      </table>
    </div>}
  </div>;
}

function fitStateText(model: AggregateModelResult): string {
  if (model.status !== "ok") return model.status === "insufficient_data" ? "模型状态：数据不足" : "模型状态：拟合失败";
  if (model.id.startsWith("retention_")) {
    if (model.fitError === undefined || model.backtestError === undefined) return "拟合状态：验证不足，暂不判断欠拟合、恰当拟合或过拟合";
    const gap = model.backtestError - model.fitError;
    const ratio = model.backtestError / Math.max(model.fitError, 0.001);
    const state = model.fitError > 0.1 ? "欠拟合" : gap > 0.05 || ratio > 1.5 ? "过拟合" : "恰当拟合";
    const gapText = `${gap >= 0 ? "+" : ""}${(gap * 100).toFixed(1)}pp`;
    return `拟合状态：${state}｜训练误差 ${(model.fitError * 100).toFixed(1)}%｜回测误差 ${(model.backtestError * 100).toFixed(1)}%｜泛化差距 ${gapText}`;
  }
  if (model.cohortFits.length === 1 || model.backtestError === undefined) {
    return model.id === "historical_multiplier"
      ? "模型可用｜验证不足：仅有一个成熟批次，暂无泛化误差"
      : "模型可用｜验证不足：仅有一个批次，暂无泛化误差";
  }
  if (model.id === "historical_multiplier") {
    const state = model.backtestError <= 0.1 ? "恰当拟合" : "欠拟合";
    return `模型状态：${state}｜训练误差不适用｜留一批次回测误差 ${(model.backtestError * 100).toFixed(1)}%｜泛化差距不适用`;
  }
  const fitErrors = model.cohortFits.flatMap((fit) => fit.fitError === undefined ? [] : [fit.fitError]);
  if (fitErrors.length === 0) return "模型可用｜验证不足：暂无训练误差";
  const trainingError = fitErrors.reduce((sum, value) => sum + value, 0) / fitErrors.length;
  const gap = model.backtestError - trainingError;
  const ratio = model.backtestError / Math.max(trainingError, 0.001);
  const state = trainingError > 0.1 ? "欠拟合" : gap > 0.05 || ratio > 1.5 ? "过拟合" : "恰当拟合";
  const gapText = `${gap >= 0 ? "+" : ""}${(gap * 100).toFixed(1)}pp`;
  return `模型状态：${state}｜训练误差 ${(trainingError * 100).toFixed(1)}%｜回测误差 ${(model.backtestError * 100).toFixed(1)}%｜泛化差距 ${gapText}`;
}

function qualificationText(model: AggregateModelResult): string | undefined {
  if (!model.id.startsWith("retention_")) return undefined;
  if (model.status !== "ok") return "数据资格：低置信度｜不参与多模型等权综合曲线";
  const level = model.parameters?.qualificationLevel;
  if (level === 0) return "数据资格：低置信度｜不参与多模型等权综合曲线";
  if (level === 1) return "数据资格：中置信度｜不参与多模型等权综合曲线";
  if (model.id === "retention_monotone_spline") {
    if (model.parameters?.splineEligible !== 1) return "数据资格：中置信度｜不参与多模型等权综合曲线";
    return model.parameters?.qualified === 1 ? "数据资格：高置信度｜自动参与多模型等权综合曲线" : "数据资格：中置信度｜不参与多模型等权综合曲线";
  }
  return model.parameters?.qualified === 1 ? "数据资格：高置信度｜参与多模型等权综合曲线" : "数据资格：中置信度｜不参与多模型等权综合曲线";
}

function ModelStatusCard({ model, onSelect }: { model: AggregateModelResult; onSelect: () => void }): JSX.Element {
  return <article className="model-status-card" data-status={model.status}>
    <div className="model-card-select"><ModelPrinciple modelId={model.id} label={model.label} /><button type="button" onClick={onSelect} disabled={model.status !== "ok"}>查看曲线</button></div>
    <p>{model.status === "ok" ? "拟合成功" : model.status === "insufficient_data" ? "数据不足" : "拟合失败"}</p>
    {qualificationText(model) && <p className="model-qualification-state">{qualificationText(model)}</p>}
    <p className="model-fit-state">{fitStateText(model)}</p>
    <p>有效批次 {model.validCohortCount}/{model.cohortFits.length}</p>
    <p>回测覆盖 {model.backtestCohortCount}/{model.cohortFits.length}{model.backtestError === undefined ? " · 回测数据不足" : ` · 综合误差 ${(model.backtestError * 100).toFixed(1)}%`}</p>
    {model.parameters?.d360BacktestError !== undefined && <p>D360 回测误差 {(model.parameters.d360BacktestError * 100).toFixed(1)}%</p>}
    <details><summary>逐批次拟合明细</summary>{model.cohortFits.map((fit) => <CohortFitDetail key={fit.cohortId} fit={fit} />)}</details>
    {model.reason && <p>{model.reason}</p>}
  </article>;
}

export type FitChartMode = "aggregate" | ModelResult["id"];

export default function FitWorkspace(props: {
  drafts: CohortDraft[];
  packages: ModelPackageV4[];
  incompatiblePackages?: IncompatibleModelPackage[];
  onDraftsChange: (drafts: CohortDraft[]) => void;
  onSavePackage: (item: ModelPackageV4) => boolean;
  onDeletePackage: (id: string) => void;
  downloadFile: DownloadFile;
  confirmReplace?: (message: string) => boolean;
}): JSX.Element {
  const prepared = useMemo(() => cohortsFromDrafts(props.drafts), [props.drafts]);
  const globalMode = props.drafts[0]?.mode ?? "roi";
  const mixedModes = new Set(props.drafts.map((draft) => draft.mode)).size > 1;
  const currentSignature = signature(prepared.cohorts);
  const [run, setRun] = useState<{ signature: string; result: MultiCohortFitResult }>();
  const [chartMode, setChartMode] = useState<FitChartMode>("aggregate");
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string>();
  const [importOpen, setImportOpen] = useState(false);
  const [inputMessage, setInputMessage] = useState<string>();
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const guidanceId = useId();
  const guidance = useRef<HTMLDivElement>(null);
  const importTrigger = useRef<HTMLButtonElement>(null);
  const inputSection = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!guidanceOpen) return undefined;
    const closeOutside = (event: MouseEvent) => {
      if (!guidance.current?.contains(event.target as Node)) setGuidanceOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setGuidanceOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [guidanceOpen]);
  const stale = !!run && run.signature !== currentSignature;
  const changeGlobalMode = (mode: InputMode) => {
    setInputMessage(undefined);
    props.onDraftsChange(props.drafts.map((draft) => ({ ...draft, mode })));
  };
  const updateDraft = (index: number, draft: CohortDraft) => props.onDraftsChange(props.drafts.map((item, itemIndex) => itemIndex === index ? draft : item));
  const startFit = () => {
    if (!prepared.cohorts) { setMessage("请先修正全部历史批次数据。"); return; }
    setRun({ signature: currentSignature, result: fitMultiCohortPackageSource(prepared.cohorts) });
    setChartMode("aggregate");
    setMessage(undefined);
  };
  const save = () => {
    if (!run || stale || run.result.validModelCount < 1 || !name.trim()) return;
    const item: ModelPackageV4 = {
      version: 4,
      id: `package-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      name: name.trim(), createdAt: new Date().toISOString(),
      sourceSnapshots: structuredClone(run.result.sources),
      roiObservationsByCohort: structuredClone(run.result.observationsByCohort),
      models: structuredClone(run.result.models),
      validModelIds: equalWeightModelIds(run.result.models, run.result.sources.every((source) => source.mode === "roi_retention")),
      evaluationMode: run.result.evaluationMode,
      ensembleRule: "equal_valid_models", cohortWeightRule: "equal_valid_cohorts",
      ...(run.result.retentionFit ? { retentionFit: structuredClone(run.result.retentionFit) } : {}),
    };
    setMessage(props.onSavePackage(item) ? `已保存模型包“${item.name}”。` : "模型包保存失败。");
  };
  const viewPackage = (item: ModelPackageV4) => {
    props.onDraftsChange(item.sourceSnapshots.map(cohortToDraft));
    setRun({ signature: signature(item.sourceSnapshots), result: {
      sources: structuredClone(item.sourceSnapshots), observationsByCohort: structuredClone(item.roiObservationsByCohort),
      models: structuredClone(item.models), validModelCount: item.validModelIds.length, evaluationMode: item.evaluationMode,
      ...(item.retentionFit ? { retentionFit: structuredClone(item.retentionFit) } : {}),
    } });
    setChartMode("aggregate"); setName(item.name); setMessage(`已加载模型包“${item.name}”。`);
    inputSection.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };
  const observed = run?.result.observationsByCohort.flatMap((entry) => entry.observations) ?? [];
  const observedGroups = run?.result.observationsByCohort.map((entry) => ({ id: entry.cohortId, label: run.result.sources.find((source) => source.id === entry.cohortId)?.name ?? entry.cohortId, observations: entry.observations })) ?? [];
  const visibleModels = run?.result.models.filter((model) => model.status === "ok" && (chartMode === "aggregate" || model.id === chartMode)) ?? [];
  const series = chartMode === "aggregate"
    ? visibleModels.map((model) => ({ id: model.id, label: `${model.label}批次综合曲线`, predictions: model.predictions }))
    : visibleModels.flatMap((model) => [{ id: `${model.id}-aggregate`, label: `${model.label}批次综合曲线`, predictions: model.predictions }, ...model.cohortFits.filter((fit) => fit.status === "ok").map((fit) => ({ id: `${model.id}-${fit.cohortId}`, label: `${fit.cohortName}拟合曲线`, predictions: fit.predictions }))]);
  const ensemble = useMemo(() => {
    if (!run) return undefined;
    const retentionMode = run.result.sources.every((source) => source.mode === "roi_retention");
    const eligibleIds = new Set(equalWeightModelIds(run.result.models, retentionMode));
    return aggregateDailyPredictions(run.result.models.filter((model) => eligibleIds.has(model.id)));
  }, [run]);

  return <div className="fit-workspace">
    <section ref={inputSection} className="fit-input" aria-labelledby="fit-input-title">
      <div className="section-heading"><div>
        <div className="fit-guidance" ref={guidance}>
          <div className="fit-guidance__title">
            <h2 id="fit-input-title">历史批次数据</h2>
            <button type="button" className="model-help__trigger" aria-label="查看历史数据量建议" aria-expanded={guidanceOpen} aria-controls={guidanceId} onClick={() => setGuidanceOpen((current) => !current)}>?</button>
          </div>
          {guidanceOpen && <div id={guidanceId} className="model-help__panel fit-guidance__panel" role="region" aria-label="历史数据量建议">
            <p><strong>ROI：</strong>建议至少 5 批，每批至少 6 条观测，尽量包含 D360。</p>
            <p><strong>ROI + 留存率：</strong>建议至少 5 个成熟批次，合计至少 20 条有效观测；留存率至少覆盖 3 个不同观测日（如 D1、D7、D30）。若要启用单调样条模型，建议 30 批、100 条观测，并覆盖 4 个不同留存观测日。</p>
            <p><strong>LTV + CAC：</strong>建议至少 5 批，每批至少 6 条观测；每条需同时填写 LTV 和 CAC。</p>
            <p>以上为稳定拟合建议，不作为输入阻断条件。</p>
          </div>}
        </div>
        <p>输入一个或多个历史批次，所有批次校验通过后可联合拟合。</p>
      </div><div className="input-panel__tools"><button ref={importTrigger} type="button" onClick={() => setImportOpen(true)}>导入 CSV</button><button type="button" onClick={() => props.downloadFile(createCsvBlob(createRoiTemplate()), "roi-import-template.csv")}>下载 ROI 模板</button><button type="button" onClick={() => props.downloadFile(createCsvBlob(createRoiRetentionTemplate()), "roi-retention-import-template.csv")}>下载 ROI + 留存率模板</button><button type="button" onClick={() => props.downloadFile(createCsvBlob(createLtvTemplate()), "ltv-cac-import-template.csv")}>下载 LTV + CAC 模板</button></div></div>
      <fieldset className="fit-global-mode"><legend>输入模式</legend>
        <label><input type="radio" name="fit-global-mode" checked={globalMode === "roi" && !mixedModes} onChange={() => changeGlobalMode("roi")} />ROI</label>
        <label><input type="radio" name="fit-global-mode" checked={globalMode === "roi_retention" && !mixedModes} onChange={() => changeGlobalMode("roi_retention")} />ROI + 留存率</label>
        <label><input type="radio" name="fit-global-mode" checked={globalMode === "ltv_cac" && !mixedModes} onChange={() => changeGlobalMode("ltv_cac")} />LTV + CAC</label>
      </fieldset>
      {mixedModes && <p role="alert">旧数据包含多种输入模式，请在上方选择一种统一模式后再拟合。</p>}
      {inputMessage && <p role="alert">{inputMessage}</p>}
      {props.drafts.map((draft, index) => <CohortEditor key={draft.id} draft={draft} sequence={index + 1} errors={prepared.prepared[index]?.errors ?? {}} canRemove={props.drafts.length > 1} onChange={(next) => updateDraft(index, next)} onRemove={() => props.onDraftsChange(props.drafts.filter((_, itemIndex) => itemIndex !== index))} />)}
      <div className="cohort-list-actions"><button type="button" onClick={() => props.onDraftsChange([...props.drafts, { ...createEmptyCohortDraft(props.drafts.length + 1, props.drafts.map((draft) => draft.id)), mode: globalMode }])}>添加批次</button></div>
      <div className="primary-run"><button type="button" onClick={startFit} disabled={!prepared.cohorts || mixedModes}>开始拟合</button></div>
      {importOpen && <ImportDialog onImport={(cohorts) => {
        const modes = new Set(cohorts.map((cohort) => cohort.mode));
        if (modes.size !== 1) { setInputMessage("同一次拟合只能使用一种输入模式，CSV 中存在混合模式。"); setImportOpen(false); importTrigger.current?.focus(); return; }
        if ((props.confirmReplace ?? window.confirm)("导入将覆盖当前未保存的历史批次数据，是否继续？")) { props.onDraftsChange(cohortDraftsFrom(cohorts)); setInputMessage(undefined); }
        setImportOpen(false); importTrigger.current?.focus();
      }} onClose={() => { setImportOpen(false); importTrigger.current?.focus(); }} />}
    </section>
    {run && <section className={`fit-results ${stale ? "is-stale" : ""}`} aria-labelledby="fit-results-title">
      <div className="section-heading"><div><h2 id="fit-results-title">拟合结果</h2><p>有效模型 {run.result.validModelCount} 个（参与多模型等权综合曲线），其他模型 {run.result.models.length - run.result.validModelCount} 个；历史批次等权。</p></div></div>
      {stale && <p className="stale-notice" role="status">拟合结果已过期，请重新拟合</p>}
      <fieldset className="fit-chart-modes"><legend>曲线视图</legend><label><input type="radio" checked={chartMode === "aggregate"} onChange={() => setChartMode("aggregate")} />批次综合曲线</label>{run.result.models.map((model) => <label key={model.id}><input type="radio" checked={chartMode === model.id} disabled={model.status !== "ok"} onChange={() => setChartMode(model.id)} />{model.label}</label>)}</fieldset>
      {run.result.retentionFit && <aside className="retention-fit-summary" aria-label="留存模型样本与资格">
        <p>成熟批次 {run.result.retentionFit.stats.matureCohorts}；有效留存样本 {run.result.retentionFit.stats.validSamples}；留存日覆盖 {run.result.retentionFit.stats.retentionDays} 种。</p>
        <p>参数模型置信度：{run.result.retentionFit.level === "experimental" ? "低" : run.result.retentionFit.level === "low_confidence" ? "中" : "高"}。</p>
        <p>{run.result.retentionFit.splineEligible
          ? "单调样条模型已通过自动准入条件并参与多模型等权综合曲线。"
          : "单调样条模型未通过自动准入条件，不参与多模型等权综合曲线。"}</p>
        <p>留存率与长期 ROI 的统计关联不代表因果关系。</p>
      </aside>}
      <ModelCurvesChart title="多模型拟合曲线" observed={observed} observedGroups={observedGroups} series={series} ensemble={ensemble} />
      <section className="model-status-section" aria-labelledby="fit-model-status-title"><h2 id="fit-model-status-title">模型状态与拟合对比</h2><div className="model-status-grid">{run.result.models.map((model) => <ModelStatusCard key={model.id} model={model} onSelect={() => setChartMode(model.id)} />)}</div></section>
      <section className="package-save" aria-labelledby="package-save-title"><h2 id="package-save-title">保存完整模型包</h2><div className="package-save__form"><label>模型包名称<input value={name} onChange={(event) => setName(event.currentTarget.value)} /></label><button type="button" onClick={save} disabled={stale || run.result.validModelCount < 1 || !name.trim()}>保存模型包</button></div>{message && <p role="status">{message}</p>}</section>
    </section>}
    <section className="package-library" aria-labelledby="package-library-title"><h2 id="package-library-title">已保存模型包</h2>{props.packages.length === 0 && !(props.incompatiblePackages?.length) ? <p>尚未保存模型包。</p> : <ul>{props.packages.map((item) => <li key={item.id}><div><strong>{item.name}</strong><span>{new Date(item.createdAt).toLocaleString("zh-CN")} · {item.sourceSnapshots.length} 个批次 · {item.validModelIds.length} 个有效模型（参与多模型等权综合曲线）</span></div><div className="package-library__actions"><button type="button" onClick={() => viewPackage(item)} aria-label={`查看模型包 ${item.name}`}>查看</button><button type="button" onClick={() => props.onDeletePackage(item.id)} aria-label={`删除模型包 ${item.name} ${item.createdAt}`}>删除</button></div></li>)}{props.incompatiblePackages?.map((item) => <li key={item.id}><div><strong>{item.name}</strong><span>{item.reason}</span></div><div className="package-library__actions"><button type="button" disabled aria-label={`查看模型包 ${item.name}`}>查看</button><button type="button" onClick={() => props.onDeletePackage(item.id)} aria-label={`删除模型包 ${item.name} ${item.createdAt}`}>删除</button></div></li>)}</ul>}</section>
  </div>;
}
