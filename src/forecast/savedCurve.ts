import type { AnalysisResult, Observation } from "../domain/types";
import type { SavedCurve } from "../io/savedCurves";
import type { ModelPackageV4 } from "../io/savedCurves";
import type { ForecastPoint, ModelResult } from "../domain/types";
import { findTargetDay, summarizeTarget } from "./target";

export interface EstimateInput {
  modelPackage: ModelPackageV4;
  observations: Observation[];
  targetRoi: number;
  targetDay: number;
}

export interface ModelCalibration {
  scale: number;
  error: number;
  observationWeights: number[];
}

export interface EstimatedModel {
  id: ModelResult["id"];
  label: string;
  status: "ok" | "excluded";
  reason?: string;
  predictions: ForecastPoint[];
  calibration?: ModelCalibration;
  roiAtTargetDay?: number;
  targetDay?: number;
  reachesTarget: boolean;
}

export interface EnsembleEstimate {
  predictions: ForecastPoint[];
  roiAtTargetDay: number;
  targetGap: number;
  targetGapRatio: number;
  targetDay?: number;
  reachesTarget: boolean;
}

export interface EstimateResult {
  models: EstimatedModel[];
  ensemble?: EnsembleEstimate;
  validModelCount: number;
  warnings: string[];
}

function validEstimateObservations(observations: Observation[]): Observation[] {
  const sorted = observations.filter((point) => (
    Number.isInteger(point.day) && point.day >= 1 && point.day <= 360 && Number.isFinite(point.value) && point.value >= 0
    && (!("retention" in point) || point.retention === undefined || (Number.isFinite(point.retention) && point.retention >= 0 && point.retention <= 1))
  )).map((point) => ({ ...point })).sort((left, right) => left.day - right.day);
  const seen = new Set<number>();
  let previous = Number.NEGATIVE_INFINITY;
  return sorted.filter((point) => {
    if (seen.has(point.day) || point.value < previous) return false;
    seen.add(point.day);
    previous = point.value;
    return true;
  });
}

function retentionWeightedModel(
  model: ModelPackageV4["models"][number],
  modelPackage: ModelPackageV4,
  observations: Observation[],
): { model?: ModelResult; matchedCohorts: number; reason?: string } {
  const currentRetention = observations.filter((point): point is Observation & { retention: number } => (
    "retention" in point && point.retention !== undefined && Number.isFinite(point.retention)
  ));
  const sources = new Map(modelPackage.sourceSnapshots.map((cohort) => [cohort.id, cohort]));
  const candidates = model.cohortFits.flatMap((fit) => {
    const source = sources.get(fit.cohortId);
    if (!source || source.mode !== "roi_retention" || fit.status !== "ok" || fit.predictions.length !== 360
      || !source.observations.some((point) => point.day === 360)) return [];
    const historicalRetention = new Map(source.observations.flatMap((point) => (
      point.retention === undefined ? [] : [[point.day, point.retention] as const]
    )));
    const differences = currentRetention.flatMap((point) => {
      const historical = historicalRetention.get(point.day);
      return historical === undefined ? [] : [Math.abs(point.retention - historical)];
    });
    if (differences.length < 2) return [];
    const distance = differences.reduce((sum, value) => sum + value, 0) / differences.length;
    return [{ fit, weight: Math.exp(-distance / 0.05) }];
  });
  const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  if (candidates.length === 0 || !Number.isFinite(totalWeight) || totalWeight <= 0) return {
    matchedCohorts: 0,
    reason: "没有成熟历史批次与当前批次形成至少 2 个同日留存率匹配点。",
  };
  const predictions = Array.from({ length: 360 }, (_, index) => ({
    day: index + 1,
    value: candidates.reduce((sum, candidate) => sum + candidate.weight * candidate.fit.predictions[index]!.value, 0) / totalWeight,
  }));
  return {
    matchedCohorts: candidates.length,
    model: { ...model, predictions },
  };
}

