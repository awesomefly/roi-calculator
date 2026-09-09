import type { Cohort, ModelResult, Observation } from "../domain/types";
import { cohortToRoi } from "../validation/normalize";
import { fitSingleCohortHistoricalMultiplier } from "./models/historicalMultiplier";
import { logarithmicModel } from "./models/logarithmic";
import { powerModel } from "./models/power";
import { saturationModel } from "./models/saturation";
import { validatePredictionSeries } from "./models/model";

export interface FitPackageSourceResult {
  source: Cohort;
  observations: Observation[];
  models: ModelResult[];
  validModelCount: number;
  evaluationMode: "single_cohort_no_backtest";
}

function predictionValue(model: ModelResult, day: number): number | undefined {
  return model.predictions.find((point) => point.day === day)?.value;
}

function completeDailySeries(model: ModelResult): ModelResult {
  if (model.status !== "ok" || model.predictions.length === 0) return model;
  const first = model.predictions[0];
  if (!first) return { ...model, status: "invalid", predictions: [], reason: "模型没有生成预测结果。" };
  const byDay = new Map(model.predictions.map((point) => [point.day, point.value]));
  let floor = Math.max(0, first.value);
  const predictions = Array.from({ length: 360 }, (_, index) => {
    const day = index + 1;
    const raw = byDay.get(day) ?? first.value;
    floor = Math.max(floor, raw);
    return { day, value: floor };
  });
  const reason = validatePredictionSeries(predictions);
  return reason ? { ...model, status: "invalid", predictions: [], reason } : { ...model, predictions };
}

function inSampleError(model: ModelResult, observations: Observation[]): number | undefined {
  if (model.status !== "ok" || observations.length === 0) return undefined;
  let sum = 0;
  for (const observed of observations) {
    const predicted = predictionValue(model, observed.day);
    if (predicted === undefined) return undefined;
    sum += Math.abs(predicted - observed.value) / Math.max(observed.value, 0.01);
  }
  return sum / observations.length;
}

function safeFit(id: ModelResult["id"], label: string, run: () => ModelResult): ModelResult {
  try {
    const result = completeDailySeries(run());
    return result.id === id ? result : { id, label, status: "invalid", predictions: [], reason: "模型返回结果不一致。" };
  } catch {
    return { id, label, status: "invalid", predictions: [], reason: "模型计算失败。" };
  }
}

export function fitModelPackageSource(cohort: Cohort): FitPackageSourceResult {
  const observations = cohortToRoi(cohort);
  const models = [
    safeFit("historical_multiplier", "历史倍率", () => fitSingleCohortHistoricalMultiplier(observations)),
    safeFit("logarithmic", "对数模型", () => logarithmicModel.fit(observations)),
    safeFit("power", "幂函数模型", () => powerModel.fit(observations)),
    safeFit("saturation", "饱和模型", () => saturationModel.fit(observations)),
  ].map((model) => {
    const fitError = inSampleError(model, observations);
    if (model.status !== "ok") return model;
    const roi360 = predictionValue(model, 360);
    const observationFits = observations.flatMap((observed) => {
      const fitted = predictionValue(model, observed.day);
      if (fitted === undefined) return [];
      return [{
        day: observed.day,
        observed: observed.value,
        fitted,
        ...(roi360 !== undefined && fitted > 0 ? { stageMultiplier: roi360 / fitted } : {}),
      }];
    });
    return {
      ...model,
      ...(fitError === undefined ? {} : { fitError }),
      observationFits,
    };
  });
  return {
    source: structuredClone(cohort),
    observations: observations.map((point) => ({ ...point })),
    models,
    validModelCount: models.filter((model) => model.status === "ok").length,
    evaluationMode: "single_cohort_no_backtest",
  };
}
