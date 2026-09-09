import type { AnalysisResult, Cohort, ForecastPoint, ModelResult } from "../domain/types";
import { cohortToRoi } from "../validation/normalize";
import { validateCohorts } from "../validation/validate";
import { aggregateCohorts } from "./aggregate";
import { evaluateModels, type EvaluationOutput } from "./evaluate";
import { quantile } from "./math";
import { summarizeTarget } from "./target";

const INVALID_TARGET_WARNING = "ROI 目标必须是大于 0 的有限数。";
const INTERVAL_UNAVAILABLE_WARNING = "预测区间不可用：时间残差或跨模型证据不足。";

function uniqueWarnings(warnings: string[]): string[] {
  return [...new Set(warnings.filter((warning) => warning.length > 0))];
}

function unavailable(subjectId: string, warnings: string[]): AnalysisResult {
  return {
    subjectId,
    models: [],
    reachesTarget: false,
    confidence: "low",
    confidenceReasons: [],
    warnings: uniqueWarnings([...warnings, INTERVAL_UNAVAILABLE_WARNING]),
  };
}

function validTarget(target: number): boolean {
  return Number.isFinite(target) && target > 0;
}

function validationWarnings(cohort: Cohort): string[] {
  try {
    if (!cohort || typeof cohort.id !== "string" || !Array.isArray(cohort.observations)) {
      return ["批次数据无效：缺少批次标识或观测数组。"];
    }
    const validation = validateCohorts([cohort]);
    if (validation.isValid) return [];
    const decreases = validation.errors.some((issue) => issue.message.includes("decrease"));
    return [
      decreases
        ? "累计 ROI 曲线下降，无法分析；已保留原始值，未自动修复。"
        : `批次数据无效：${validation.errors.map((issue) => issue.message).join(" ")}`,
    ];
  } catch {
    return ["批次数据无效，无法进行预测。"];
  }
}

function usableTrainingCohorts(cohorts: Cohort[]): Cohort[] {
  if (!Array.isArray(cohorts)) return [];
  return cohorts.filter((cohort) => validationWarnings(cohort).length === 0);
}

function cloneModels(models: ModelResult[]): ModelResult[] {
  return models.map((model) => ({
    ...model,
    predictions: model.predictions.map((point) => ({ ...point })),
  }));
}

function predictionAt(model: ModelResult, day: number): number | undefined {
  const value = model.predictions.find((point) => point.day === day)?.value;
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function attachSelectedInterval(
  models: ModelResult[],
  evaluation: EvaluationOutput,
): boolean {
  if (!evaluation.selectedModelId || evaluation.residuals.length < 2 || evaluation.rankedModels.length < 2) {
    return false;
  }

  const selected = models.find((model) => model.id === evaluation.selectedModelId);
  const temporalError = quantile(
    evaluation.residuals.map((residual) => residual.absolute),
    0.8,
  );
  if (!selected || temporalError === null || !Number.isFinite(temporalError)) return false;

  let previousLower = 0;
  let previousUpper = 0;
  const predictions: ForecastPoint[] = [];
  for (const point of selected.predictions) {
    const modelValues = evaluation.rankedModels
      .map((model) => predictionAt(model, point.day))
      .filter((value): value is number => value !== undefined);
    if (modelValues.length < 2) return false;

    const rawLower = Math.max(0, Math.min(point.value, point.value - temporalError, ...modelValues));
    const rawUpper = Math.max(point.value, point.value + temporalError, ...modelValues);
    const lower = Math.max(previousLower, rawLower);
    const upper = Math.max(previousUpper, rawUpper, point.value);
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > point.value || upper < point.value) {
      return false;
    }
    predictions.push({ ...point, lower, upper });
    previousLower = lower;
    previousUpper = upper;
  }

  selected.predictions = predictions;
  return true;
}

export function analyzeCohort(cohort: Cohort, allCohorts: Cohort[], target: number): AnalysisResult {
  const subjectId = typeof cohort?.id === "string" ? cohort.id : "unknown";
  const targetWarnings = validTarget(target) ? [] : [INVALID_TARGET_WARNING];
  const cohortWarnings = validationWarnings(cohort);
  if (cohortWarnings.length > 0) return unavailable(subjectId, [...cohortWarnings, ...targetWarnings]);

  try {
    const observations = cohortToRoi(cohort);
    const evaluation = evaluateModels({
      observations,
      matureCohorts: usableTrainingCohorts(allCohorts),
      targetCohort: cohort,
    });
    const models = cloneModels(evaluation.models);
    const hasInterval = attachSelectedInterval(models, evaluation);
    const selected = models.find((model) => model.id === evaluation.selectedModelId);
    const summary = selected ? summarizeTarget(selected.predictions, target, observations) : { reachesTarget: false };
    const warnings = [
      ...evaluation.warnings,
      ...(hasInterval ? [] : [INTERVAL_UNAVAILABLE_WARNING]),
      ...targetWarnings,
    ];

    return {
      subjectId,
      models,
      selectedModelId: evaluation.selectedModelId,
      roi360: summary.roi360,
      targetGap: summary.targetGap,
      targetGapRatio: summary.targetGapRatio,
      targetDay: summary.targetDay,
      reachesTarget: summary.reachesTarget,
      confidence: evaluation.confidence,
      confidenceReasons: evaluation.confidenceReasons,
      warnings: uniqueWarnings(warnings),
    };
  } catch {
    return unavailable(subjectId, ["批次分析失败，请检查输入数据。", ...targetWarnings]);
  }
}

export function analyzeProject(
  cohorts: Cohort[],
  target: number,
): { cohorts: AnalysisResult[]; aggregate?: AnalysisResult } {
  const source = Array.isArray(cohorts) ? cohorts : [];
  const cohortResults = source.map((cohort) => analyzeCohort(cohort, source, target));

  try {
    const aggregateCohort = aggregateCohorts(source);
    return {
      cohorts: cohortResults,
      aggregate: analyzeCohort(aggregateCohort, source, target),
    };
  } catch {
    return {
      cohorts: cohortResults,
      aggregate: unavailable("aggregate", [
        "汇总分析不可用：批次投入、CAC 或观测数据无效。",
        ...(validTarget(target) ? [] : [INVALID_TARGET_WARNING]),
      ]),
    };
  }
}