function calibrate(model: ModelResult, observations: Observation[], targetRoi: number, targetHorizon: number): EstimatedModel {
  if (model.status !== "ok") return {
    id: model.id,
    label: model.label,
    status: "excluded",
    reason: model.reason ?? "模型包中该模型不可用。",
    predictions: [],
    reachesTarget: false,
  };
  const byDay = new Map(model.predictions.map((point) => [point.day, point.value]));
  const weights = observations.map((_, index) => index + 1);
  let numerator = 0;
  let divisor = 0;
  for (let index = 0; index < observations.length; index += 1) {
    const observed = observations[index];
    if (!observed) continue;
    const predicted = byDay.get(observed.day);
    if (predicted === undefined || !Number.isFinite(predicted) || predicted < 0) return {
      id: model.id, label: model.label, status: "excluded", reason: `模型在 D${observed.day} 缺少可用预测。`, predictions: [], reachesTarget: false,
    };
    const denominator = Math.max(observed.value, 0.01);
    const weight = weights[index] ?? 1;
    numerator += weight * predicted * observed.value / (denominator * denominator);
    divisor += weight * predicted * predicted / (denominator * denominator);
  }
  const scale = divisor > 0 ? numerator / divisor : Number.NaN;
  if (!Number.isFinite(scale) || scale < 0) return {
    id: model.id, label: model.label, status: "excluded", reason: "无法根据当前观测计算有限缩放系数。", predictions: [], reachesTarget: false,
  };

  const observedByDay = new Map(observations.map((point) => [point.day, point.value]));
  let floor = 0;
  const predictions = model.predictions.map((point) => {
    const exact = observedByDay.get(point.day);
    const previousObserved = [...observations].reverse().find((observation) => observation.day < point.day);
    const nextObserved = observations.find((observation) => observation.day > point.day);
    const raw = point.value * scale;
    const bounded = exact ?? Math.min(
      nextObserved?.value ?? Number.POSITIVE_INFINITY,
      Math.max(previousObserved?.value ?? 0, raw),
    );
    const value = exact ?? Math.max(floor, bounded);
    floor = value;
    return { day: point.day, value: floor };
  });
  if (predictions.length !== 360 || predictions.some((point, index) => point.day !== index + 1 || !Number.isFinite(point.value))) return {
    id: model.id, label: model.label, status: "excluded", reason: "校准后的模型曲线不完整。", predictions: [], reachesTarget: false,
  };

  let weightedError = 0;
  let totalWeight = 0;
  for (let index = 0; index < observations.length; index += 1) {
    const observed = observations[index];
    if (!observed) continue;
    const fitted = (byDay.get(observed.day) ?? 0) * scale;
    const weight = weights[index] ?? 1;
    weightedError += weight * Math.abs(fitted - observed.value) / Math.max(observed.value, 0.01);
    totalWeight += weight;
  }
  const observedCrossing = findTargetDay(observations, targetRoi, targetHorizon);
  const predictedCrossing = findTargetDay(predictions, targetRoi, targetHorizon);
  const crossing = observedCrossing ?? predictedCrossing;
  return {
    id: model.id,
    label: model.label,
    status: "ok",
    predictions,
    calibration: { scale, error: totalWeight > 0 ? weightedError / totalWeight : 0, observationWeights: weights },
    roiAtTargetDay: predictions[targetHorizon - 1]?.value,
    ...(crossing === undefined ? {} : { targetDay: crossing }),
    reachesTarget: crossing !== undefined,
  };
}

