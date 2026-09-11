import type { ModelResult, RoiObservation } from "../domain/types";
import type { ModelPackageV4 } from "../io/savedCurves";
import { compileAssessmentPredictor, type AssessmentCandidate, type CompiledAssessmentPredictor } from "./retention/assessmentPredictor";

export type AssessmentPackageMode = "roi" | "roi_retention" | "ltv_cac";
export type AssessmentConfidence = "low" | "medium" | "high";
export type JointBoundaryStrategy = "roi_first" | "balanced" | "retention_first";

export const ASSESSMENT_SEARCH_BUDGET = {
  coarseGridPoints: 4,
  refinedGridPoints: 3,
  optimizationStarts: 1,
  optimizationIterations: 4,
} as const;

export interface StandardValue { recommended: number; baseline?: number; lower: number; upper: number; conservativeAdjustment: number }
export interface JointBoundaryPoint extends AssessmentCandidate {
  strategy: JointBoundaryStrategy;
  conservativeTargetRoi: number;
}
export interface AssessmentStandardsResult {
  status: "ok" | "trial" | "unavailable" | "unsupported";
  mode: AssessmentPackageMode;
  confidence: AssessmentConfidence;
  roi1?: StandardValue;
  roi7?: StandardValue;
  nextDayRetention?: StandardValue;
  day7Retention?: StandardValue;
  jointBoundary: JointBoundaryPoint[];
  conservativeTargetRoi?: number;
  boundaryWarning?: string;
  extrapolation?: "within_history" | "upward" | "downward";
  extrapolationRatio?: number;
  validModelCount: number;
  matureSampleCount: number;
  warnings: string[];
}

interface MatureSample { roi1: number; roi7: number; nextDayRetention: number; day7Retention: number; targetRoi: number }

const RETENTION_UNAVAILABLE = "当前模型包不包含留存率数据，只能反推 ROI 标准。如需反推留存率，请选择 ROI + 留存率模型包。";
const OUT_OF_RANGE = "目标超出历史数据与模型支持范围，无法可靠反推考核标准。";

function packageMode(modelPackage: ModelPackageV4): AssessmentPackageMode {
  return modelPackage.sourceSnapshots[0]?.mode ?? "roi";
}

function effectiveModels(modelPackage: ModelPackageV4): ModelPackageV4["models"] {
  const ids = new Set(modelPackage.validModelIds);
  return modelPackage.models.filter((model) => model.status === "ok" && ids.has(model.id));
}

function valueAt(model: ModelResult, day: number): number | undefined {
  const value = model.predictions[day - 1]?.value;
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function modelError(model: ModelResult): number | undefined {
  const value = model.parameters?.d360BacktestError ?? model.backtestError;
  return value === undefined || !Number.isFinite(value) ? undefined : Math.max(0, Math.min(0.5, value));
}

function summarizeRoi(models: ModelResult[], day: 1 | 7, targetDay: number, targetRoi: number): StandardValue | undefined {
  const values = models.flatMap((model) => {
    const early = valueAt(model, day); const target = valueAt(model, targetDay);
    if (early === undefined || target === undefined || target <= 0) return [];
    const raw = targetRoi * early / target; const error = modelError(model);
    return [{ raw, conservative: error === undefined ? raw : raw / (1 - error) }];
  });
  if (!values.length) return undefined;
  const rawMean = values.reduce((sum, item) => sum + item.raw, 0) / values.length;
  const recommended = values.reduce((sum, item) => sum + item.conservative, 0) / values.length;
  return {
    recommended,
    baseline: rawMean,
    lower: Math.min(...values.map((item) => item.raw)),
    upper: Math.max(...values.map((item) => item.conservative)),
    conservativeAdjustment: recommended - rawMean,
  };
}

function exact(cohort: ModelPackageV4["sourceSnapshots"][number], day: number): RoiObservation | undefined {
  const point = cohort.observations.find((item) => item.day === day);
  return point && !("cac" in point) ? point : undefined;
}

function matureSamples(modelPackage: ModelPackageV4): MatureSample[] {
  return modelPackage.sourceSnapshots.flatMap((cohort) => {
    if (cohort.mode !== "roi_retention") return [];
    const d1 = exact(cohort, 1); const d7 = exact(cohort, 7); const target = exact(cohort, 360);
    if (!d1 || !d7 || !target || d1.retention === undefined || d7.retention === undefined) return [];
    const values = [d1.value, d7.value, target.value, d1.retention, d7.retention];
    if (values.some((value) => !Number.isFinite(value)) || d1.value < 0 || d1.value > d7.value || d7.value > target.value
      || d1.retention < 0 || d1.retention > 1 || d7.retention < 0 || d7.retention > 1) return [];
    return [{ roi1: d1.value, roi7: d7.value, nextDayRetention: d1.retention, day7Retention: d7.retention, targetRoi: target.value }];
  });
}

function quantile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * fraction; const left = Math.floor(position); const right = Math.ceil(position);
  return (sorted[left] ?? 0) + ((sorted[right] ?? sorted[left] ?? 0) - (sorted[left] ?? 0)) * (position - left);
}

