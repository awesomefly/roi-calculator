import type { Cohort, ModelResult, RoiObservation } from "../domain/types";
import { cohortToRoi } from "../validation/normalize";
import { median, quantile } from "./math";
import { fitHistoricalMultiplier } from "./models/historicalMultiplier";
import { logarithmicModel } from "./models/logarithmic";
import type { ModelContext } from "./models/model";
import { validatePredictionSeries } from "./models/model";
import { powerModel } from "./models/power";
import { saturationModel } from "./models/saturation";

const FORECAST_END_DAY = 360;
const MAPE_EPSILON = 1e-6;
const HIGH_DISAGREEMENT = 0.35;
const HIGH_HISTORICAL_DISPERSION = 0.5;

type ModelId = ModelResult["id"];

export interface EvaluationFitContext extends ModelContext {
  targetCohort: Cohort;
  matureCohorts: Cohort[];
}

export interface EvaluationModel {
  id: ModelId;
  label: string;
  /** Minimum prefix size required by this model; defaults to two. */
  minimumTrainingObservations?: number;
  fit(observations: RoiObservation[], context: EvaluationFitContext): ModelResult;
}

export interface EvaluationInput {
  observations: RoiObservation[];
  matureCohorts?: Cohort[];
  targetCohort?: Cohort;
  models?: EvaluationModel[];
}

export interface BacktestResidual {
  day: number;
  actual: number;
  predicted: number;
  /** Actual minus predicted. */
  signed: number;
  absolute: number;
  absolutePercentageError: number;
}

export interface EvaluatedModelResult extends ModelResult {
  eligible: boolean;
  residuals: BacktestResidual[];
  stabilityPenalty: number;
  historicalDispersion?: number;
}

export interface EvaluationOutput {
  /** All model results for display, with selectable models first. */
  models: EvaluatedModelResult[];
  /** Only constraint-valid models with temporal backtest evidence. */
  rankedModels: EvaluatedModelResult[];
  selectedModelId?: ModelId;
  /** Residuals for the automatically selected model. */
  residuals: BacktestResidual[];
  confidence: "high" | "medium" | "low";
  warnings: string[];
  confidenceReasons: string[];
  modelDisagreement?: number;
  matureCohortCount: number;
}

interface HistoricalEvidence {
  count: number;
  dispersion: number;
  dispersionSampleCount: number;
}

interface ConfidenceAssessment {
  confidence: EvaluationOutput["confidence"];
  warnings: string[];
  reasons: string[];
}

interface BacktestResult {
  residuals: BacktestResidual[];
  requiredHoldoutCount: number;
  failures: string[];
}

function defaultModels(): EvaluationModel[] {
  return [
    {
      id: "logarithmic",
      label: "对数模型",
      fit: (observations, context) => logarithmicModel.fit(observations, context),
    },
    {
      id: "power",
      label: "幂函数模型",
      fit: (observations, context) => powerModel.fit(observations, context),
    },
    {
      id: "saturation",
      label: "饱和模型",
      minimumTrainingObservations: 3,
      fit: (observations, context) => saturationModel.fit(observations, context),
    },
    {
      id: "historical_multiplier",
      label: "历史倍率",
      fit(observations, context) {
        const target: Cohort = {
          id: context.targetCohort.id,
          name: context.targetCohort.name,
          mode: "roi",
          spend: context.targetCohort.spend,
          observations,
        };
        return fitHistoricalMultiplier(target, context.matureCohorts);
      },
    },
  ];
}

function fallbackTarget(observations: RoiObservation[]): Cohort {
  return {
    id: "evaluation-target",
    name: "当前批次",
    mode: "roi",
    observations,
  };
}

function safeFit(
  model: EvaluationModel,
  observations: RoiObservation[],
  context: EvaluationFitContext,
): ModelResult {
  try {
    const fitObservations = observations.map((observation) => ({ ...observation }));
    const fitContext: EvaluationFitContext = {
      ...context,
      targetCohort: {
        id: context.targetCohort.id,
        name: context.targetCohort.name,
        mode: "roi",
        ...(context.targetCohort.spend === undefined ? {} : { spend: context.targetCohort.spend }),
        observations: fitObservations.map((observation) => ({ ...observation })),
      },
    };
    const result = model.fit(fitObservations, fitContext);
    if (!result || result.id !== model.id || !Array.isArray(result.predictions)) {
      return {
        id: model.id,
        label: model.label,
        status: "invalid",
        predictions: [],
        reason: "模型返回了与声明不一致的结果。",
      };
    }
    return result;
  } catch {
    return {
      id: model.id,
      label: model.label,
      status: "invalid",
      predictions: [],
      reason: "模型计算失败。",
    };
  }
}

