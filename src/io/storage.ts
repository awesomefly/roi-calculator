import type { Cohort, InputMode } from "../domain/types";

export const PROJECT_STORAGE_KEY = "roi-forecast-tool.project";
export const PROJECT_INITIALIZED_KEY = "roi-forecast-tool.initialized";

export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface StoredObservationDraftV3 {
  id: string;
  day: string;
  value: string;
  cac: string;
  retention?: string;
}

export interface StoredCohortDraftV3 {
  id: string;
  name: string;
  mode: InputMode;
  spend: string;
  retention?: { nextDay: string; day7: string };
  observations: Record<InputMode, StoredObservationDraftV3[]>;
}

export interface StoredFitProjectV3 {
  version: 3;
  cohort?: Cohort;
  uiDraft: StoredCohortDraftV3;
  demo?: boolean;
}

export interface StoredFitProjectV4 {
  version: 4;
  cohorts?: Cohort[];
  uiDrafts: StoredCohortDraftV3[];
  demo?: boolean;
}

export type ProjectToStore = Omit<StoredFitProjectV4, "version">;

export type LoadProjectResult =
  | { status: "empty"; initialized: boolean }
  | { status: "unavailable" }
  | { status: "ok"; project: StoredFitProjectV4; migratedFromVersion?: 3 }
  | { status: "corrupted"; raw: string }
  | { status: "version_mismatch"; version: unknown; raw: string };

function browserStorage(): StorageAdapter | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function isStoredCohort(value: unknown): value is Cohort {
  if (!value || typeof value !== "object") return false;
  const cohort = value as Record<string, unknown>;
  const spend = cohort.spend;
  if (typeof cohort.id !== "string" || typeof cohort.name !== "string"
    || (cohort.mode !== "roi" && cohort.mode !== "roi_retention" && cohort.mode !== "ltv_cac") || "cac" in cohort
    || (spend !== undefined && (!Number.isFinite(spend) || (spend as number) < 0))
    || !Array.isArray(cohort.observations)) return false;

  if (cohort.mode === "roi_retention" && cohort.retention !== undefined) {
    const retention = cohort.retention as Record<string, unknown> | undefined;
    if (!retention || !Number.isFinite(retention.nextDay) || (retention.nextDay as number) < 0 || (retention.nextDay as number) > 1
      || !Number.isFinite(retention.day7) || (retention.day7 as number) < 0 || (retention.day7 as number) > 1) return false;
  } else if ("retention" in cohort) return false;
  const days = new Set<number>();
  let previousDay = 0;
  let previousValue = Number.NEGATIVE_INFINITY;
  let previousRoi = Number.NEGATIVE_INFINITY;
  return cohort.observations.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const observation = entry as Record<string, unknown>;
    const day = observation.day;
    const metric = observation.value;
    const validCore = Number.isInteger(day) && (day as number) >= 1 && (day as number) <= 360
      && (day as number) > previousDay && !days.has(day as number)
      && Number.isFinite(metric) && (metric as number) >= 0 && (metric as number) >= previousValue;
    if (!validCore) return false;
    const cac = observation.cac;
    if (cohort.mode !== "ltv_cac" && cac !== undefined) return false;
    if (cohort.mode === "ltv_cac" && (!Number.isFinite(cac) || (cac as number) <= 0)) return false;
    const retention = observation.retention;
    if (cohort.mode !== "roi_retention" && retention !== undefined) return false;
    if (cohort.mode === "roi_retention" && retention !== undefined
      && (!Number.isFinite(retention) || (retention as number) < 0 || (retention as number) > 1)) return false;
    const roi = (metric as number) / (cohort.mode === "ltv_cac" ? cac as number : 1);
    if (roi < previousRoi - 1e-12) return false;
    days.add(day as number);
    previousDay = day as number;
    previousValue = metric as number;
    previousRoi = Math.max(previousRoi, roi);
    return true;
  });
}

function isStoredObservationDraftV3(value: unknown): value is StoredObservationDraftV3 {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<StoredObservationDraftV3>;
  return typeof draft.id === "string" && typeof draft.day === "string"
    && typeof draft.value === "string" && typeof draft.cac === "string"
    && (draft.retention === undefined || typeof draft.retention === "string");
}

export function isStoredCohortDraftV3(value: unknown): value is StoredCohortDraftV3 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredCohortDraftV3> & Record<string, unknown>;
  if (typeof candidate.id !== "string" || typeof candidate.name !== "string"
    || (candidate.mode !== "roi" && candidate.mode !== "roi_retention" && candidate.mode !== "ltv_cac") || "cac" in candidate
    || typeof candidate.spend !== "string" || !candidate.observations
    || !Array.isArray(candidate.observations.roi)
    || (candidate.observations.roi_retention !== undefined && !Array.isArray(candidate.observations.roi_retention))
    || !Array.isArray(candidate.observations.ltv_cac)) return false;
  if (candidate.retention !== undefined && (!candidate.retention || typeof candidate.retention !== "object"
    || typeof (candidate.retention as { nextDay?: unknown }).nextDay !== "string"
    || typeof (candidate.retention as { day7?: unknown }).day7 !== "string")) return false;
  const ids = new Set<string>();
  return [...candidate.observations.roi, ...(candidate.observations.roi_retention ?? []), ...candidate.observations.ltv_cac].every((observation) => {
    if (!isStoredObservationDraftV3(observation) || ids.has(observation.id)) return false;
    ids.add(observation.id);
    return true;
  });
}

