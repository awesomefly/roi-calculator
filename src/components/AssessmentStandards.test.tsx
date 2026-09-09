import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RETENTION_DEMO_COHORTS } from "../domain/demoData";
import { equalWeightModelIds } from "../forecast/modelEligibility";
import { fitMultiCohortPackageSource } from "../forecast/multiCohortFit";
import type { ModelPackageV4 } from "../io/savedCurves";
import AssessmentStandards from "./AssessmentStandards";

function retentionPackage(): ModelPackageV4 {
  const fit = fitMultiCohortPackageSource(RETENTION_DEMO_COHORTS);
  return {
    version: 4, id: "retention-test", name: "留存模型包", createdAt: "2026-09-02T00:00:00.000Z",
    sourceSnapshots: fit.sources, roiObservationsByCohort: fit.observationsByCohort, models: fit.models,
    validModelIds: equalWeightModelIds(fit.models, true), evaluationMode: fit.evaluationMode,
    ensembleRule: "equal_valid_models", cohortWeightRule: "equal_valid_cohorts",
    ...(fit.retentionFit ? { retentionFit: fit.retentionFit } : {}),
  };
}

describe("assessment standards cards", () => {
  it("shows ROI baseline, final recommendation and error range with business labels", () => {
    render(<AssessmentStandards packages={[retentionPackage()]} onNavigateToFit={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "开始反推" }));
    expect(screen.getByText("首日 ROI")).toBeInTheDocument();
    expect(screen.getByText("7 日累计 ROI")).toBeInTheDocument();
    expect(screen.getAllByText(/ROI模型基准/)).toHaveLength(2);
    expect(screen.getAllByText(/最终推荐值/)).toHaveLength(2);
    expect(screen.getAllByText(/误差范围/)).toHaveLength(2);
    expect(screen.queryByText(/保守调整/)).not.toBeInTheDocument();
    const boundary = screen.getByRole("table", { name: "联合达标边界" });
    expect(boundary).toHaveTextContent("方案");
    expect(boundary).toHaveTextContent("D1 ROI");
    expect(boundary).toHaveTextContent("D7 ROI");
    expect(boundary).toHaveTextContent("次留");
    expect(boundary).toHaveTextContent("7留");
    expect(boundary).toHaveTextContent("D360 ROI保守下界");
    expect(screen.getByText("每行必须作为完整组合使用，不能跨方案拆分取值。")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "D1联合达标边界" })).not.toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "D7联合达标边界" })).not.toBeInTheDocument();
    expect(screen.getByText("历史范围内反推")).toBeInTheDocument();
  });
});