function median(values: number[]): number { return quantile(values, 0.5); }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
function grid(min: number, max: number, count = 9): number[] { return min === max ? [min] : Array.from({ length: count }, (_, index) => min + (max - min) * index / (count - 1)); }
type Ranges = { roi1: [number, number]; retention1: [number, number]; roi7: [number, number]; retention7: [number, number] };
function span(range: [number, number]): number { return Math.max(range[1] - range[0], .01); }
function candidateScore(candidate: AssessmentCandidate, anchor: AssessmentCandidate, ranges: Ranges): number {
  return 2 * Math.abs(candidate.roi1 - anchor.roi1) / span(ranges.roi1)
    + Math.abs(candidate.retention1 - anchor.retention1) / span(ranges.retention1)
    + 2 * Math.abs(candidate.roi7 - anchor.roi7) / span(ranges.roi7)
    + Math.abs(candidate.retention7 - anchor.retention7) / span(ranges.retention7);
}
interface QualifiedCandidate { candidate: AssessmentCandidate; conservativeTargetRoi: number; allModelsReachTarget: boolean }
function qualifiedCandidates(predictor: CompiledAssessmentPredictor, target: number, ranges: Ranges, count = 5): QualifiedCandidate[] {
  const qualified: QualifiedCandidate[] = [];
  for (const roi1 of grid(...ranges.roi1, count)) for (const retention1 of grid(...ranges.retention1, count))
    for (const roi7 of grid(...ranges.roi7, count)) for (const retention7 of grid(...ranges.retention7, count)) {
      const candidate = { roi1, retention1, roi7, retention7 };
      const prediction = predictor.predict(candidate);
      if (!prediction || prediction.conservativeTargetRoi < target) continue;
      qualified.push({
        candidate,
        conservativeTargetRoi: prediction.conservativeTargetRoi,
        allModelsReachTarget: prediction.modelValues.every((value) => value.conservative >= target),
      });
    }
  return qualified;
}
function refine(ranges: Ranges, candidate: AssessmentCandidate): Ranges {
  const around = (range: [number, number], value: number): [number, number] => {
    const step = (range[1] - range[0]) / 8;
    return [Math.max(range[0], value - step), Math.min(range[1], value + step)];
  };
  return { roi1: around(ranges.roi1, candidate.roi1), retention1: around(ranges.retention1, candidate.retention1), roi7: around(ranges.roi7, candidate.roi7), retention7: around(ranges.retention7, candidate.retention7) };
}
function normalizedBurden(candidate: AssessmentCandidate, ranges: Ranges): { roi: number; retention: number } {
  return {
    roi: (candidate.roi1 - ranges.roi1[0]) / span(ranges.roi1) + (candidate.roi7 - ranges.roi7[0]) / span(ranges.roi7),
    retention: (candidate.retention1 - ranges.retention1[0]) / span(ranges.retention1)
      + (candidate.retention7 - ranges.retention7[0]) / span(ranges.retention7),
  };
}
function candidateKey(candidate: AssessmentCandidate): string {
  return [candidate.roi1, candidate.roi7, candidate.retention1, candidate.retention7].map((value) => value.toFixed(8)).join("|");
}
function representativeBoundary(candidates: QualifiedCandidate[], anchor: AssessmentCandidate, ranges: Ranges): { points: JointBoundaryPoint[]; stable: boolean } {
  const unique = [...new Map(candidates.map((item) => [candidateKey(item.candidate), item])).values()];
  const pool = unique;
  const used = new Set<string>();
  const select = (strategy: JointBoundaryStrategy, compare: (left: QualifiedCandidate, right: QualifiedCandidate) => number): JointBoundaryPoint | undefined => {
    const item = [...pool].sort(compare).find((candidate) => !used.has(candidateKey(candidate.candidate)));
    if (!item) return undefined;
    used.add(candidateKey(item.candidate));
    return { strategy, ...item.candidate, conservativeTargetRoi: item.conservativeTargetRoi };
  };
  const byScore = (left: QualifiedCandidate, right: QualifiedCandidate) => candidateScore(left.candidate, anchor, ranges) - candidateScore(right.candidate, anchor, ranges)
    || right.conservativeTargetRoi - left.conservativeTargetRoi;
  const balanced = select("balanced", byScore);
  const roiFirst = select("roi_first", (left, right) => normalizedBurden(left.candidate, ranges).retention - normalizedBurden(right.candidate, ranges).retention || byScore(left, right));
  const retentionFirst = select("retention_first", (left, right) => normalizedBurden(left.candidate, ranges).roi - normalizedBurden(right.candidate, ranges).roi || byScore(left, right));
  const points = [roiFirst, balanced, retentionFirst].filter((point): point is JointBoundaryPoint => point !== undefined);
  const selectedKeys = new Set(points.map((point) => candidateKey(point)));
  const selectedRecords = pool.filter((item) => selectedKeys.has(candidateKey(item.candidate)));
  const rangesVary = ranges.roi1[0] < ranges.roi1[1] && ranges.roi7[0] < ranges.roi7[1]
    && ranges.retention1[0] < ranges.retention1[1] && ranges.retention7[0] < ranges.retention7[1];
  return { points, stable: points.length === 3 && rangesVary && selectedRecords.every((item) => item.allModelsReachTarget) };
}