export function estimateWithModelPackage(input: EstimateInput): EstimateResult {
  const observations = validEstimateObservations(input.observations);
  if (observations.length === 0) return { models: [], validModelCount: 0, warnings: ["请至少输入一个有效的新批次观测点。"] };
  if (!Number.isFinite(input.targetRoi) || input.targetRoi <= 0 || !Number.isInteger(input.targetDay) || input.targetDay < 1 || input.targetDay > 360) {
    return { models: [], validModelCount: 0, warnings: ["目标 ROI 必须大于 0，目标周期必须为 D1 到 D360。"] };
  }
  const retentionMode = input.modelPackage.sourceSnapshots.every((cohort) => cohort.mode === "roi_retention");
  const retentionPointCount = observations.filter((point) => "retention" in point && point.retention !== undefined).length;
  if (retentionMode && retentionPointCount < 2) return {
    models: input.modelPackage.models.map((model) => ({ id: model.id, label: model.label, status: "excluded", reason: "ROI + 留存率模式至少需要 2 个有效留存率观测点。", predictions: [], reachesTarget: false })),
    validModelCount: 0,
    warnings: ["ROI + 留存率模式至少需要 2 个包含对应留存率的观测点。"],
  };
  const eligibleIds = new Set(input.modelPackage.validModelIds);
  const models = input.modelPackage.models.map((model): EstimatedModel => {
    if (!eligibleIds.has(model.id)) return { id: model.id, label: model.label, status: "excluded", reason: "该模型未进入模型包的有效模型名单，不参与多模型等权综合曲线。", predictions: [], reachesTarget: false };
    if (!retentionMode) return calibrate(model, observations, input.targetRoi, input.targetDay);
    const weighted = retentionWeightedModel(model, input.modelPackage, observations);
    if (!weighted.model) return { id: model.id, label: model.label, status: "excluded", reason: weighted.reason, predictions: [], reachesTarget: false };
    const calibrated = calibrate(weighted.model, observations, input.targetRoi, input.targetDay);
    return calibrated.status === "ok"
      ? { ...calibrated, reason: `基于 ${weighted.matchedCohorts} 个具有至少 2 个同日留存率匹配点的成熟历史批次加权校准。` }
      : calibrated;
  });
  const valid = models.filter((model): model is EstimatedModel & { status: "ok" } => model.status === "ok");
  const historical = input.modelPackage.models.find((model) => model.id === "historical_multiplier");
  const latestObservationDay = observations[observations.length - 1]?.day ?? input.targetDay;
  const baseWarnings = [
    ...(historical && historical.status !== "ok" ? [`历史倍率模型不可用：${historical.reason ?? "模型包缺少可用历史倍率曲线。"}`] : []),
    ...(input.targetDay - latestObservationDay > 180 ? [`预测跨度过长：最新真实观测为 D${latestObservationDay}，距离目标 D${input.targetDay} 超过 180 天。`] : []),
    ...(observations.length < 2 ? ["当前只有一个真实观测点，多点趋势校准证据不足。"] : []),
  ];
  if (valid.length === 0) return { models, validModelCount: 0, warnings: ["没有模型能够根据当前观测完成校准。", ...baseWarnings] };
  const predictions = Array.from({ length: 360 }, (_, index): ForecastPoint => {
    const day = index + 1;
    const values = valid.map((model) => model.predictions[index]?.value).filter((value): value is number => value !== undefined);
    return {
      day,
      value: values.reduce((sum, value) => sum + value, 0) / values.length,
      lower: Math.min(...values),
      upper: Math.max(...values),
    };
  });
  const observedCrossing = findTargetDay(observations, input.targetRoi, input.targetDay);
  const predictedCrossing = findTargetDay(predictions, input.targetRoi, input.targetDay);
  const crossing = observedCrossing ?? predictedCrossing;
  const roiAtTargetDay = predictions[input.targetDay - 1]?.value ?? Number.NaN;
  const targetGap = roiAtTargetDay - input.targetRoi;
  const targetPoint = predictions[input.targetDay - 1];
  const relativeSpread = targetPoint?.lower !== undefined && targetPoint.upper !== undefined
    ? (targetPoint.upper - targetPoint.lower) / Math.max(Math.abs(targetPoint.value), 0.01)
    : 0;
  return {
    models,
    validModelCount: valid.length,
    ensemble: {
      predictions,
      roiAtTargetDay,
      targetGap,
      targetGapRatio: targetGap / input.targetRoi,
      ...(crossing === undefined ? {} : { targetDay: crossing }),
      reachesTarget: crossing !== undefined,
    },
    warnings: [
      ...(valid.length < 2 ? ["仅一个模型参与多模型等权综合曲线，无法形成有意义的模型分歧范围。"] : []),
      ...(relativeSpread > 0.35 ? [`模型分歧较大：目标日最高与最低模型相差 ${(relativeSpread * 100).toFixed(1)}%。`] : []),
      ...baseWarnings,
    ],
  };
}

function unavailable(curve: SavedCurve, warning: string): AnalysisResult {
  return {
    subjectId: `estimate:${curve.id}`,
    models: [],
    reachesTarget: false,
    confidence: "low",
    confidenceReasons: [],
    warnings: [warning],
  };
}

export function estimateWithSavedCurve(curve: SavedCurve, observations: Observation[], target: number): AnalysisResult {
  const sorted = [...observations]
    .filter((point) => Number.isInteger(point.day) && point.day >= 1 && point.day <= 360 && Number.isFinite(point.value) && point.value >= 0)
    .sort((left, right) => left.day - right.day);
  const latest = sorted[sorted.length - 1];
  if (!latest) return unavailable(curve, "请至少输入一个有效的当前批次 ROI 观测点。");
  const anchor = curve.predictions.find((point) => point.day === latest.day)?.value;
  if (anchor === undefined || !Number.isFinite(anchor) || anchor <= 0) {
    return unavailable(curve, `已保存曲线在 D${latest.day} 缺少可用锚点，请更换观测日或拟合曲线。`);
  }

  const scale = latest.value / anchor;
  let floor = 0;
  const predictions = curve.predictions.map((point) => {
    const observed = sorted.find((item) => item.day === point.day)?.value;
    const raw = point.day <= latest.day && observed !== undefined ? observed : point.value * scale;
    floor = Math.max(floor, raw);
    return { day: point.day, value: floor };
  });
  const model = {
    id: curve.modelId,
    label: `${curve.name}（${curve.modelLabel}）`,
    status: "ok" as const,
    predictions,
    reason: `以 D${latest.day} ROI ${latest.value.toFixed(3)} 为锚点，按保存曲线缩放预测。`,
  };
  const summary = summarizeTarget(predictions, target, sorted);
  return {
    subjectId: `estimate:${curve.id}`,
    models: [model],
    selectedModelId: model.id,
    roi360: summary.roi360,
    targetGap: summary.targetGap,
    targetGapRatio: summary.targetGapRatio,
    targetDay: summary.targetDay,
    reachesTarget: summary.reachesTarget,
    confidence: curve.confidence,
    confidenceReasons: [...curve.confidenceReasons, `当前批次使用 D${latest.day} 观测值进行曲线锚定。`],
    warnings: ["本结果基于已保存拟合曲线的比例缩放，应结合后续真实 ROI 持续校验。"],
  };
}
