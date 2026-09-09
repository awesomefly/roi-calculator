import { describe, expect, it } from "vitest";
import { fitMultiCohortPackageSource } from "../forecast/multiCohortFit";
import { cohortDraftsFrom } from "../components/CohortEditor";
import type { Cohort } from "../domain/types";
import type { ModelPackageV4 } from "./savedCurves";
import type { StoredFitProjectV4 } from "./storage";
import { createProjectDocument, parseProjectDocument } from "./projectDocument";

const cohorts: Cohort[] = [
  { id: "roi", name: "ROI", mode: "roi", observations: [{ day: 1, value: 0.1 }, { day: 360, value: 1.5 }] },
  { id: "ltv", name: "LTV", mode: "ltv_cac", observations: [{ day: 1, value: 2, cac: 20 }, { day: 360, value: 30, cac: 20 }] },
];
const project: StoredFitProjectV4 & { cohorts: Cohort[] } = { version: 4, cohorts, uiDrafts: cohortDraftsFrom(cohorts) };
const fit = fitMultiCohortPackageSource(cohorts);
const modelPackage: ModelPackageV4 = {
  version: 4, id: "p1", name: "多批次模型包", createdAt: "2026-08-26T00:00:00.000Z",
  sourceSnapshots: fit.sources, roiObservationsByCohort: fit.observationsByCohort, models: fit.models,
  validModelIds: fit.models.filter((model) => model.status === "ok").map((model) => model.id),
  evaluationMode: fit.evaluationMode, ensembleRule: "equal_valid_models", cohortWeightRule: "equal_valid_cohorts",
};

describe("project document", () => {
  it("round-trips V4 multi-cohort inputs and complete model packages", () => {
    const parsed = parseProjectDocument(createProjectDocument(project, [modelPackage]));
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;
    expect(parsed.document.documentVersion).toBe(4);
    expect(parsed.document.project.cohorts.map((cohort) => cohort.name)).toEqual(["ROI", "LTV"]);
    expect(parsed.document.modelPackages[0]?.sourceSnapshots[1]?.observations[0]).toEqual({ day: 1, value: 2, cac: 20 });
  });

  it("rejects malformed and older exported documents", () => {
    expect(parseProjectDocument("not-json").status).toBe("invalid");
    expect(parseProjectDocument(JSON.stringify({ documentVersion: 3 }))).toEqual({ status: "version_mismatch", version: 3 });
    expect(parseProjectDocument(JSON.stringify({ documentVersion: 4 })).status).toBe("invalid");
  });
});