function optimizeCandidates(predictor: CompiledAssessmentPredictor, target: number, ranges: Ranges, anchor: AssessmentCandidate, seeds: QualifiedCandidate[]): QualifiedCandidate[] {
  const decode = (vector: number[]): AssessmentCandidate => {
    const value = (range: [number, number], unit: number) => range[0] + clamp(unit, 0, 1) * (range[1] - range[0]);
    const roi1 = value(ranges.roi1, vector[0]!); const rawRoi7 = value(ranges.roi7, vector[1]!);
    const retention1 = clamp(vector[2]!, 0, 1); const rawRetention7 = clamp(vector[3]!, 0, 1);
    return { roi1, roi7: Math.max(roi1, rawRoi7), retention1, retention7: Math.min(retention1, rawRetention7) };
  };
  const encode = (candidate: AssessmentCandidate): number[] => [
    (candidate.roi1 - ranges.roi1[0]) / span(ranges.roi1), (candidate.roi7 - ranges.roi7[0]) / span(ranges.roi7),
    candidate.retention1, candidate.retention7,
  ];
  const loss = (vector: number[], strategy: JointBoundaryStrategy): number => {
    const candidate = decode(vector); const prediction = predictor.predict(candidate); const burden = normalizedBurden(candidate, ranges);
    const preference = strategy === "balanced" ? candidateScore(candidate, anchor, ranges)
      : strategy === "roi_first" ? .25 * burden.roi + .75 * burden.retention : .75 * burden.roi + .25 * burden.retention;
    const shortfall = prediction ? Math.max(0, (target - prediction.conservativeTargetRoi) / target) : 1;
    return preference + 1_000 * shortfall ** 2;
  };
  const results: QualifiedCandidate[] = [];
  for (const strategy of ["roi_first", "balanced", "retention_first"] as const) {
    const starts = [...seeds].sort((a, b) => loss(encode(a.candidate), strategy) - loss(encode(b.candidate), strategy))
      .slice(0, ASSESSMENT_SEARCH_BUDGET.optimizationStarts);
    for (const seed of starts) {
      const vector = encode(seed.candidate); const first = Array(4).fill(0); const second = Array(4).fill(0);
      for (let iteration = 1; iteration <= ASSESSMENT_SEARCH_BUDGET.optimizationIterations; iteration += 1) {
        const gradient = vector.map((_, index) => {
          const epsilon = .002; const plus = [...vector]; const minus = [...vector]; plus[index] += epsilon; minus[index] -= epsilon;
          return (loss(plus, strategy) - loss(minus, strategy)) / (2 * epsilon);
        });
        for (let index = 0; index < 4; index += 1) {
          first[index] = .9 * first[index]! + .1 * gradient[index]!; second[index] = .999 * second[index]! + .001 * gradient[index]! ** 2;
          const m = first[index]! / (1 - .9 ** iteration); const v = second[index]! / (1 - .999 ** iteration);
          vector[index] = clamp(vector[index]! - .04 * m / (Math.sqrt(v) + 1e-8), 0, 1);
        }
      }
      const candidate = decode(vector); const prediction = predictor.predict(candidate);
      if (prediction && prediction.conservativeTargetRoi >= target) results.push({ candidate, conservativeTargetRoi: prediction.conservativeTargetRoi, allModelsReachTarget: prediction.modelValues.every((value) => value.conservative >= target) });
    }
  }
  return results;
}
function discretelyRevalidate(predictor: CompiledAssessmentPredictor, target: number, candidates: QualifiedCandidate[]): QualifiedCandidate[] {
  return candidates.flatMap((item): QualifiedCandidate[] => {
    const candidate = {
      roi1: Math.round(item.candidate.roi1 * 1_000) / 1_000,
      roi7: Math.round(item.candidate.roi7 * 1_000) / 1_000,
      retention1: Math.round(item.candidate.retention1 * 1_000) / 1_000,
      retention7: Math.round(item.candidate.retention7 * 1_000) / 1_000,
    };
    const prediction = predictor.predict(candidate);
    return prediction && prediction.conservativeTargetRoi >= target ? [{ candidate, conservativeTargetRoi: prediction.conservativeTargetRoi, allModelsReachTarget: prediction.modelValues.every((value) => value.conservative >= target) }] : [];
  });
}

