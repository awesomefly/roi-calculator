import type { ModelId, RoiRetentionCohort } from "../../domain/types";
import type { ModelPackageV4 } from "../../io/savedCurves";
import { predictMonotoneRetentionSpline, trainMonotoneRetentionSpline, type TrainedMonotoneRetentionSpline } from "./monotoneRetentionSpline";
import { predictRetentionCurve, trainRetentionModel, type RetentionParametricModelId, type TrainedRetentionModel } from "./retentionModels";
import { safeLogit } from "./retentionMath";

export interface AssessmentCandidate { roi1: number; retention1: number; roi7: number; retention7: number }
export interface AssessmentPrediction {
  targetRoi: number;
  conservativeTargetRoi: number;
  modelValues: Array<{ modelId: ModelId; predicted: number; conservative: number }>;
}
export interface CompiledAssessmentPredictor {
  modelIds: ModelId[];
  predict(candidate: AssessmentCandidate): AssessmentPrediction | undefined;
}

interface Calibration { intercept: number; coefficients: number[]; means: number[]; scales: number[] }
interface CompiledModel { id: ModelId; error: number; calibration: Calibration; predictBase: (candidate: AssessmentCandidate) => number | undefined }

function features(candidate: AssessmentCandidate): number[] {
  return [Math.log(Math.max(candidate.roi1, 1e-6)), Math.log(Math.max(candidate.roi7, 1e-6)), safeLogit(candidate.retention1), safeLogit(candidate.retention7)];
}

function fitPositiveCalibration(rows: Array<{ x: number[]; y: number }>): Calibration {
  const means = rows[0]!.x.map((_, column) => rows.reduce((sum, row) => sum + row.x[column]!, 0) / rows.length);
  const scales = means.map((mean, column) => Math.max(Math.sqrt(rows.reduce((sum, row) => sum + (row.x[column]! - mean) ** 2, 0) / rows.length), .05));
  const normalized = rows.map((row) => row.x.map((value, column) => (value - means[column]!) / scales[column]!));
  const coefficients = means.map(() => 0);
  let intercept = rows.reduce((sum, row) => sum + row.y, 0) / rows.length;
  for (let iteration = 0; iteration < 120; iteration += 1) {
    for (let column = 0; column < coefficients.length; column += 1) {
      let numerator = 0; let denominator = .1;
      for (let index = 0; index < rows.length; index += 1) {
        const other = coefficients.reduce((sum, coefficient, feature) => feature === column ? sum : sum + coefficient * normalized[index]![feature]!, 0);
        numerator += normalized[index]![column]! * (rows[index]!.y - intercept - other);
        denominator += normalized[index]![column]! ** 2;
      }
      coefficients[column] = Math.max(0, numerator / denominator);
    }
    intercept = rows.reduce((sum, row, index) => sum + row.y - coefficients.reduce((value, coefficient, column) => value + coefficient * normalized[index]![column]!, 0), 0) / rows.length;
  }
  return { intercept, coefficients, means, scales };
}

function candidateFrom(cohort: RoiRetentionCohort): AssessmentCandidate | undefined {
  const d1 = cohort.observations.find((point) => point.day === 1);
  const d7 = cohort.observations.find((point) => point.day === 7);
  if (!d1 || !d7 || d1.retention === undefined || d7.retention === undefined || d1.value <= 0 || d7.value <= 0) return undefined;
  return { roi1: d1.value, retention1: d1.retention, roi7: d7.value, retention7: d7.retention };
}

function curveValue(
  trained: TrainedRetentionModel | TrainedMonotoneRetentionSpline,
  id: ModelId,
  candidate: AssessmentCandidate,
  targetDay: number,
): number | undefined {
  const query: Pick<RoiRetentionCohort, "observations"> = { observations: [
    { day: 1, value: candidate.roi1, retention: candidate.retention1 },
    { day: 7, value: candidate.roi7, retention: candidate.retention7 },
  ] };
  const curve = id === "retention_monotone_spline"
    ? predictMonotoneRetentionSpline(trained as TrainedMonotoneRetentionSpline, query)
    : predictRetentionCurve(trained as TrainedRetentionModel, query);
  const value = curve[targetDay - 1]?.value;
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

function applyCalibration(base: number, candidate: AssessmentCandidate, calibration: Calibration): number {
  const x = features(candidate);
  const correction = calibration.intercept + calibration.coefficients.reduce((sum, coefficient, index) => sum + coefficient * (x[index]! - calibration.means[index]!) / calibration.scales[index]!, 0);
  return base * Math.exp(correction);
}

function compileModel(id: ModelId, cohorts: RoiRetentionCohort[], targetDay: number, error: number): CompiledModel | undefined {
  const trained = id === "retention_monotone_spline"
    ? trainMonotoneRetentionSpline(cohorts)
    : trainRetentionModel(id as RetentionParametricModelId, cohorts);
  if (!trained) return undefined;
  const predictBase = (candidate: AssessmentCandidate) => curveValue(trained, id, candidate, targetDay);
  const rows = cohorts.flatMap((cohort) => {
    const candidate = candidateFrom(cohort); const actual = cohort.observations.find((point) => point.day === 360)?.value;
    const base = candidate ? curveValue(trained, id, candidate, 360) : undefined;
    return candidate && actual !== undefined && actual > 0 && base !== undefined ? [{ x: features(candidate), y: Math.log(actual / base) }] : [];
  });
  if (rows.length < 3) return undefined;
  return { id, error, calibration: fitPositiveCalibration(rows), predictBase };
}

function predicted(model: CompiledModel, candidate: AssessmentCandidate): number | undefined {
  const base = model.predictBase(candidate);
  return base === undefined ? undefined : applyCalibration(base, candidate, model.calibration);
}

export function compileAssessmentPredictor(modelPackage: ModelPackageV4, targetDay: number): CompiledAssessmentPredictor {
  const cohorts = modelPackage.sourceSnapshots.filter((cohort): cohort is RoiRetentionCohort => cohort.mode === "roi_retention"
    && cohort.observations.some((point) => point.day === 360 && point.value > 0));
  const validIds = new Set(modelPackage.validModelIds);
  const models = modelPackage.models.flatMap((model): CompiledModel[] => {
    const rawError = model.parameters?.d360BacktestError ?? model.backtestError;
    if (!validIds.has(model.id) || model.status !== "ok" || rawError === undefined || !Number.isFinite(rawError)) return [];
    const compiled = compileModel(model.id, cohorts, targetDay, Math.max(0, Math.min(.5, rawError)));
    return compiled ? [compiled] : [];
  });
  return {
    modelIds: models.map((model) => model.id),
    predict(candidate) {
      if (!(candidate.roi1 > 0 && candidate.roi7 >= candidate.roi1 && candidate.retention1 >= 0 && candidate.retention1 <= 1
        && candidate.retention7 >= 0 && candidate.retention7 <= candidate.retention1)) return undefined;
      const modelValues = models.flatMap((model) => {
        const value = predicted(model, candidate);
        return value === undefined || !Number.isFinite(value) ? [] : [{ modelId: model.id, predicted: value, conservative: value * (1 - model.error) }];
      });
      if (!modelValues.length) return undefined;
      return {
        targetRoi: modelValues.reduce((sum, item) => sum + item.predicted, 0) / modelValues.length,
        conservativeTargetRoi: modelValues.reduce((sum, item) => sum + item.conservative, 0) / modelValues.length,
        modelValues,
      };
    },
  };
}
