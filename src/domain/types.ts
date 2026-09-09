export type InputMode = "roi" | "roi_retention" | "ltv_cac";
export type EstimateInputMode = InputMode;

export interface RetentionMetrics {
  nextDay: number;
  day7: number;
}

export interface ObservationBase {
  day: number;
  value: number;
  contributorCount?: number;
  contributingSpend?: number;
}

export type RoiObservation = ObservationBase & { cac?: never; retention?: number };

export interface LtvObservation extends ObservationBase {
  cac: number;
}

export type Observation = RoiObservation | LtvObservation;

interface CohortBase {
  id: string;
  name: string;
  spend?: number;
}

export type RoiCohort = CohortBase & { mode: "roi"; observations: RoiObservation[] };
export type RoiRetentionCohort = CohortBase & { mode: "roi_retention"; retention?: RetentionMetrics; observations: RoiObservation[] };
export type LtvCacCohort = CohortBase & { mode: "ltv_cac"; observations: LtvObservation[] };
export type Cohort = RoiCohort | RoiRetentionCohort | LtvCacCohort;

export interface ForecastPoint {
  day: number;
  value: number;
  lower?: number;
  upper?: number;
}

export interface ModelObservationFit {
  day: number;
  observed: number;
  fitted: number;
  stageMultiplier?: number;
}

export type ModelId = "logarithmic" | "power" | "saturation" | "historical_multiplier"
  | "retention_multiplier" | "retention_logarithmic" | "retention_power" | "retention_saturation" | "retention_monotone_spline";

export interface ModelResult {
  id: ModelId;
  label: string;
  status: "ok" | "invalid" | "insufficient_data";
  score?: number;
  backtestError?: number;
  fitError?: number;
  parameters?: Record<string, number>;
  observationFits?: ModelObservationFit[];
  predictions: ForecastPoint[];
  reason?: string;
}

export interface AnalysisResult {
  subjectId: string;
  models: ModelResult[];
  selectedModelId?: ModelResult["id"];
  roi360?: number;
  targetGap?: number;
  targetGapRatio?: number;
  targetDay?: number;
  reachesTarget: boolean;
  confidence: "high" | "medium" | "low";
  confidenceReasons?: string[];
  warnings: string[];
}
