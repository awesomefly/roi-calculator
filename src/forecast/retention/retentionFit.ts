import type { ForecastPoint, ModelId, RoiRetentionCohort } from "../../domain/types";
import type { AggregateModelResult, CohortBacktest, CohortModelFit } from "../multiCohortFit";
import { predictMonotoneRetentionSpline, trainMonotoneRetentionSpline } from "./monotoneRetentionSpline";
import { predictRetentionCurve, trainRetentionModel, type RetentionParametricModelId, type TrainedRetentionModel } from "./retentionModels";

export interface RetentionSampleStats { matureCohorts: number; validSamples: number; retentionDays: number }
export type RetentionConfidenceLevel = "experimental" | "low_confidence" | "candidate";
export interface RetentionFitResult {
  models: AggregateModelResult[]; stats: RetentionSampleStats; level: RetentionConfidenceLevel;
  splineEligible: boolean; includeSplineInEnsemble: boolean; ensemblePredictions: ForecastPoint[];
}

const DEFINITIONS: Array<{ id: ModelId; label: string }> = [
  { id: "retention_multiplier", label: "留存倍率模型" },
  { id: "retention_logarithmic", label: "留存对数模型" },
  { id: "retention_power", label: "留存幂函数模型" },
  { id: "retention_saturation", label: "留存饱和模型" },
  { id: "retention_monotone_spline", label: "单调样条模型" },
];

function validRetention(point: { retention?: number }): point is { retention: number } {
  return point.retention !== undefined && Number.isFinite(point.retention) && point.retention >= 0 && point.retention <= 1;
}

function safeCurve(predictions: ForecastPoint[]): boolean {
  return predictions.length === 360 && predictions.every((point, index) => point.day === index + 1 && Number.isFinite(point.value)
    && point.value >= 0 && (index === 0 || point.value >= predictions[index - 1]!.value));
}

function aggregateCurves(curves: ForecastPoint[][]): ForecastPoint[] {
  const safe = curves.filter(safeCurve);
  return safe.length ? Array.from({ length: 360 }, (_, index) => ({
    day: index + 1, value: safe.reduce((sum, curve) => sum + curve[index]!.value, 0) / safe.length,
  })) : [];
}

function trainingError(cohorts: RoiRetentionCohort[], predictions: ForecastPoint[]): number | undefined {
  const errors = cohorts.flatMap((cohort) => cohort.observations.flatMap((point) => {
    const predicted = predictions[point.day - 1]?.value;
    return predicted === undefined ? [] : [Math.abs(predicted - point.value) / Math.max(point.value, 0.01)];
  }));
  return errors.length ? errors.reduce((sum, value) => sum + value, 0) / errors.length : undefined;
}

function fitCurve(id: ModelId, training: RoiRetentionCohort[], cohort: RoiRetentionCohort, anchors = cohort.observations): ForecastPoint[] {
  if (id === "retention_monotone_spline") {
    const trained = trainMonotoneRetentionSpline(training);
    return trained ? predictMonotoneRetentionSpline(trained, cohort, anchors) : [];
  }
  const trained = trainRetentionModel(id as RetentionParametricModelId, training);
  return trained ? predictRetentionCurve(trained, cohort, anchors) : [];
}

function backtest(cohorts: RoiRetentionCohort[], id: ModelId): { error?: number; d360Error?: number; stable: boolean; cohortBacktests: CohortBacktest[] } {
  if (cohorts.length < 2) return { stable: false, cohortBacktests: [] };
  const errors: number[] = [];
  const cohortBacktests = cohorts.map((heldOut): CohortBacktest => {
    const actual = heldOut.observations.find((point) => point.day === 360)?.value;
    const prior = heldOut.observations.filter((point) => point.day < 360);
    if (actual === undefined || actual <= 0 || !prior.length) return { cohortId: heldOut.id, status: "insufficient_data", residuals: [], reason: "缺少 D360 或更早的独立观测。" };
    const query = { ...heldOut, observations: prior };
    const curve = fitCurve(id, cohorts.filter((cohort) => cohort.id !== heldOut.id), query, prior);
    if (!safeCurve(curve)) return { cohortId: heldOut.id, status: "failed", residuals: [], reason: "留一批次曲线不安全。" };
    const predicted = curve[359]!.value;
    const error = Math.abs(predicted - actual) / Math.max(actual, 0.01);
    if (!Number.isFinite(error)) return { cohortId: heldOut.id, status: "failed", residuals: [], reason: "D360 回测误差不是有限数。" };
    errors.push(error);
    return { cohortId: heldOut.id, status: "ok", meanError: error, residuals: [{ day: 360, actual, predicted, absolutePercentageError: error }] };
  });
  const error = errors.length ? errors.reduce((sum, value) => sum + value, 0) / errors.length : undefined;
  return { ...(error === undefined ? {} : { error, d360Error: error }), stable: cohortBacktests.every((item) => item.status === "ok"), cohortBacktests };
}

