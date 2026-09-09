import type { Cohort, ForecastPoint, ModelObservationFit, ModelResult, Observation } from "../domain/types";
import { fitModelPackageSource } from "./fitPackage";
import { fitAggregateHistoricalMultiplier, fitHistoricalMultiplier } from "./models/historicalMultiplier";
import { equalWeightModelIds } from "./modelEligibility";
import { fitRetentionModelGroup, type RetentionFitResult } from "./retention/retentionFit";

export interface CohortModelFit {
  cohortId: string;
  cohortName: string;
  status: ModelResult["status"];
  predictions: ForecastPoint[];
  parameters?: Record<string, number>;
  fitError?: number;
  observationFits?: ModelObservationFit[];
  reason?: string;
}

export interface BacktestResidual {
  day: number;
  actual: number;
  predicted: number;
  absolutePercentageError: number;
}

export interface CohortBacktest {
  cohortId: string;
  status: "ok" | "insufficient_data" | "failed";
  residuals: BacktestResidual[];
  meanError?: number;
  reason?: string;
}

export interface AggregateModelResult extends ModelResult {
  cohortFits: CohortModelFit[];
  cohortBacktests: CohortBacktest[];
  validCohortCount: number;
  backtestCohortCount: number;
}

export interface MultiCohortFitResult {
  sources: Cohort[];
  observationsByCohort: Array<{ cohortId: string; observations: Observation[] }>;
  models: AggregateModelResult[];
  validModelCount: number;
  evaluationMode: "multi_cohort_temporal_backtest" | "single_cohort_no_backtest";
  retentionFit?: RetentionFitResult;
}

const IDS: ModelResult["id"][] = ["historical_multiplier", "logarithmic", "power", "saturation"];

export function aggregateDailyPredictions(results: ModelResult[]): ForecastPoint[] {
  const valid = results.filter((result) => result.status === "ok" && result.predictions.length === 360);
  if (valid.length === 0) return [];
  return Array.from({ length: 360 }, (_, index) => ({
    day: index + 1,
    value: valid.reduce((sum, result) => sum + (result.predictions[index]?.value ?? 0), 0) / valid.length,
  }));
}

function cohortFit(cohort: Cohort, model: ModelResult): CohortModelFit {
  return {
    cohortId: cohort.id,
    cohortName: cohort.name,
    status: model.status,
    predictions: structuredClone(model.predictions),
    ...(model.parameters ? { parameters: { ...model.parameters } } : {}),
    ...(model.fitError === undefined ? {} : { fitError: model.fitError }),
    ...(model.observationFits ? { observationFits: structuredClone(model.observationFits) } : {}),
    ...(model.reason ? { reason: model.reason } : {}),
  };
}

function temporalBacktest(cohort: Cohort, modelId: ModelResult["id"], allCohorts: Cohort[]): CohortBacktest {
  const minimum = modelId === "saturation" ? 3 : 2;
  const residuals: BacktestResidual[] = [];
  for (let index = minimum; index < cohort.observations.length; index += 1) {
    const actualSource = cohort.observations[index];
    if (!actualSource) continue;
    const prefix = { ...cohort, observations: cohort.observations.slice(0, index).map((point) => ({ ...point })) } as Cohort;
    const fitted = modelId === "historical_multiplier"
      ? fitHistoricalMultiplier(prefix, allCohorts.filter((candidate) => candidate.id !== cohort.id))
      : fitModelPackageSource(prefix).models.find((model) => model.id === modelId);
    const predicted = fitted?.status === "ok" ? fitted.predictions[actualSource.day - 1]?.value : undefined;
    const actual = cohort.mode !== "ltv_cac" ? actualSource.value : actualSource.value / (actualSource.cac ?? Number.NaN);
    if (predicted === undefined || !Number.isFinite(predicted)) continue;
    residuals.push({
      day: actualSource.day,
      actual,
      predicted,
      absolutePercentageError: Math.abs(predicted - actual) / Math.max(actual, 0.01),
    });
  }
  if (residuals.length === 0) return { cohortId: cohort.id, status: "insufficient_data", residuals: [], reason: "回测数据不足。" };
  return {
    cohortId: cohort.id,
    status: "ok",
    residuals,
    meanError: residuals.reduce((sum, point) => sum + point.absolutePercentageError, 0) / residuals.length,
  };
}

export function fitMultiCohortPackageSource(cohorts: Cohort[]): MultiCohortFitResult {
  if (cohorts.length > 0 && cohorts.every((cohort) => cohort.mode === "roi_retention")) {
    const retentionFit = fitRetentionModelGroup(cohorts);
    return {
      sources: structuredClone(cohorts),
      observationsByCohort: cohorts.map((cohort) => ({ cohortId: cohort.id, observations: structuredClone(cohort.observations) })),
      models: retentionFit.models,
      validModelCount: equalWeightModelIds(retentionFit.models, true).length,
      evaluationMode: cohorts.length > 1 ? "multi_cohort_temporal_backtest" : "single_cohort_no_backtest",
      retentionFit,
    };
  }
  const fitted = cohorts.map((cohort) => fitModelPackageSource(cohort));
  const withBacktest = cohorts.length > 1;
  const models = IDS.map((id): AggregateModelResult => {
    const perCohort = fitted.map((result) => result.models.find((model) => model.id === id)!);
    const successful = perCohort.filter((model) => model.status === "ok");
    const historicalAggregate = id === "historical_multiplier" ? fitAggregateHistoricalMultiplier(cohorts) : undefined;
    const predictions = historicalAggregate?.status === "ok"
      ? historicalAggregate.predictions
      : aggregateDailyPredictions(successful);
    const cohortBacktests = withBacktest ? cohorts.map((cohort) => temporalBacktest(cohort, id, cohorts)) : [];
    const errors = cohortBacktests.flatMap((item) => item.meanError === undefined ? [] : [item.meanError]);
    const first = perCohort[0];
    const status: ModelResult["status"] = id === "historical_multiplier"
      ? historicalAggregate?.status ?? "insufficient_data"
      : successful.length > 0 ? "ok" : perCohort.some((model) => model.status === "invalid") ? "invalid" : "insufficient_data";
    return {
      id,
      label: first?.label ?? id,
      status,
      predictions,
      cohortFits: perCohort.map((model, index) => cohortFit(cohorts[index]!, model)),
      cohortBacktests,
      validCohortCount: successful.length,
      backtestCohortCount: errors.length,
      ...(errors.length > 0 ? { backtestError: errors.reduce((sum, value) => sum + value, 0) / errors.length } : {}),
      ...(historicalAggregate?.parameters ? { parameters: historicalAggregate.parameters } : {}),
      ...(status === "ok" ? {} : { reason: historicalAggregate?.reason ?? first?.reason ?? "所有历史批次均拟合失败。" }),
    };
  });
  return {
    sources: structuredClone(cohorts),
    observationsByCohort: fitted.map((result, index) => ({ cohortId: cohorts[index]!.id, observations: structuredClone(result.observations) })),
    models,
    validModelCount: equalWeightModelIds(models, false).length,
    evaluationMode: withBacktest ? "multi_cohort_temporal_backtest" : "single_cohort_no_backtest",
  };
}
