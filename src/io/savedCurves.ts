import type { Cohort, ForecastPoint, ModelResult, Observation } from "../domain/types";
import type { AggregateModelResult } from "../forecast/multiCohortFit";
import { equalWeightModelIds } from "../forecast/modelEligibility";
import type { RetentionFitResult } from "../forecast/retention/retentionFit";
import type { StorageAdapter } from "./storage";
import { isStoredCohort } from "./storage";

export const SAVED_CURVES_KEY = "roi-forecast-tool.saved-curves";
export const MODEL_PACKAGES_KEY = "roi-forecast-tool.model-packages";

export interface SavedCurve {
  id: string;
  name: string;
  createdAt: string;
  modelId: ModelResult["id"];
  modelLabel: string;
  confidence: "high" | "medium" | "low";
  confidenceReasons: string[];
  sourceName: string;
  trainingPoints: number;
  predictions: ForecastPoint[];
}

export interface ModelPackageV3 {
  version: 3;
  id: string;
  name: string;
  createdAt: string;
  sourceSnapshot: Cohort;
  roiObservations: Observation[];
  models: ModelResult[];
  validModelIds: ModelResult["id"][];
  evaluationMode: "single_cohort_no_backtest";
  ensembleRule: "equal_valid_models";
  legacy?: boolean;
}

export interface ModelPackageV4 {
  version: 4;
  id: string;
  name: string;
  createdAt: string;
  sourceSnapshots: Cohort[];
  roiObservationsByCohort: Array<{ cohortId: string; observations: Observation[] }>;
  models: AggregateModelResult[];
  validModelIds: ModelResult["id"][];
  evaluationMode: "multi_cohort_temporal_backtest" | "single_cohort_no_backtest";
  ensembleRule: "equal_valid_models";
  cohortWeightRule: "equal_valid_cohorts";
  retentionFit?: RetentionFitResult;
  includeSplineInEnsemble?: boolean;
}

export interface IncompatibleModelPackage {
  id: string;
  name: string;
  createdAt: string;
  reason: "格式不兼容";
}

function browserStorage(): StorageAdapter | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function isSavedCurve(value: unknown): value is SavedCurve {
  if (!value || typeof value !== "object") return false;
  const curve = value as Partial<SavedCurve>;
  return typeof curve.id === "string"
    && typeof curve.name === "string"
    && curve.name.trim().length > 0
    && typeof curve.createdAt === "string"
    && ["logarithmic", "power", "saturation", "historical_multiplier"].includes(curve.modelId ?? "")
    && typeof curve.modelLabel === "string"
    && ["high", "medium", "low"].includes(curve.confidence ?? "")
    && Array.isArray(curve.confidenceReasons)
    && curve.confidenceReasons.every((reason) => typeof reason === "string")
    && typeof curve.sourceName === "string"
    && Number.isInteger(curve.trainingPoints)
    && (curve.trainingPoints ?? -1) >= 0
    && Array.isArray(curve.predictions)
    && curve.predictions.length > 0
    && curve.predictions.every((point) => Number.isInteger(point.day) && point.day >= 1 && point.day <= 360 && Number.isFinite(point.value) && point.value >= 0);
}

function validObservation(value: unknown): value is Observation {
  if (!value || typeof value !== "object") return false;
  const point = value as Partial<Observation>;
  return Number.isInteger(point.day) && (point.day ?? 0) >= 1 && (point.day ?? 361) <= 360
    && Number.isFinite(point.value) && (point.value ?? -1) >= 0;
}

function validModel(value: unknown): value is ModelResult {
  if (!value || typeof value !== "object") return false;
  const model = value as Partial<ModelResult>;
  const validId = ["logarithmic", "power", "saturation", "historical_multiplier", "retention_multiplier", "retention_logarithmic", "retention_power", "retention_saturation", "retention_monotone_spline"].includes(model.id ?? "");
  const validStatus = ["ok", "invalid", "insufficient_data"].includes(model.status ?? "");
  const validParameters = model.parameters === undefined || (
    !!model.parameters && typeof model.parameters === "object"
    && Object.values(model.parameters).every((item) => Number.isFinite(item))
  );
  const validObservationFits = model.observationFits === undefined || (
    Array.isArray(model.observationFits) && model.observationFits.every((point) => (
      !!point && Number.isInteger(point.day) && point.day >= 1 && point.day <= 360
      && Number.isFinite(point.observed) && point.observed >= 0
      && Number.isFinite(point.fitted) && point.fitted >= 0
      && (point.stageMultiplier === undefined || (Number.isFinite(point.stageMultiplier) && point.stageMultiplier >= 0))
    ))
  );
  if (!validId || !validStatus || typeof model.label !== "string" || !validParameters || !validObservationFits || !Array.isArray(model.predictions)) return false;
  if (model.status !== "ok") return model.predictions.length === 0 && (model.reason === undefined || typeof model.reason === "string");
  return model.predictions.length === 360 && model.predictions.every((point, index) => (
    validObservation(point) && point.day === index + 1
  ));
}

