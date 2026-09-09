import { describe, expect, it } from "vitest";
import { parseObservationRows, type ObservationRowDraft } from "./observationRows";

const rows = (...values: Array<Partial<ObservationRowDraft>>): ObservationRowDraft[] => values.map((value, index) => ({
  id: `row-${index + 1}`,
  day: "",
  value: "",
  cac: "",
  retention: "",
  ...value,
}));

describe("parseObservationRows", () => {
  it("parses ROI rows and ignores only completely empty rows", () => {
    const result = parseObservationRows(rows(
      { day: "7", value: "0.25" },
      {},
      { day: "1", value: "10%" },
    ), "roi");

    expect(result.issues).toEqual([]);
    expect(result.sourceObservations).toEqual([{ day: 1, value: 0.1 }, { day: 7, value: 0.25 }]);
    expect(result.roiObservations).toEqual(result.sourceObservations);
  });

  it("parses a retention value on each ROI observation", () => {
    const result = parseObservationRows(rows(
      { day: "1", value: "10%", retention: "28%" },
      { day: "7", value: "0.25", retention: "0.16" },
    ), "roi_retention");

    expect(result.issues).toEqual([]);
    expect(result.sourceObservations).toEqual([
      { day: 1, value: 0.1, retention: 0.28 },
      { day: 7, value: 0.25, retention: 0.16 },
    ]);
  });

  it.each(["-1%", "101%", "1.01", "NaN", "Infinity"])("reports invalid point retention %p on its row", (retention) => {
    const result = parseObservationRows(rows({ day: "1", value: "0.1", retention }), "roi_retention");

    expect(result.issues).toContainEqual({
      rowId: "row-1",
      field: "retention",
      message: "对应留存率必须是 0% 到 100% 之间的有限数字。",
    });
  });

  it("converts every LTV row with its own CAC", () => {
    const result = parseObservationRows(rows(
      { day: "7", value: "6", cac: "24" },
      { day: "1", value: "2", cac: "20" },
    ), "ltv_cac");

    expect(result.issues).toEqual([]);
    expect(result.sourceObservations).toEqual([
      { day: 1, value: 2, cac: 20 },
      { day: 7, value: 6, cac: 24 },
    ]);
    expect(result.roiObservations).toEqual([{ day: 1, value: 0.1 }, { day: 7, value: 0.25 }]);
  });

  it.each(["", "0", "-1", "NaN", "Infinity"])("reports invalid CAC %p on its row", (cac) => {
    const result = parseObservationRows(rows({ day: "1", value: "2", cac }), "ltv_cac");

    expect(result.issues).toContainEqual(expect.objectContaining({
      rowId: "row-1",
      field: "cac",
      message: "CAC 必须是大于 0 的有限数字。",
    }));
  });

  it("reports missing fields on a partially populated row", () => {
    const result = parseObservationRows(rows({ day: "7" }), "ltv_cac");

    expect(result.issues.map((issue) => issue.field)).toEqual(expect.arrayContaining(["value", "cac"]));
  });

  it("reports duplicate and out-of-range days", () => {
    const result = parseObservationRows(rows(
      { day: "361", value: "1", cac: "10" },
      { day: "7", value: "1", cac: "10" },
      { day: "7", value: "2", cac: "10" },
    ), "ltv_cac");

    expect(result.issues.filter((issue) => issue.field === "day")).toHaveLength(2);
  });

  it("blocks decreasing cumulative LTV", () => {
    const result = parseObservationRows(rows(
      { day: "1", value: "8", cac: "20" },
      { day: "7", value: "6", cac: "10" },
    ), "ltv_cac");

    expect(result.issues).toContainEqual(expect.objectContaining({ rowId: "row-2", field: "value", message: "累计值不能下降。" }));
  });

  it("blocks decreasing converted cumulative ROI with a business-specific row error", () => {
    const result = parseObservationRows(rows(
      { day: "1", value: "6.5", cac: "10" },
      { day: "7", value: "12.4", cac: "20" },
    ), "ltv_cac");

    expect(result.issues).toContainEqual({
      rowId: "row-2",
      field: "roi",
      message: "D7 换算 ROI 0.62，低于 D1 的 0.65；累计 ROI 不允许下降。",
    });
  });

  it("allows sub-epsilon floating noise", () => {
    const result = parseObservationRows(rows(
      { day: "1", value: "1", cac: "1" },
      { day: "7", value: "1.999999999999", cac: "2" },
    ), "ltv_cac");

    expect(result.issues.find((issue) => issue.field === "roi")).toBeUndefined();
  });
});