export function invertAssessmentStandards(input: { modelPackage: ModelPackageV4; targetRoi: number; targetDay: number }): AssessmentStandardsResult {
  const mode = packageMode(input.modelPackage); const models = effectiveModels(input.modelPackage);
  const base = { mode, jointBoundary: [], validModelCount: models.length, matureSampleCount: 0 };
  if (mode === "ltv_cac") return { ...base, status: "unsupported", confidence: "low", warnings: ["当前模型包为 LTV + CAC，暂不支持考核标准反推。"] };
  if (!Number.isFinite(input.targetRoi) || input.targetRoi <= 0 || !Number.isInteger(input.targetDay) || input.targetDay < 7 || input.targetDay > 360) return { ...base, status: "unavailable", confidence: "low", warnings: ["目标累计 ROI 必须大于 0，目标周期必须为 D7–D360。"] };
  const roi1 = summarizeRoi(models, 1, input.targetDay, input.targetRoi); const roi7 = summarizeRoi(models, 7, input.targetDay, input.targetRoi);
  if (!roi1 || !roi7) return { ...base, status: "unavailable", confidence: "low", warnings: ["没有有效模型能够生成完整的 D1、D7 和目标日 ROI 曲线。"] };
  if (mode === "roi") return { ...base, status: "ok", confidence: models.every((model) => modelError(model) !== undefined) ? "high" : "medium", roi1, roi7, warnings: [RETENTION_UNAVAILABLE] };

  const samples = matureSamples(input.modelPackage); const confidence: AssessmentConfidence = samples.length < 5 ? "low" : samples.length < 10 ? "medium" : "high";
  const retentionBase = { ...base, matureSampleCount: samples.length, roi1, roi7 };
  if (samples.length < 3) return { ...retentionBase, status: "unavailable", confidence, warnings: ["完整成熟留存样本少于 3 个，不能可靠反推考核标准。"] };
  const historicalTargetRange: [number, number] = [Math.min(...samples.map((s) => s.targetRoi)), Math.max(...samples.map((s) => s.targetRoi))];
  const extrapolation = input.targetRoi > historicalTargetRange[1] ? "upward" : input.targetRoi < historicalTargetRange[0] ? "downward" : "within_history";
  const extrapolationRatio = extrapolation === "upward" ? input.targetRoi / historicalTargetRange[1]
    : extrapolation === "downward" ? input.targetRoi / historicalTargetRange[0] : 1;
  const historicalRoi1: [number, number] = [Math.min(...samples.map((s) => s.roi1)), Math.max(...samples.map((s) => s.roi1))];
  const historicalRoi7: [number, number] = [Math.min(...samples.map((s) => s.roi7)), Math.max(...samples.map((s) => s.roi7))];
  const historicalRetentionVaries = new Set(samples.map((s) => s.nextDayRetention.toFixed(8))).size > 1
    && new Set(samples.map((s) => s.day7Retention.toFixed(8))).size > 1;
  const ranges: Ranges = {
    roi1: [historicalRoi1[0] * extrapolationRatio, historicalRoi1[1] * extrapolationRatio], retention1: [0, 1],
    roi7: [historicalRoi7[0] * extrapolationRatio, historicalRoi7[1] * extrapolationRatio], retention7: [0, 1],
  };
  const anchor: AssessmentCandidate = { roi1: clamp(roi1.recommended, ...ranges.roi1), retention1: median(samples.map((s) => s.nextDayRetention)), roi7: clamp(roi7.recommended, ...ranges.roi7), retention7: median(samples.map((s) => s.day7Retention)) };
  const predictor = compileAssessmentPredictor(input.modelPackage, input.targetDay);
  if (!predictor.modelIds.length) return { ...retentionBase, status: "unavailable", confidence, warnings: ["没有具备目标日回测误差的有效留存增强模型，无法正式反推。"] };
  const coarse = qualifiedCandidates(predictor, input.targetRoi, ranges, ASSESSMENT_SEARCH_BUDGET.coarseGridPoints);
  const coarseBalanced = [...coarse].sort((left, right) => candidateScore(left.candidate, anchor, ranges) - candidateScore(right.candidate, anchor, ranges))[0];
  if (!coarseBalanced) return { ...retentionBase, status: "unavailable", confidence, warnings: [OUT_OF_RANGE] };
  const refined = qualifiedCandidates(predictor, input.targetRoi, refine(ranges, coarseBalanced.candidate), ASSESSMENT_SEARCH_BUDGET.refinedGridPoints);
  const optimized = optimizeCandidates(predictor, input.targetRoi, ranges, anchor, [...coarse, ...refined]);
  const verified = discretelyRevalidate(predictor, input.targetRoi, [...coarse, ...refined, ...optimized]);
  const boundary = representativeBoundary(verified, anchor, ranges);
  const balanced = boundary.points.find((point) => point.strategy === "balanced") ?? boundary.points[0];
  if (!balanced) return { ...retentionBase, status: "unavailable", confidence, warnings: [OUT_OF_RANGE] };
  const recommendation: AssessmentCandidate = balanced;
  const finalPrediction = predictor.predict(recommendation);
  if (!finalPrediction || finalPrediction.conservativeTargetRoi < input.targetRoi) return { ...retentionBase, status: "unavailable", confidence, warnings: [OUT_OF_RANGE] };
  const boundaryWarning = !boundary.stable || !historicalRetentionVaries ? "联合达标方案区分度有限，仅供参考。" : undefined;
  return {
    ...retentionBase,
    status: confidence === "high" ? "ok" : "trial", confidence,
    roi1: {
      ...roi1, recommended: recommendation.roi1,
      lower: Math.min(roi1.lower, recommendation.roi1), upper: Math.max(roi1.upper, recommendation.roi1),
      conservativeAdjustment: recommendation.roi1 - roi1.recommended,
    },
    roi7: {
      ...roi7, recommended: recommendation.roi7,
      lower: Math.min(roi7.lower, recommendation.roi7), upper: Math.max(roi7.upper, recommendation.roi7),
      conservativeAdjustment: recommendation.roi7 - roi7.recommended,
    },
    nextDayRetention: { recommended: recommendation.retention1, lower: ranges.retention1[0], upper: ranges.retention1[1], conservativeAdjustment: 0 },
    day7Retention: { recommended: recommendation.retention7, lower: ranges.retention7[0], upper: ranges.retention7[1], conservativeAdjustment: 0 },
    jointBoundary: boundary.points, conservativeTargetRoi: finalPrediction.conservativeTargetRoi, extrapolation, extrapolationRatio,
    ...(boundaryWarning ? { boundaryWarning } : {}),
    warnings: confidence === "low" ? ["当前只有 3–4 个完整成熟样本，结果仅供试算，不建议作为正式考核标准。"]
      : confidence === "medium" ? ["当前有 5–9 个完整成熟样本，结果为中置信度试算。"] : [],
  };
}