export function isModelPackageV3(value: unknown): value is ModelPackageV3 {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ModelPackageV3>;
  if (item.version !== 3 || typeof item.id !== "string" || !item.id || typeof item.name !== "string" || !item.name.trim()
    || typeof item.createdAt !== "string" || Number.isNaN(Date.parse(item.createdAt)) || !isStoredCohort(item.sourceSnapshot)
    || !Array.isArray(item.roiObservations) || !item.roiObservations.every(validObservation)
    || !Array.isArray(item.models) || item.models.length < 1 || !item.models.every(validModel)
    || !Array.isArray(item.validModelIds) || item.evaluationMode !== "single_cohort_no_backtest"
    || item.ensembleRule !== "equal_valid_models" || (item.legacy !== undefined && typeof item.legacy !== "boolean")) return false;
  const modelIds = new Set(item.models.map((model) => model.id));
  const declaredValidIds = new Set(item.validModelIds);
  const actualValidIds = item.models.filter((model) => model.status === "ok").map((model) => model.id);
  const completeNewPackage = item.legacy === true || (
    item.models.length === 4
    && ["historical_multiplier", "logarithmic", "power", "saturation"].every((id) => modelIds.has(id as ModelResult["id"]))
  );
  return completeNewPackage
    && modelIds.size === item.models.length
    && declaredValidIds.size === item.validModelIds.length
    && actualValidIds.length === item.validModelIds.length
    && actualValidIds.every((id) => declaredValidIds.has(id));
}

export function isModelPackageV4(value: unknown): value is ModelPackageV4 {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ModelPackageV4>;
  if (item.version !== 4 || typeof item.id !== "string" || !item.id || typeof item.name !== "string" || !item.name.trim()
    || typeof item.createdAt !== "string" || Number.isNaN(Date.parse(item.createdAt))
    || !Array.isArray(item.sourceSnapshots) || item.sourceSnapshots.length < 1 || !item.sourceSnapshots.every(isStoredCohort)
    || !Array.isArray(item.roiObservationsByCohort) || item.roiObservationsByCohort.length !== item.sourceSnapshots.length
    || !item.roiObservationsByCohort.every((entry) => !!entry && typeof entry.cohortId === "string" && Array.isArray(entry.observations) && entry.observations.every(validObservation))
    || !Array.isArray(item.models) || !item.models.every((model) => validModel(model)
      && Array.isArray(model.cohortFits) && model.cohortFits.length === item.sourceSnapshots!.length
      && Array.isArray(model.cohortBacktests) && Number.isInteger(model.validCohortCount) && Number.isInteger(model.backtestCohortCount))
    || !Array.isArray(item.validModelIds)
    || !["multi_cohort_temporal_backtest", "single_cohort_no_backtest"].includes(item.evaluationMode ?? "")
    || item.ensembleRule !== "equal_valid_models" || item.cohortWeightRule !== "equal_valid_cohorts") return false;
  const retentionMode = item.sourceSnapshots.every((cohort) => cohort.mode === "roi_retention");
  const required = retentionMode
    ? ["retention_multiplier", "retention_logarithmic", "retention_power", "retention_saturation", "retention_monotone_spline"]
    : ["historical_multiplier", "logarithmic", "power", "saturation"];
  const actual = equalWeightModelIds(item.models, retentionMode);
  const declared = new Set(item.validModelIds);
  return item.models.length === required.length && required.every((id) => item.models!.some((model) => model.id === id))
    && declared.size === item.validModelIds.length
    && actual.length === item.validModelIds.length && actual.every((id) => declared.has(id));
}

export function normalizeModelPackageEligibility(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const item = value as Partial<ModelPackageV4>;
  if (item.version !== 4 || !Array.isArray(item.sourceSnapshots) || item.sourceSnapshots.length < 1
    || !item.sourceSnapshots.every(isStoredCohort) || !Array.isArray(item.models) || !item.models.every(validModel)) return value;
  const retentionMode = item.sourceSnapshots.every((cohort) => cohort.mode === "roi_retention");
  return { ...item, validModelIds: equalWeightModelIds(item.models, retentionMode) };
}