function numericParameters(id: ModelId, trained: TrainedRetentionModel | undefined): Record<string, number> {
  if (id === "retention_monotone_spline" || !trained) return {};
  return {
    retentionMean: trained.retentionMean, retentionScale: trained.retentionScale, trainingSampleCount: trained.sampleCount,
    ...Object.fromEntries(trained.coefficients.map((value, index) => [`beta${index}`, value])),
    ...Object.fromEntries(trained.terminalCoefficients.map((value, index) => [`terminalBeta${index}`, value])),
  };
}

export function fitRetentionModelGroup(source: RoiRetentionCohort[]): RetentionFitResult {
  const cohorts = source.filter((cohort) => cohort.mode === "roi_retention");
  const mature = cohorts.filter((cohort) => cohort.observations.some((point) => point.day === 360 && point.value > 0));
  const samples = mature.flatMap((cohort) => cohort.observations.filter((point) => point.value > 0 && validRetention(point)));
  const stats = { matureCohorts: mature.length, validSamples: samples.length, retentionDays: new Set(samples.map((point) => point.day)).size };
  const level: RetentionConfidenceLevel = stats.matureCohorts < 3 || stats.validSamples < 6 ? "experimental"
    : stats.matureCohorts < 5 || stats.validSamples < 20 || stats.retentionDays < 3 ? "low_confidence" : "candidate";
  const parameterEligible = level === "candidate" && new Set(samples.map((point) => point.retention)).size > 1;
  const evidence = new Map(DEFINITIONS.map((definition) => [definition.id, backtest(mature, definition.id)]));

  const baseModels = DEFINITIONS.map(({ id, label }): AggregateModelResult => {
    const parametric = id === "retention_monotone_spline" ? undefined : trainRetentionModel(id as RetentionParametricModelId, mature);
    const spline = id === "retention_monotone_spline" ? trainMonotoneRetentionSpline(mature) : undefined;
    const cohortFits: CohortModelFit[] = cohorts.map((cohort) => {
      const predictions = parametric || spline ? fitCurve(id, mature, cohort) : [];
      return { cohortId: cohort.id, cohortName: cohort.name, status: safeCurve(predictions) ? "ok" : "insufficient_data", predictions };
    });
    const predictions = aggregateCurves(cohortFits.map((fit) => fit.predictions));
    const modelEvidence = evidence.get(id)!;
    const qualified = id !== "retention_monotone_spline" && parameterEligible && modelEvidence.stable && safeCurve(predictions);
    const fitError = trainingError(cohorts, predictions);
    return {
      id, label, status: safeCurve(predictions) ? "ok" : "insufficient_data", predictions, cohortFits,
      cohortBacktests: modelEvidence.cohortBacktests, validCohortCount: cohortFits.filter((fit) => fit.status === "ok").length,
      backtestCohortCount: modelEvidence.cohortBacktests.filter((item) => item.status === "ok").length,
      parameters: {
        ...numericParameters(id, parametric), ...(spline ? { trainingSampleCount: spline.sampleCount } : {}), qualified: qualified ? 1 : 0,
        qualificationLevel: level === "experimental" ? 0 : level === "low_confidence" ? 1 : 2,
        ...(modelEvidence.d360Error === undefined ? {} : { d360BacktestError: modelEvidence.d360Error }),
      },
      ...(fitError === undefined ? {} : { fitError }), ...(modelEvidence.error === undefined ? {} : { backtestError: modelEvidence.error }),
      reason: id === "retention_monotone_spline" ? "未满足单调样条模型的自动准入条件，不参与多模型等权综合曲线。"
        : qualified ? undefined : level === "experimental" ? "实验性：样本不足，不参与多模型等权综合曲线。" : "低置信度或稳定性证据不足，不参与多模型等权综合曲线。",
    };
  });

  const spline = baseModels.find((model) => model.id === "retention_monotone_spline")!;
  const splineEvidence = evidence.get("retention_monotone_spline")!;
  const splineEligible = stats.matureCohorts >= 30 && stats.validSamples >= 100 && stats.retentionDays >= 4 && parameterEligible
    && spline.status === "ok" && splineEvidence.stable && splineEvidence.cohortBacktests.length === stats.matureCohorts
    && splineEvidence.d360Error !== undefined && splineEvidence.d360Error <= 0.15 && spline.fitError !== undefined && spline.fitError <= 0.1;
  const models = baseModels.map((model) => model.id === "retention_monotone_spline" ? {
    ...model, parameters: { ...model.parameters, splineEligible: splineEligible ? 1 : 0, qualified: splineEligible ? 1 : 0 },
    reason: splineEligible ? undefined : "未满足单调样条模型的自动准入条件，不参与多模型等权综合曲线。",
  } : model);
  const members = models.filter((model) => model.parameters?.qualified === 1 && safeCurve(model.predictions));
  return { models, stats, level, splineEligible, includeSplineInEnsemble: splineEligible, ensemblePredictions: aggregateCurves(members.map((model) => model.predictions)) };
}
