import { fireEvent, render, screen } from "@testing-library/react";
import App from "./App";
import { DEMO_COHORTS, RETENTION_DEMO_COHORTS } from "./domain/demoData";
import { cohortToRoi } from "./validation/normalize";

describe("App", () => {
  it("renders a workspace title and local-only privacy notice without the legacy product header", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "预估曲线拟合", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("本地计算，数据不上传")).toBeInTheDocument();
  });

  it("keeps every demo LTV observation independently costed and ROI-monotonic", () => {
    const ltvCohorts = DEMO_COHORTS.filter((cohort) => cohort.mode === "ltv_cac");

    expect(ltvCohorts.length).toBeGreaterThan(0);
    ltvCohorts.forEach((cohort) => {
      expect(cohort.observations.every((observation) => Number.isFinite(observation.cac) && observation.cac > 0)).toBe(true);
      const values = cohortToRoi(cohort).map((observation) => observation.value);
      expect(values.every((value, index) => index === 0 || value >= values[index - 1]! - 1e-12)).toBe(true);
    });
  });

  it("provides five mature benchmark-inspired retention cohorts", () => {
    expect(RETENTION_DEMO_COHORTS).toHaveLength(5);
    expect(RETENTION_DEMO_COHORTS.every((cohort) => cohort.mode === "roi_retention" && cohort.observations.some((point) => point.day === 360))).toBe(true);
    expect(RETENTION_DEMO_COHORTS.flatMap((cohort) => cohort.observations.filter((point) => "retention" in point && point.retention !== undefined))).toHaveLength(30);
    expect(RETENTION_DEMO_COHORTS.every((cohort) => cohort.observations.every((point) => "retention" in point && point.retention !== undefined))).toBe(true);
  });

  it("loads the dedicated ROI + retention demo without extra title copy", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "载入 ROI + 留存率演示数据" }));

    expect(screen.getAllByRole("radio", { name: "ROI + 留存率" }).every((item) => (item as HTMLInputElement).checked)).toBe(true);
    expect(screen.queryByText(/用一个或多个历史批次生成/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/公开行业基准启发的合成数据/u)).not.toBeInTheDocument();
  });
});
