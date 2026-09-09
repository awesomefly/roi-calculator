import type { ForecastPoint, ModelId, RoiObservation, RoiRetentionCohort } from "../../domain/types";
import { anchorMonotoneCurve, predictLinear, retentionAtDay, ridgeRegression, safeLogit } from "./retentionMath";

export type RetentionParametricModelId = Extract<ModelId,
  "retention_multiplier" | "retention_logarithmic" | "retention_power" | "retention_saturation">;

export interface TrainedRetentionModel {
  id: RetentionParametricModelId;
  coefficients: number[];
  retentionMean: number;
  retentionScale: number;
  sampleCount: number;
  retentionProfile: Array<{ day: number; logit: number }>;
  terminalCoefficients: number[];
  terminalSamples: Array<{ day: number; retentionLogit: number; logMultiplier: number }>;
}

interface TrainingSample { day: number; roi: number; roi360: number; retentionLogit: number }

function matureSamples(cohorts: RoiRetentionCohort[]): TrainingSample[] {
  return cohorts.flatMap((cohort) => {
    const roi360 = cohort.observations.find((point) => point.day === 360)?.value;
    if (roi360 === undefined || !Number.isFinite(roi360) || roi360 <= 0) return [];
    return cohort.observations.flatMap((point) => (
      point.day >= 1 && point.day <= 360 && point.value > 0 && point.retention !== undefined
      && Number.isFinite(point.retention) && point.retention >= 0 && point.retention <= 1
        ? [{ day: point.day, roi: point.value, roi360, retentionLogit: safeLogit(point.retention) }]
        : []
    ));
  });
}

function retentionStats(samples: TrainingSample[]): { mean: number; scale: number } {
  const mean = samples.reduce((sum, sample) => sum + sample.retentionLogit, 0) / Math.max(1, samples.length);
  const variance = samples.reduce((sum, sample) => sum + (sample.retentionLogit - mean) ** 2, 0) / Math.max(1, samples.length);
  return { mean, scale: Math.max(Math.sqrt(variance), 0.1) };
}

function retentionProfile(samples: TrainingSample[]): Array<{ day: number; logit: number }> {
  const byDay = new Map<number, number[]>();
  for (const sample of samples) {
    const values = byDay.get(sample.day) ?? [];
    values.push(sample.retentionLogit);
    byDay.set(sample.day, values);
  }
  return [...byDay].map(([day, values]) => ({ day, logit: values.reduce((sum, value) => sum + value, 0) / values.length }))
    .sort((left, right) => left.day - right.day);
}

function profileLogit(profile: TrainedRetentionModel["retentionProfile"], day: number): number {
  if (!profile.length) return 0;
  if (day <= profile[0]!.day) return profile[0]!.logit;
  if (day >= profile[profile.length - 1]!.day) return profile[profile.length - 1]!.logit;
  const rightIndex = profile.findIndex((point) => point.day > day);
  const left = profile[rightIndex - 1]!;
  const right = profile[rightIndex]!;
  const progress = (Math.log(day) - Math.log(left.day)) / (Math.log(right.day) - Math.log(left.day));
  return left.logit + progress * (right.logit - left.logit);
}

function projectedRetention(model: TrainedRetentionModel, observations: RoiObservation[], day: number): number {
  const known = observations.filter((point) => point.retention !== undefined && Number.isFinite(point.retention)).sort((left, right) => left.day - right.day);
  if (!known.length) return 0.5;
  const last = known[known.length - 1]!;
  if (day <= last.day) return retentionAtDay(observations, day);
  const offset = safeLogit(last.retention!) - profileLogit(model.retentionProfile, last.day);
  const projectedLogit = profileLogit(model.retentionProfile, day) + offset;
  return 1 / (1 + Math.exp(-projectedLogit));
}

function zValue(retention: number, model: Pick<TrainedRetentionModel, "retentionMean" | "retentionScale">): number {
  return (safeLogit(retention) - model.retentionMean) / model.retentionScale;
}

function parametricFeatures(id: RetentionParametricModelId, day: number, z: number): number[] {
  if (id === "retention_multiplier") {
    const time = Math.log(360 / Math.max(1, day));
    return [1, time, z, time * z];
  }
  const time = id === "retention_logarithmic" ? Math.log(day + 1) : Math.log(Math.max(1, day));
  return [1, time, z, time * z];
}

function trainSaturation(samples: TrainingSample[], mean: number, scale: number): number[] | undefined {
  let best: { coefficients: number[]; error: number } | undefined;
  for (let rateStep = 0; rateStep <= 12; rateStep += 1) for (let effectStep = 0; effectStep <= 8; effectStep += 1) {
    const logRate = -6 + rateStep * 5 / 12;
    const rateEffect = -1.5 + effectStep * 3 / 8;
    const features: number[][] = [];
    const targets: number[] = [];
    for (const sample of samples) {
      const z = (sample.retentionLogit - mean) / scale;
      const progress = -Math.expm1(-Math.exp(logRate + rateEffect * z) * sample.day);
      if (!Number.isFinite(progress) || progress <= 1e-8) continue;
      features.push([1, z]);
      targets.push(Math.log(sample.roi / progress));
    }
    const ceiling = ridgeRegression(features, targets, 0.02);
    if (!ceiling) continue;
    const error = samples.reduce((sum, sample) => {
      const z = (sample.retentionLogit - mean) / scale;
      const predicted = Math.exp(predictLinear(ceiling, [1, z])) * -Math.expm1(-Math.exp(logRate + rateEffect * z) * sample.day);
      return sum + (Math.log(Math.max(predicted, 1e-6)) - Math.log(sample.roi)) ** 2;
    }, 0);
    if (Number.isFinite(error) && (!best || error < best.error)) best = { coefficients: [...ceiling, logRate, rateEffect], error };
  }
  return best?.coefficients;
}