export function loadModelPackageRecords(storage: StorageAdapter | undefined = browserStorage()): {
  compatible: ModelPackageV4[];
  incompatible: IncompatibleModelPackage[];
} {
  if (!storage) return { compatible: [], incompatible: [] };
  try {
    const raw = storage.getItem(MODEL_PACKAGES_KEY);
    if (!raw) return { compatible: [], incompatible: [] };
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { compatible: [], incompatible: [] };
    const normalized = parsed.map(normalizeModelPackageEligibility);
    const compatible = normalized.filter(isModelPackageV4).map((item) => structuredClone(item));
    const incompatible = parsed.flatMap((item, index): IncompatibleModelPackage[] => {
      if (isModelPackageV4(normalized[index]) || !item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      if (typeof record.id !== "string" || typeof record.name !== "string" || typeof record.createdAt !== "string") return [];
      return [{ id: record.id, name: record.name, createdAt: record.createdAt, reason: "格式不兼容" }];
    });
    return { compatible, incompatible };
  } catch {
    return { compatible: [], incompatible: [] };
  }
}

function writeModelPackageRecords(packages: ModelPackageV4[], incompatibleRaw: unknown[], storage: StorageAdapter | undefined): boolean {
  if (!storage || !packages.every(isModelPackageV4)) return false;
  try {
    storage.setItem(MODEL_PACKAGES_KEY, JSON.stringify([...incompatibleRaw, ...packages]));
    return true;
  } catch {
    return false;
  }
}

export function saveModelPackageV4(modelPackage: ModelPackageV4, storage: StorageAdapter | undefined = browserStorage()): boolean {
  if (!storage || !isModelPackageV4(modelPackage)) return false;
  let rawItems: unknown[] = [];
  try {
    const raw = storage.getItem(MODEL_PACKAGES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    rawItems = Array.isArray(parsed) ? parsed : [];
  } catch { return false; }
  const normalizedRawItems = rawItems.map(normalizeModelPackageEligibility);
  const legacy = normalizedRawItems.filter((item) => !isModelPackageV4(item));
  const current = normalizedRawItems.filter(isModelPackageV4);
  const next = current.some((item) => item.id === modelPackage.id)
    ? current.map((item) => item.id === modelPackage.id ? modelPackage : item)
    : [...current, modelPackage];
  return writeModelPackageRecords(next, legacy, storage);
}

export function deleteModelPackageRecord(id: string, storage: StorageAdapter | undefined = browserStorage()): boolean {
  if (!storage) return false;
  try {
    const raw = storage.getItem(MODEL_PACKAGES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return false;
    storage.setItem(MODEL_PACKAGES_KEY, JSON.stringify(parsed.filter((item) => !item || typeof item !== "object" || (item as { id?: unknown }).id !== id)));
    return true;
  } catch { return false; }
}

export function replaceModelPackagesV4(packages: ModelPackageV4[], storage: StorageAdapter | undefined = browserStorage()): boolean {
  return writeModelPackageRecords(packages, [], storage);
}

export function loadSavedCurves(storage: StorageAdapter | undefined = browserStorage()): SavedCurve[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(SAVED_CURVES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every(isSavedCurve) ? parsed.map((curve) => ({
      ...curve,
      confidenceReasons: [...curve.confidenceReasons],
      predictions: curve.predictions.map((point) => ({ ...point })),
    })) : [];
  } catch {
    return [];
  }
}

function write(curves: SavedCurve[], storage: StorageAdapter | undefined): boolean {
  if (!storage) return false;
  try {
    storage.setItem(SAVED_CURVES_KEY, JSON.stringify(curves));
    return true;
  } catch {
    return false;
  }
}

export function saveCurve(curve: SavedCurve, storage: StorageAdapter | undefined = browserStorage()): boolean {
  if (!isSavedCurve(curve)) return false;
  const current = loadSavedCurves(storage);
  const index = current.findIndex((item) => item.id === curve.id);
  const next = index >= 0
    ? current.map((item) => item.id === curve.id ? curve : item)
    : [...current, curve];
  return write(next, storage);
}

export function deleteSavedCurve(id: string, storage: StorageAdapter | undefined = browserStorage()): boolean {
  return write(loadSavedCurves(storage).filter((curve) => curve.id !== id), storage);
}

export function replaceSavedCurves(curves: SavedCurve[], storage: StorageAdapter | undefined = browserStorage()): boolean {
  return curves.every(isSavedCurve) && write(curves, storage);
}

function writePackages(packages: ModelPackageV3[], storage: StorageAdapter | undefined): boolean {
  if (!storage || !packages.every(isModelPackageV3)) return false;
  try {
    storage.setItem(MODEL_PACKAGES_KEY, JSON.stringify(packages));
    return true;
  } catch {
    return false;
  }
}

export function loadModelPackages(storage: StorageAdapter | undefined = browserStorage()): ModelPackageV3[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(MODEL_PACKAGES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every(isModelPackageV3)
      ? parsed.map((item) => structuredClone(item))
      : [];
  } catch {
    return [];
  }
}

export function saveModelPackage(modelPackage: ModelPackageV3, storage: StorageAdapter | undefined = browserStorage()): boolean {
  if (!isModelPackageV3(modelPackage)) return false;
  const current = loadModelPackages(storage);
  const next = current.some((item) => item.id === modelPackage.id)
    ? current.map((item) => item.id === modelPackage.id ? modelPackage : item)
    : [...current, modelPackage];
  return writePackages(next, storage);
}

export function deleteModelPackage(id: string, storage: StorageAdapter | undefined = browserStorage()): boolean {
  return writePackages(loadModelPackages(storage).filter((item) => item.id !== id), storage);
}

export function replaceModelPackages(packages: ModelPackageV3[], storage: StorageAdapter | undefined = browserStorage()): boolean {
  return writePackages(packages, storage);
}
