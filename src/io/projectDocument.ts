import { isModelPackageV4, normalizeModelPackageEligibility, type ModelPackageV4 } from "./savedCurves";
import { isStoredFitProjectV4, type StoredFitProjectV4 } from "./storage";

export interface ProjectDocumentV4 {
  documentVersion: 4;
  exportedAt: string;
  project: StoredFitProjectV4 & { cohorts: CohortArray };
  modelPackages: ModelPackageV4[];
}

type CohortArray = NonNullable<StoredFitProjectV4["cohorts"]>;

export type ParseProjectDocumentResult =
  | { status: "ok"; document: ProjectDocumentV4 }
  | { status: "invalid" }
  | { status: "version_mismatch"; version: unknown };

function completeProject(value: unknown): value is ProjectDocumentV4["project"] {
  return isStoredFitProjectV4(value) && value.cohorts !== undefined && value.cohorts.length > 0;
}

export function createProjectDocument(
  project: ProjectDocumentV4["project"],
  modelPackages: ModelPackageV4[],
): string {
  if (!completeProject(project) || !modelPackages.every(isModelPackageV4)) throw new TypeError("invalid project document data");
  const document: ProjectDocumentV4 = {
    documentVersion: 4,
    exportedAt: new Date().toISOString(),
    project: structuredClone(project),
    modelPackages: modelPackages.map((item) => structuredClone(item)),
  };
  return JSON.stringify(document, null, 2);
}

export function parseProjectDocument(raw: string): ParseProjectDocumentResult {
  try {
    const candidate: unknown = JSON.parse(raw);
    if (!candidate || typeof candidate !== "object") return { status: "invalid" };
    const record = candidate as Record<string, unknown>;
    if (record.documentVersion !== 4) {
      return "documentVersion" in record
        ? { status: "version_mismatch", version: record.documentVersion }
        : { status: "invalid" };
    }
    const normalizedPackages = Array.isArray(record.modelPackages)
      ? record.modelPackages.map(normalizeModelPackageEligibility)
      : record.modelPackages;
    if (typeof record.exportedAt !== "string" || Number.isNaN(Date.parse(record.exportedAt))
      || !completeProject(record.project) || !Array.isArray(record.modelPackages)
      || !Array.isArray(normalizedPackages) || !normalizedPackages.every(isModelPackageV4)) return { status: "invalid" };
    return {
      status: "ok",
      document: {
        documentVersion: 4,
        exportedAt: record.exportedAt,
        project: structuredClone(record.project),
        modelPackages: normalizedPackages.map((item) => structuredClone(item)),
      },
    };
  } catch {
    return { status: "invalid" };
  }
}

export function readLocalDocument(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("file is not text"));
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.readAsText(file);
  });
}