export function trainRetentionModel(id: RetentionParametricModelId, cohorts: RoiRetentionCohort[]): TrainedRetentionModel | undefined {
  const samples = matureSamples(cohorts);
  if (samples.length < 4) return undefined;
  const { mean, scale } = retentionStats(samples);
  const profile = retentionProfile(samples);
  const terminalSamples = samples.filter((sample) => sample.day < 360);
  const terminalCoefficients = ridgeRegression(
    terminalSamples.map((sample) => parametricFeatures("retention_multiplier", sample.day, (sample.retentionLogit - mean) / scale)),
    terminalSamples.map((sample) => Math.log(sample.roi360 / sample.roi)),
    0.02,
  );
  if (!terminalCoefficients) return undefined;
  if (id === "retention_saturation") {
    const coefficients = trainSaturation(samples, mean, scale);
    return coefficients ? {
      id, coefficients, retentionMean: mean, retentionScale: scale, sampleCount: samples.length, retentionProfile: profile, terminalCoefficients,
      terminalSamples: terminalSamples.map((sample) => ({ day: sample.day, retentionLogit: sample.retentionLogit, logMultiplier: Math.log(sample.roi360 / sample.roi) })),
    } : undefined;
  }
  const features = samples.map((sample) => parametricFeatures(id, sample.day, (sample.retentionLogit - mean) / scale));
  const targets = samples.map((sample) => id === "retention_multiplier"
    ? Math.log(sample.roi360 / sample.roi)
    : id === "retention_power" ? Math.log(sample.roi) : sample.roi);
  const coefficients = ridgeRegression(features, targets, 0.02);
  return coefficients ? {
    id, coefficients, retentionMean: mean, retentionScale: scale, sampleCount: samples.length, retentionProfile: profile, terminalCoefficients,
    terminalSamples: terminalSamples.map((sample) => ({ day: sample.day, retentionLogit: sample.retentionLogit, logMultiplier: Math.log(sample.roi360 / sample.roi) })),
  } : undefined;
}

export function predictRetentionCurve(model: TrainedRetentionModel, cohort: Pick<RoiRetentionCohort, "observations">, anchors = cohort.observations): ForecastPoint[] {
  const latest = [...cohort.observations].filter((point) => point.day < 360 && point.value > 0).sort((left, right) => left.day - right.day).pop()
    ?? [...cohort.observations].filter((point) => point.value > 0).sort((left, right) => left.day - right.day)[0];
  if (!latest) return [];
  const latestZ = zValue(retentionAtDay(cohort.observations, latest.day), model);
  const latestRetentionLogit = safeLogit(retentionAtDay(cohort.observations, latest.day));
  const sameDaySamples = model.terminalSamples.filter((sample) => sample.day === latest.day);
  const terminalCandidates = sameDaySamples.length >= 3 ? sameDaySamples : model.terminalSamples;
  const weightedTerminal = terminalCandidates.map((sample) => {
    const dayDistance = Math.log(latest.day / sample.day);
    const retentionDistance = (latestRetentionLogit - sample.retentionLogit) / model.retentionScale;
    return { value: sample.logMultiplier, weight: Math.exp(-0.5 * dayDistance ** 2 - 0.5 * retentionDistance ** 2) };
  });
  const totalWeight = weightedTerminal.reduce((sum, item) => sum + item.weight, 0);
  const regressionMultiplier = predictLinear(model.terminalCoefficients, parametricFeatures("retention_multiplier", latest.day, latestZ));
  const logMultiplier = totalWeight > 1e-9
    ? weightedTerminal.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight
    : regressionMultiplier;
  const terminal = Math.max(latest.value, latest.value * Math.exp(logMultiplier));
  const multiplierAt360 = model.id === "retention_multiplier"
    ? Math.exp(predictLinear(model.coefficients, parametricFeatures(model.id, 360, zValue(projectedRetention(model, cohort.observations, 360), model))))
    : 1;
  const saturationRate = model.id === "retention_saturation" ? Math.exp(model.coefficients[2] ?? -4) : 0;
  const powerShape = model.id === "retention_power" ? Math.max(0.25, Math.min(2, Math.abs(model.coefficients[1] ?? 0.8))) : 1;
  const raw = Array.from({ length: 360 }, (_, index) => {
    const day = index + 1;
    let progress: number;
    if (model.id === "retention_multiplier") {
      const z = zValue(projectedRetention(model, cohort.observations, day), model);
      const multiplier = Math.exp(predictLinear(model.coefficients, parametricFeatures(model.id, day, z)));
      progress = multiplierAt360 / Math.max(multiplier, multiplierAt360);
    } else if (model.id === "retention_logarithmic") progress = Math.log(day + 1) / Math.log(361);
    else if (model.id === "retention_power") progress = (day / 360) ** powerShape;
    else progress = -Math.expm1(-saturationRate * day) / Math.max(-Math.expm1(-saturationRate * 360), 1e-8);
    return { day, value: terminal * Math.max(0, Math.min(1, progress)) };
  });
  return anchorMonotoneCurve(raw, anchors);
}