function predictionAt(result: ModelResult, day: number): number | undefined {
  const value = result.predictions.find((point) => point.day === day)?.value;
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function observedFloorReason(result: ModelResult, observations: RoiObservation[]): string | null {
  const latest = observations[observations.length - 1];
  if (!latest || result.status !== "ok") return null;
  return result.predictions.some((point) => point.day > latest.day && point.value < latest.value - MAPE_EPSILON)
    ? `未来累计预测低于最新观测 D${latest.day} 的累计值。`
    : null;
}

function validPredictionReason(result: ModelResult, observations: RoiObservation[]): string | null {
  if (result.status !== "ok") return result.reason ?? "模型不可用。";
  const constraintReason = validatePredictionSeries(result.predictions);
  if (constraintReason) return constraintReason;
  const floorReason = observedFloorReason(result, observations);
  if (floorReason) return floorReason;
  if (predictionAt(result, FORECAST_END_DAY) === undefined) return "模型未生成 D360 预测。";
  return null;
}

function backtest(
  model: EvaluationModel,
  observations: RoiObservation[],
  context: EvaluationFitContext,
  minimumTrainingObservations: number,
): BacktestResult {
  const residuals: BacktestResidual[] = [];
  const failures: string[] = [];
  const requiredHoldoutCount = Math.max(0, observations.length - minimumTrainingObservations);
  for (
    let holdoutIndex = minimumTrainingObservations;
    holdoutIndex < observations.length;
    holdoutIndex += 1
  ) {
    const training = observations.slice(0, holdoutIndex);
    const actualPoint = observations[holdoutIndex];
    if (!actualPoint) continue;

    const result = safeFit(model, training, context);
    if (result.status !== "ok") {
      failures.push(`D${actualPoint.day} 回测拟合失败。`);
      continue;
    }
    const constraintReason = validatePredictionSeries(result.predictions);
    if (constraintReason) {
      failures.push(`D${actualPoint.day} 回测预测违反约束：${constraintReason}`);
      continue;
    }
    const predicted = predictionAt(result, actualPoint.day);
    if (predicted === undefined) {
      failures.push(`D${actualPoint.day} 回测缺失预测值。`);
      continue;
    }

    const signed = actualPoint.value - predicted;
    const absolute = Math.abs(signed);
    residuals.push({
      day: actualPoint.day,
      actual: actualPoint.value,
      predicted,
      signed,
      absolute,
      absolutePercentageError: absolute / Math.max(Math.abs(actualPoint.value), MAPE_EPSILON),
    });
  }
  return { residuals, requiredHoldoutCount, failures };
}

function meanMape(residuals: BacktestResidual[]): number | undefined {
  if (residuals.length === 0) return undefined;
  return residuals.reduce((sum, residual) => sum + residual.absolutePercentageError, 0) / residuals.length;
}

function accelerationPenalty(result: ModelResult): number {
  const day360 = predictionAt(result, 360);
  if (day360 === undefined) return 1;

  const pointsBeforeEnd = result.predictions.filter((point) => point.day < FORECAST_END_DAY);
  const pointsThroughDay60 = pointsBeforeEnd.filter((point) => point.day <= 60);
  const baseline = pointsThroughDay60[pointsThroughDay60.length - 1] ?? pointsBeforeEnd[0];
  if (!baseline || baseline.day >= FORECAST_END_DAY) return 1;
  const reference = pointsBeforeEnd.find((point) => point.day < baseline.day);
  const earlyDailyGain = reference
    ? Math.max(0, baseline.value - reference.value) / (baseline.day - reference.day)
    : Math.max(0, baseline.value) / Math.max(1, baseline.day);
  const lateDailyGain = Math.max(0, day360 - baseline.value) / (FORECAST_END_DAY - baseline.day);
  if (lateDailyGain <= earlyDailyGain) return 0;
  if (earlyDailyGain <= MAPE_EPSILON) return Math.min(10, lateDailyGain / MAPE_EPSILON);
  return Math.min(10, Math.max(0, lateDailyGain / earlyDailyGain - 1) / 10);
}

function historicalEvidence(cohorts: Cohort[], targetId: string): HistoricalEvidence {
  const multipliers: number[] = [];
  let count = 0;
  for (const cohort of cohorts) {
    if (!cohort || cohort.id === targetId) continue;
    const observations = cohortToRoi(cohort);
    let previousDay = 0;
    let previousValue = Number.NEGATIVE_INFINITY;
    const validCurve =
      observations.length > 0 &&
      observations.every((point) => {
        const valid =
          Number.isInteger(point.day) &&
          point.day > previousDay &&
          point.day <= FORECAST_END_DAY &&
          Number.isFinite(point.value) &&
          point.value >= 0 &&
          point.value >= previousValue;
        previousDay = point.day;
        previousValue = point.value;
        return valid;
      });
    const matureValue = observations.find((point) => point.day === FORECAST_END_DAY)?.value;
    if (!validCurve || matureValue === undefined || !Number.isFinite(matureValue) || matureValue <= 0) continue;
    count += 1;

    const day60 = observations.find((point) => point.day === 60)?.value;
    if (
      day60 === undefined ||
      !Number.isFinite(day60) ||
      day60 <= 0 ||
      matureValue < day60
    ) {
      continue;
    }
    multipliers.push(matureValue / day60);
  }

  const middle = median(multipliers);
  const lower = quantile(multipliers, 0.25);
  const upper = quantile(multipliers, 0.75);
  const dispersion =
    middle !== null && lower !== null && upper !== null && middle > 0 ? (upper - lower) / middle : 0;
  return { count, dispersion, dispersionSampleCount: multipliers.length };
}

function historicalPenalty(evidence: HistoricalEvidence): number {
  if (evidence.dispersionSampleCount === 0) return 3;
  const sampleShortfall = Math.max(0, 3 - evidence.dispersionSampleCount) / 3;
  return evidence.dispersion + 1 / Math.sqrt(evidence.dispersionSampleCount) + sampleShortfall;
}

function modelDisagreement(models: EvaluatedModelResult[]): number | undefined {
  const forecasts = models
    .filter((model) => model.eligible)
    .map((model) => predictionAt(model, FORECAST_END_DAY))
    .filter((value): value is number => value !== undefined);
  if (forecasts.length < 2) return undefined;
  const center = median(forecasts);
  if (center === null) return undefined;
  return (Math.max(...forecasts) - Math.min(...forecasts)) / Math.max(Math.abs(center), MAPE_EPSILON);
}

function assessConfidence(
  observations: RoiObservation[],
  selected: EvaluatedModelResult | undefined,
  disagreement: number | undefined,
  history: HistoricalEvidence,
): ConfidenceAssessment {
  const warnings: string[] = [];
  const reasons: string[] = [];
  let evidenceScore = 0;

  if (observations.length >= 5) {
    evidenceScore += 2;
    reasons.push(`观测点数量充足（${observations.length} 个）。`);
  } else if (observations.length >= 3) {
    evidenceScore += 1;
    warnings.push(`观测点较少：仅 ${observations.length} 个观测点。`);
  } else {
    warnings.push("观测点不足：至少需要 3 个观测点才能进行时间回测。");
  }

  const latestDay = observations[observations.length - 1]?.day ?? 0;
  if (latestDay >= 90) {
    evidenceScore += 2;
    reasons.push(`最新观测已到 D${latestDay}，外推距离较短。`);
  } else if (latestDay >= 30) {
    evidenceScore += 1;
    warnings.push(`最新观测仅到 D${latestDay}，到 D360 的外推距离较长。`);
  } else {
    warnings.push(`最新观测仅到 D${latestDay}，长期外推不确定性较高。`);
  }

  const error = selected?.backtestError;
  if (error !== undefined && error <= 0.15) {
    evidenceScore += 2;
    reasons.push("时间回测误差较低。");
  } else if (error !== undefined && error <= 0.3) {
    evidenceScore += 1;
    warnings.push("时间回测误差中等。");
  } else if (error !== undefined) {
    warnings.push("时间回测误差较高。");
  } else {
    warnings.push("可用的时间回测残差不足。");
  }

  if (disagreement === undefined) {
    warnings.push("有效模型少于两个，模型分歧无法评估。");
  } else if (disagreement <= 0.15) {
    evidenceScore += 2;
    reasons.push("有效模型的 D360 预测较为一致。");
  } else if (disagreement <= HIGH_DISAGREEMENT) {
    evidenceScore += 1;
    warnings.push("模型之间存在一定分歧。");
  } else {
    warnings.push("模型分歧较大，D360 预测范围较宽。");
  }

  if (history.count >= 8) {
    evidenceScore += 2;
    reasons.push(`成熟批次样本充足（${history.count} 个）。`);
  } else if (history.count >= 3) {
    evidenceScore += 1;
    warnings.push(`成熟批次样本较少（${history.count} 个）。`);
  } else {
    warnings.push(`成熟批次不足：仅 ${history.count} 个有效 D360 样本。`);
  }

  if (history.dispersionSampleCount >= 3 && history.dispersion > HIGH_HISTORICAL_DISPERSION) {
    warnings.push("成熟批次的 D60–D360 倍率离散较大。");
    evidenceScore -= 1;
  } else if (history.dispersionSampleCount >= 3) {
    reasons.push("成熟批次倍率离散程度可控。");
  } else {
    warnings.push("可用于评估 D60–D360 倍率离散度的成熟批次不足。");
  }

  if (!selected) warnings.push("没有可用于自动选择的有效模型。");
  const confidence =
    selected && disagreement !== undefined && evidenceScore >= 8
      ? "high"
      : selected && evidenceScore >= 5
        ? "medium"
        : "low";
  if (reasons.length === 0) reasons.push("当前数据证据较弱，预测结果需谨慎解读。");
  return { confidence, warnings: [...new Set(warnings)], reasons: [...new Set(reasons)] };
}

function compareModels(left: EvaluatedModelResult, right: EvaluatedModelResult): number {
  if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
  if (!left.eligible) return left.id.localeCompare(right.id);
  const scoreDifference = (left.score ?? Number.POSITIVE_INFINITY) - (right.score ?? Number.POSITIVE_INFINITY);
  if (scoreDifference !== 0) return scoreDifference;
  return left.id.localeCompare(right.id);
}

export function evaluateModels(input: EvaluationInput): EvaluationOutput {
  const observations = (Array.isArray(input.observations) ? input.observations : [])
    .map((observation) => ({ ...observation }))
    .sort((left, right) => left.day - right.day);
  const matureCohorts = Array.isArray(input.matureCohorts) ? input.matureCohorts : [];
  const targetCohort = input.targetCohort ?? fallbackTarget(observations);
  const context: EvaluationFitContext = {
    forecastEndDay: FORECAST_END_DAY,
    targetCohort,
    matureCohorts,
  };
  const history = historicalEvidence(matureCohorts, targetCohort.id);
  const models = input.models ?? defaultModels();
  const evaluated = models.map((model): EvaluatedModelResult => {
    const minimumTrainingObservations =
      Number.isSafeInteger(model.minimumTrainingObservations) && (model.minimumTrainingObservations ?? 0) >= 2
        ? model.minimumTrainingObservations ?? 2
        : 2;
    const backtestResult = backtest(model, observations, context, minimumTrainingObservations);
    const { residuals } = backtestResult;
    const fullResult = safeFit(model, observations, context);
    const invalidReason = validPredictionReason(fullResult, observations);
    const completeCoverage =
      backtestResult.requiredHoldoutCount > 0 &&
      backtestResult.failures.length === 0 &&
      residuals.length === backtestResult.requiredHoldoutCount;
    const backtestError = completeCoverage ? meanMape(residuals) : undefined;
    const isHistorical = model.id === "historical_multiplier";
    const stabilityPenalty =
      (invalidReason ? 0 : accelerationPenalty(fullResult)) + (isHistorical ? historicalPenalty(history) : 0);
    const eligible = invalidReason === null && completeCoverage && backtestError !== undefined && Number.isFinite(backtestError);

    const normalizedResult: ModelResult = invalidReason && fullResult.status === "ok"
      ? {
          id: model.id,
          label: fullResult.label || model.label,
          status: "invalid",
          predictions: [],
          reason: `模型预测违反约束：${invalidReason}`,
        }
      : fullResult;
    const reason =
      normalizedResult.reason ??
      (backtestResult.failures.length > 0
        ? `必需回测未完整：${backtestResult.failures.join("")}`
        : !eligible
          ? `至少需要一个由 ${minimumTrainingObservations} 个更早观测点预测的时间回测残差。`
          : undefined);

    return {
      ...normalizedResult,
      reason,
      score: eligible ? (backtestError ?? 0) + stabilityPenalty : undefined,
      backtestError,
      eligible,
      residuals,
      stabilityPenalty,
      historicalDispersion: isHistorical ? history.dispersion : undefined,
    };
  });

  evaluated.sort(compareModels);
  const rankedModels = evaluated.filter((model) => model.eligible);
  const selected = rankedModels[0];
  const disagreement = modelDisagreement(evaluated);
  const assessment = assessConfidence(observations, selected, disagreement, history);

  return {
    models: evaluated,
    rankedModels,
    selectedModelId: selected?.id,
    residuals: selected?.residuals ?? [],
    confidence: assessment.confidence,
    warnings: assessment.warnings,
    confidenceReasons: assessment.reasons,
    modelDisagreement: disagreement,
    matureCohortCount: history.count,
  };
}
