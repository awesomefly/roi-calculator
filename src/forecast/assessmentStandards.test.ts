import { describe, expect, it } from "vitest";
import { DEMO_COHORTS, RETENTION_DEMO_COHORTS } from "../domain/demoData";
import type { Cohort } from "../domain/types";
import type { ModelPackageV4 } from "../io/savedCurves";
import { equalWeightModelIds } from "./modelEligibility";
import { fitMultiCohortPackageSource } from "./multiCohortFit";
import { ASSESSMENT_SEARCH_BUDGET, invertAssessmentStandards } from "./assessmentStandards";

function modelPackage(cohorts: Cohort[]): ModelPackageV4 {
  const fit = fitMultiCohortPackageSource(cohorts);
  const retention = cohorts.every((cohort) => cohort.mode === "roi_retention");
  return {
    version: 4, id: "test", name: "测试模型包", createdAt: "2026-09-01T00:00:00.000Z",
    sourceSnapshots: fit.sources, roiObservationsByCohort: fit.observationsByCohort, models: fit.models,
    validModelIds: equalWeightModelIds(fit.models, retention), evaluationMode: fit.evaluationMode,
    ensembleRule: "equal_valid_models", cohortWeightRule: "equal_valid_cohorts",
    ...(fit.retentionFit ? { retentionFit: fit.retentionFit } : {}),
  };
}

describe("assessment standard inversion", () => {
  it("caps the four-dimensional candidate search budget", () => {
    const gridCandidates = ASSESSMENT_SEARCH_BUDGET.coarseGridPoints ** 4
      + ASSESSMENT_SEARCH_BUDGET.refinedGridPoints ** 4;
    const optimizationSteps = 3 * ASSESSMENT_SEARCH_BUDGET.optimizationStarts
      * ASSESSMENT_SEARCH_BUDGET.optimizationIterations;

    expect(gridCandidates).toBeLessThanOrEqual(337);
    expect(optimizationSteps).toBeLessThanOrEqual(12);
  });

  it("uses an ROI package only for ROI1 and ROI7 standards", () => {
    const cohorts = DEMO_COHORTS.filter((cohort) => cohort.mode === "roi" && cohort.observations.some((point) => point.day === 360));
    const result = invertAssessmentStandards({ modelPackage: modelPackage(cohorts), targetRoi: 1.37, targetDay: 360 });
    expect(result.status).toBe("ok");
    expect(result.roi1?.recommended).toBeGreaterThan(0);
    expect(result.roi7?.recommended).toBeGreaterThan(result.roi1?.recommended ?? 0);
    expect(result.nextDayRetention).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("只能反推 ROI 标准");
  });

  it("uses a qualified retention package to return four bounded standards", () => {
    const result = invertAssessmentStandards({ modelPackage: modelPackage(RETENTION_DEMO_COHORTS), targetRoi: 1.37, targetDay: 360 });
    expect(result).toMatchObject({ status: "trial", confidence: "medium", matureSampleCount: 5 });
    expect(result.roi1).toBeDefined(); expect(result.roi7).toBeDefined();
    expect(result.nextDayRetention).toBeDefined(); expect(result.day7Retention).toBeDefined();
    expect(result.conservativeTargetRoi).toBeGreaterThanOrEqual(1.37);
    expect(result.roi1?.baseline).toBeGreaterThan(0);
    expect(result.roi1?.lower).toBeLessThanOrEqual(result.roi1?.recommended ?? 0);
    expect(result.roi1?.upper).toBeGreaterThanOrEqual(result.roi1?.recommended ?? 0);
    expect(result.roi7?.lower).toBeLessThanOrEqual(result.roi7?.recommended ?? 0);
    expect(result.roi7?.upper).toBeGreaterThanOrEqual(result.roi7?.recommended ?? 0);
    expect(result.jointBoundary).toHaveLength(3);
    expect(result.jointBoundary.every((point) => point.conservativeTargetRoi >= 1.37)).toBe(true);
    expect(result.jointBoundary.every((point) => [point.roi1, point.roi7, point.retention1, point.retention7]
      .every((value) => Number.isInteger(value * 1_000)))).toBe(true);
    expect(result.jointBoundary.map((point) => point.strategy)).toEqual(["roi_first", "balanced", "retention_first"]);
    const balanced = result.jointBoundary.find((point) => point.strategy === "balanced");
    expect(balanced).toMatchObject({
      roi1: result.roi1?.recommended,
      roi7: result.roi7?.recommended,
      retention1: result.nextDayRetention?.recommended,
      retention7: result.day7Retention?.recommended,
    });
  });

  it("keeps complete joint combinations visible when their differentiation is limited", () => {
    const cohorts: Cohort[] = RETENTION_DEMO_COHORTS.map((cohort) => {
      if (cohort.mode !== "roi_retention") return cohort;
      return {
        ...cohort,
        observations: cohort.observations.map((point) => ({
          ...point,
          ...(point.day === 1 ? { retention: 0.25 } : point.day === 7 ? { retention: 0.12 } : {}),
        })),
      };
    });
    const result = invertAssessmentStandards({ modelPackage: modelPackage(cohorts), targetRoi: 1.37, targetDay: 360 });

    expect(result.jointBoundary.length).toBeGreaterThan(0);
    expect(result.jointBoundary.every((point) => (
      point.roi1 >= 0.08 && point.roi1 <= 0.13
      && point.roi7 >= 0.22 && point.roi7 <= 0.34
      && point.retention1 >= 0 && point.retention1 <= 1
      && point.retention7 >= 0 && point.retention7 <= 1
      && point.roi7 >= point.roi1 && point.retention7 <= point.retention1
    ))).toBe(true);
    expect(result.boundaryWarning).toContain("仅供参考");
  });

  it("jointly extrapolates ROI and retention candidates above mature D360 history", () => {
    const result = invertAssessmentStandards({ modelPackage: modelPackage(RETENTION_DEMO_COHORTS), targetRoi: 2, targetDay: 360 });

    expect(result.extrapolation).toBe("upward");
    expect(result.extrapolationRatio).toBeCloseTo(2 / 1.72, 6);
    expect(result.jointBoundary.length).toBeGreaterThan(0);
    expect(result.jointBoundary.every((point) => (
      point.retention1 >= 0 && point.retention1 <= 1
      && point.retention7 >= 0 && point.retention7 <= 1
      && point.conservativeTargetRoi >= 2
    ))).toBe(true);
  });

  it("rejects LTV packages", () => {
    const roi = modelPackage(DEMO_COHORTS.filter((cohort) => cohort.mode === "roi" && cohort.observations.some((point) => point.day === 360)));
    const ltv = DEMO_COHORTS.find((cohort) => cohort.mode === "ltv_cac")!;
    const result = invertAssessmentStandards({ modelPackage: { ...roi, sourceSnapshots: [ltv] }, targetRoi: 1.37, targetDay: 360 });
    expect(result.status).toBe("unsupported");
  });
});