function normalizeStoredDraft(draft: StoredCohortDraftV3): StoredCohortDraftV3 {
  const existingIds = new Set([...draft.observations.roi, ...draft.observations.ltv_cac].map((item) => item.id));
  let sequence = 1;
  const nextId = () => {
    while (existingIds.has(`observation-${sequence}`)) sequence += 1;
    const id = `observation-${sequence}`;
    existingIds.add(id);
    return id;
  };
  const retentionRows = (draft.observations.roi_retention ?? draft.observations.roi).map((item) => ({
    ...item,
    ...(item.retention !== undefined ? {} : item.day === "1" && draft.retention?.nextDay ? { retention: draft.retention.nextDay }
      : item.day === "7" && draft.retention?.day7 ? { retention: draft.retention.day7 } : {}),
    id: draft.observations.roi_retention ? item.id : nextId(),
  }));
  return {
    ...structuredClone(draft),
    retention: draft.retention ? { ...draft.retention } : { nextDay: "", day7: "" },
    observations: {
      ...structuredClone(draft.observations),
      roi_retention: retentionRows,
    },
  };
}

function normalizeStoredCohort(cohort: Cohort): Cohort {
  if (cohort.mode !== "roi_retention" || !cohort.retention) return structuredClone(cohort);
  return {
    ...structuredClone(cohort),
    observations: cohort.observations.map((point) => ({
      ...point,
      ...(point.retention !== undefined ? {} : point.day === 1 ? { retention: cohort.retention?.nextDay }
        : point.day === 7 ? { retention: cohort.retention?.day7 } : {}),
    })),
  };
}

export function isStoredFitProjectV3(value: unknown): value is StoredFitProjectV3 {
  if (!value || typeof value !== "object") return false;
  const project = value as Partial<StoredFitProjectV3>;
  return project.version === 3
    && (project.cohort === undefined || isStoredCohort(project.cohort))
    && isStoredCohortDraftV3(project.uiDraft)
    && (project.demo === undefined || typeof project.demo === "boolean");
}

export function isStoredFitProjectV4(value: unknown): value is StoredFitProjectV4 {
  if (!value || typeof value !== "object") return false;
  const project = value as Partial<StoredFitProjectV4>;
  if (project.version !== 4 || !Array.isArray(project.uiDrafts) || project.uiDrafts.length < 1
    || !project.uiDrafts.every(isStoredCohortDraftV3)
    || (project.demo !== undefined && typeof project.demo !== "boolean")) return false;
  if (project.cohorts === undefined) return true;
  return Array.isArray(project.cohorts) && project.cohorts.length === project.uiDrafts.length
    && project.cohorts.every(isStoredCohort);
}

export function saveProject(project: ProjectToStore, storage: StorageAdapter | undefined = browserStorage()): StoredFitProjectV4 | undefined {
  if (!storage) return undefined;
  const stored: StoredFitProjectV4 = {
    version: 4,
    ...(project.cohorts === undefined ? {} : { cohorts: structuredClone(project.cohorts) }),
    uiDrafts: structuredClone(project.uiDrafts),
    ...(project.demo === undefined ? {} : { demo: project.demo }),
  };
  if (!isStoredFitProjectV4(stored)) return undefined;
  storage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(stored));
  return stored;
}

/** Loads only V3. Older batch-CAC schemas remain recoverable but are never migrated. */
export function loadProject(storage: StorageAdapter | undefined = browserStorage()): LoadProjectResult {
  if (!storage) return { status: "empty", initialized: false };
  let raw: string | null;
  try {
    raw = storage.getItem(PROJECT_STORAGE_KEY);
    if (raw === null) return { status: "empty", initialized: storage.getItem(PROJECT_INITIALIZED_KEY) === "1" };
  } catch {
    return { status: "unavailable" };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isStoredFitProjectV4(parsed)) return { status: "ok", project: { ...structuredClone(parsed), cohorts: parsed.cohorts?.map(normalizeStoredCohort), uiDrafts: parsed.uiDrafts.map(normalizeStoredDraft) } };
    if (isStoredFitProjectV3(parsed)) {
      const project: StoredFitProjectV4 = {
        version: 4,
        ...(parsed.cohort ? { cohorts: [normalizeStoredCohort(parsed.cohort)] } : {}),
        uiDrafts: [normalizeStoredDraft(parsed.uiDraft)],
        ...(parsed.demo === undefined ? {} : { demo: parsed.demo }),
      };
      return { status: "ok", project, migratedFromVersion: 3 };
    }
    if (parsed && typeof parsed === "object" && "version" in parsed) {
      const version = (parsed as { version: unknown }).version;
      if (version === 4) return { status: "corrupted", raw };
      if (version !== 3) return { status: "version_mismatch", version, raw };
    }
    return { status: "corrupted", raw };
  } catch {
    return { status: "corrupted", raw };
  }
}

export function clearProject(storage: StorageAdapter | undefined = browserStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(PROJECT_INITIALIZED_KEY, "1");
    storage.removeItem(PROJECT_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
