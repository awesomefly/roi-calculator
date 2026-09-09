import { describe, expect, it } from "vitest";
import type { AnalysisResult, Cohort } from "../domain/types";
import {
  createCsvBlob,
  createLtvTemplate,
  createRoiRetentionTemplate,
  createResultsCsv,
  createRoiTemplate,
  parseCohortCsv,
} from "./csv";

describe("cohort CSV", () => {
  it("round-trips an ROI + retention template with point-level retention values", () => {
    const template = createRoiRetentionTemplate();
    const result = parseCohortCsv(template);

    expect(result.issues).toEqual([]);
    expect(result.cohorts).toHaveLength(1);
    expect(result.cohorts[0]).toMatchObject({
      mode: "roi_retention",
      observations: expect.arrayContaining([
        { day: 1, value: 0.1, retention: 0.28 },
        { day: 7, value: 0.22, retention: 0.16 },
      ]),
    });
    expect(template.split(/\r?\n/u)[0]).toContain("roi_1,retention_1,roi_7,retention_7");
    expect(template).not.toContain("next_day_retention");
  });

  it("reports an out-of-range point retention on its exact CSV column", () => {
    const result = parseCohortCsv(
      "batch,mode,roi_1,retention_1,roi_7,retention_7\nA,roi_retention,0.1,28%,0.3,101%\n",
    );

    expect(result.cohorts).toEqual([]);
    expect(result.issues).toContainEqual({ row: 2, column: "retention_7", rawValue: "101%", message: "对应留存率必须是 0% 到 100% 之间的有限数字。" });
  });

  it("migrates legacy batch retention to D1 and D7 without overwriting point retention", () => {
    const result = parseCohortCsv(
      "batch,mode,next_day_retention,day_7_retention,roi_1,retention_1,roi_7\nA,roi_retention,28%,16%,0.1,30%,0.3\n",
    );

    expect(result.issues).toEqual([]);
    expect(result.cohorts[0]?.observations).toEqual([
      { day: 1, value: 0.1, retention: 0.3 },
      { day: 7, value: 0.3, retention: 0.16 },
    ]);
  });

  it("wraps CSV text in a browser-downloadable UTF-8 Blob", () => {
    const blob = createCsvBlob(createRoiTemplate());

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("text/csv;charset=utf-8");
  });

  it("imports ROI cohorts with percent values and blank late cells", () => {
    const result = parseCohortCsv(
      "batch,mode,spend,roi_1,roi_7,roi_360\n2026-01,roi,1200,12%,0.35,\n",
    );

    expect(result.issues).toEqual([]);
    expect(result.cohorts).toEqual([
      {
        id: "csv-row-2",
        name: "2026-01",
        mode: "roi",
        spend: 1200,
        observations: [
          { day: 1, value: 0.12 },
          { day: 7, value: 0.35 },
        ],
      },
    ]);
  });

  it("imports LTV/CAC cohorts and retains original LTV observations", () => {
    const result = parseCohortCsv(
      "cohort_name,mode,spend,ltv_1,cac_1,ltv_7,cac_7,ltv_360,cac_360\n2026-02,ltv_cac,3000,2.5,20,8,24,,\n",
    );

    expect(result.issues).toEqual([]);
    expect(result.cohorts).toEqual([
      {
        id: "csv-row-2",
        name: "2026-02",
        mode: "ltv_cac",
        spend: 3000,
        observations: [
          { day: 1, value: 2.5, cac: 20 },
          { day: 7, value: 8, cac: 24 },
        ],
      },
    ]);
  });

  it("reports malformed metric cells with their row, column, and raw value", () => {
    const result = parseCohortCsv(
      "batch,mode,spend,roi_1\n2026-03,roi,1000,  not-a-number  \n",
    );

    expect(result.cohorts).toEqual([]);
    expect(result.issues).toContainEqual({
      row: 2,
      column: "roi_1",
      rawValue: "  not-a-number  ",
      message: "必须是有限数字或百分比。",
    });
  });

  it("reports a mode-column mismatch without silently importing the row", () => {
    const result = parseCohortCsv(
      "batch,mode,spend,ltv_1,cac_1\n2026-04,roi,1000,2.5,20\n",
    );

    expect(result.cohorts).toEqual([]);
    expect(result.issues).toContainEqual({
      row: 2,
      column: "ltv_1",
      rawValue: "2.5",
      message: "ROI 模式只能使用 roi_天数 列。",
    });
  });

  it("round-trips template CSV through UTF-8 BOM-safe parsing", () => {
    const template = createRoiTemplate();
    const result = parseCohortCsv(template);

    expect(template.startsWith("\uFEFF")).toBe(true);
    expect(template).toContain("roi_1");
    expect(template).toContain("roi_360");
    expect(template.split(/\r?\n/u)[0]).not.toContain("spend");
    expect(result.issues).toEqual([]);
    expect(result.cohorts).toHaveLength(1);
    expect(result.cohorts[0]).toMatchObject({ mode: "roi" });
  });

  it("round-trips the LTV template without parser-specific comment handling", () => {
    const template = createLtvTemplate();
    const result = parseCohortCsv(template);

    expect(result.issues).toEqual([]);
    expect(result.cohorts).toHaveLength(1);
    expect(result.cohorts[0]).toMatchObject({ mode: "ltv_cac" });
    expect(result.cohorts[0]?.observations.every((observation) => "cac" in observation && observation.cac === 20)).toBe(true);
    expect(template.split(/\r?\n/u)[0]).not.toContain("spend");
  });

  it("imports a literal # batch name instead of treating it as a comment", () => {
    const result = parseCohortCsv("batch,mode,spend,roi_1\n#渠道A,roi,100,0.1\n");

    expect(result.issues).toEqual([]);
    expect(result.cohorts[0]).toMatchObject({ id: "csv-row-2", name: "#渠道A" });
  });

  it("assigns stable row-based IDs to accepted imports", () => {
    const result = parseCohortCsv(
      "batch,mode,spend,roi_1\nA,roi,100,0.1\nB,roi,200,0.2\n",
    );

    expect(result.cohorts.map((cohort) => cohort.id)).toEqual(["csv-row-2", "csv-row-3"]);
  });

  it("accepts multiple rows with blank spend for per-cohort analysis", () => {
    const result = parseCohortCsv(
      "batch,mode,spend,roi_1\nA,roi,,0.1\nB,roi,,0.2\n",
    );

    expect(result.issues).toEqual([]);
    expect(result.cohorts).toHaveLength(2);
    expect(result.cohorts.every((cohort) => cohort.spend === undefined)).toBe(true);
  });

  it.each([
    ["0", "0"],
    ["-12.5", "-12.5"],
    [" 0% ", " 0% "],
  ])("rejects a present non-positive spend %s with its exact raw cell", (cell, rawValue) => {
    const result = parseCohortCsv(`batch,mode,spend,roi_1\nA,roi,${cell},0.1\n`);

    expect(result.cohorts).toEqual([]);
    expect(result.issues).toContainEqual({
      row: 2,
      column: "spend",
      rawValue,
      message: "投放成本必须是大于 0 的有限数字。",
    });
  });

  it("reports duplicate names and non-positive row CAC from the exact source cells", () => {
    const result = parseCohortCsv(
      "batch,mode,spend,ltv_1,cac_1\n A ,ltv_cac,100,2,20\nA,ltv_cac,100,2, 0% \n",
    );

    expect(result.issues).toContainEqual({
      row: 3,
      column: "batch",
      rawValue: "A",
      message: "批次名称必须唯一。",
    });
    expect(result.issues).toContainEqual({
      row: 3,
      column: "cac_1",
      rawValue: " 0% ",
      message: "CAC 必须是大于 0 的有限数字。",
    });
  });

  it("reports every descending cumulative cell with exact percent/raw coordinates", () => {
    const result = parseCohortCsv(
      "batch,mode,spend,roi_1,roi_7,roi_15\nA,roi,,50%,40%, 0.3 \n",
    );

    expect(result.cohorts).toEqual([]);
    expect(result.repairableCohorts).toEqual([expect.objectContaining({
      name: "A",
      observations: [
        { day: 1, value: 0.5 },
        { day: 7, value: 0.4 },
        { day: 15, value: 0.3 },
      ],
    })]);
    expect(result.issues).toEqual(expect.arrayContaining([
      {
        row: 2,
        column: "roi_7",
        rawValue: "40%",
        message: "累计值不能下降。",
      },
      {
        row: 2,
        column: "roi_15",
        rawValue: " 0.3 ",
        message: "累计值不能下降。",
      },
    ]));
  });

  it("keeps physical CSV row coordinates after a multiline quoted field", () => {
    const result = parseCohortCsv(
      "batch,mode,spend,roi_1\n\"多行\n批次\",roi,100,0.1\n坏批次,roi,100,oops\n",
    );

    expect(result.issues).toContainEqual({
      row: 4,
      column: "roi_1",
      rawValue: "oops",
      message: "必须是有限数字或百分比。",
    });
  });

  it("accepts ROI and LTV/CAC rows in the same schema when each uses its own metric columns", () => {
    const result = parseCohortCsv(
      "batch,mode,spend,roi_1,ltv_1,cac_1\nROI 批次,roi,100,10%,,\nLTV 批次,ltv_cac,100,,4,20\n",
    );

    expect(result.issues).toEqual([]);
    expect(result.cohorts).toEqual([
      expect.objectContaining({ name: "ROI 批次", mode: "roi", observations: [{ day: 1, value: 0.1 }] }),
      expect.objectContaining({ name: "LTV 批次", mode: "ltv_cac", observations: [{ day: 1, value: 4, cac: 20 }] }),
    ]);
  });

  it("reports invalid metric-looking headers instead of ignoring them", () => {
    const result = parseCohortCsv("batch,mode,spend,roi_361,ltv_x\n批次,roi,100,,\n");

    expect(result.cohorts).toEqual([]);
    expect(result.issues).toContainEqual({
      row: 1,
      column: "roi_361",
      rawValue: "roi_361",
      message: "观测列天数必须是 1 到 360 的整数。",
    });
    expect(result.issues).toContainEqual({
      row: 1,
      column: "ltv_x",
      rawValue: "ltv_x",
      message: "观测列必须使用 roi_天数、retention_天数、ltv_天数 或 cac_天数 格式。",
    });
  });

  it("rejects duplicate metric headers before constructing cohorts", () => {
    const result = parseCohortCsv(
      "batch,mode,spend,roi_1,roi_1\nA,roi,100,0.1,0.2\n",
    );

    expect(result.cohorts).toEqual([]);
    expect(result.issues).toContainEqual({
      row: 1,
      column: "roi_1",
      rawValue: "roi_1",
      message: "观测列 roi_1 重复。",
    });
  });

  it("detects case-and-whitespace-normalized duplicate metric headers with raw context", () => {
    const result = parseCohortCsv(
      "batch,mode,spend, ltv_1 , LTV_1 ,cac_1\nA,ltv_cac,100,2,3,20\n",
    );

    expect(result.cohorts).toEqual([]);
    expect(result.issues).toContainEqual({
      row: 1,
      column: "ltv_1",
      rawValue: " LTV_1 ",
      message: "观测列 ltv_1 重复。",
    });
  });

  it("reports header-level schema issues at the physical header row after leading blank lines", () => {
    const result = parseCohortCsv("\n\nbatch,mode,spend,roi_361\n批次,roi,100,\n");

    expect(result.issues).toContainEqual({
      row: 3,
      column: "roi_361",
      rawValue: "roi_361",
      message: "观测列天数必须是 1 到 360 的整数。",
    });
  });

  it("returns structural CSV errors with physical row and source-row context", () => {
    const result = parseCohortCsv("batch,mode,spend,roi_1\n\"未闭合,roi,100,0.1");

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ row: 2, rawValue: expect.stringContaining("未闭合") }),
    ]));
  });

  it("creates a BOM-prefixed LTV template with the recommended day columns", () => {
    const template = createLtvTemplate();

    expect(template.startsWith("\uFEFF")).toBe(true);
    expect(template).toContain("ltv_1,cac_1,ltv_7,cac_7,ltv_15,cac_15");
    expect(template).toContain("示例批次");
    expect(template).not.toContain("\n# ");
  });

  it("rejects unpaired LTV and CAC day columns and legacy batch CAC", () => {
    const missingCac = parseCohortCsv("batch,mode,ltv_1,cac_1,ltv_7\nA,ltv_cac,2,20,6\n");
    expect(missingCac.issues).toContainEqual(expect.objectContaining({ row: 2, column: "cac_7", message: "ltv_7 必须配对 cac_7。" }));

    const missingLtv = parseCohortCsv("batch,mode,ltv_1,cac_1,cac_7\nA,ltv_cac,2,20,24\n");
    expect(missingLtv.issues).toContainEqual(expect.objectContaining({ row: 2, column: "ltv_7", message: "cac_7 必须配对 ltv_7。" }));

    const legacy = parseCohortCsv("batch,mode,cac,ltv_1\nA,ltv_cac,20,2\n");
    expect(legacy.issues).toContainEqual(expect.objectContaining({ row: 1, column: "cac", message: "旧版批次级 cac 列不再支持，请使用 cac_天数。" }));
  });

  it("reports converted ROI decline against the exact LTV source column", () => {
    const result = parseCohortCsv("batch,mode,ltv_1,cac_1,ltv_7,cac_7\nA,ltv_cac,6.5,10,12.4,20\n");

    expect(result.issues).toContainEqual({
      row: 2,
      column: "ltv_7",
      rawValue: "12.4",
      message: "D7 换算 ROI 0.62，低于 D1 的 0.65；累计 ROI 不允许下降。",
    });
    expect(result.repairableCohorts).toEqual([]);
  });
});

describe("results CSV", () => {
  it("apostrophe-escapes formula-like user cells and signed result cells", () => {
    const csv = createResultsCsv([{
      id: "danger",
      name: "=HYPERLINK(\"bad\")",
      mode: "roi",
      observations: [{ day: 7, value: 0.2 }],
    }], [{
      subjectId: "danger",
      models: [{ id: "power", label: "power", status: "invalid", predictions: [], reason: "@unsafe" }],
      roi360: 1.5,
      targetGap: 0.13,
      targetGapRatio: -0.1,
      reachesTarget: true,
      confidence: "low",
      confidenceReasons: ["+reason"],
      warnings: ["\tunsafe"],
    }]);

    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'@unsafe");
    expect(csv).toContain("'+0.13");
    expect(csv).toContain("'-0.1");
    expect(csv).toContain("'+reason");
    expect(csv).toContain("'\tunsafe");
  });

  it("exports original and ROI observations plus every model and selected-result summary", () => {
    const cohorts: Cohort[] = [
      {
        id: "cohort-a",
        name: "批次 A",
        mode: "ltv_cac",
        spend: 1000,
        observations: [{ day: 7, value: 8, cac: 20 }],
      },
    ];
    const results: AnalysisResult[] = [
      {
        subjectId: "cohort-a",
        selectedModelId: "power",
        roi360: 1.4,
        targetGap: 0.03,
        targetDay: 280,
        reachesTarget: true,
        confidence: "medium",
        warnings: ["样本有限"],
        models: [
          {
            id: "logarithmic",
            label: "对数",
            status: "ok",
            score: 0.2,
            predictions: [{ day: 360, value: 1.3 }],
          },
          {
            id: "power",
            label: "幂函数",
            status: "invalid",
            reason: "拟合失败",
            predictions: [],
          },
        ],
      },
    ];

    const csv = createResultsCsv(cohorts, results);

    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain("original_observation");
    expect(csv).toContain("roi_observation");
    expect(csv).toContain("logarithmic_roi360");
    expect(csv).toContain("power_status");
    expect(csv).toContain("logarithmic_backtest_error");
    expect(csv).toContain("power_reason");
    expect(csv).toContain("selected_model");
    expect(csv).toContain("target_gap");
    expect(csv).toContain("target_gap_ratio");
    expect(csv).toContain("reaches_target");
    expect(csv).toContain("样本有限");
    expect(csv).toContain("拟合失败");
    expect(csv).toContain("批次 A");
    expect(csv).toContain(",8,0.4,");
  });

  it("exports weighted aggregate as an explicit synthetic row with aggregate result fields", () => {
    const cohorts: Cohort[] = [{
      id: "cohort-a",
      name: "批次 A",
      mode: "roi",
      spend: 100,
      observations: [{ day: 1, value: 0.1 }],
    }];
    const aggregate: AnalysisResult = {
      subjectId: "aggregate",
      models: [{
        id: "power",
        label: "幂函数",
        status: "ok",
        score: 0.1,
        predictions: [{ day: 360, value: 1.6 }],
      }],
      selectedModelId: "power",
      roi360: 1.6,
      targetGap: 0.23,
      targetGapRatio: 0.23 / 1.37,
      targetDay: 250,
      reachesTarget: true,
      confidence: "high",
      warnings: ["汇总提示"],
    };

    const csv = createResultsCsv(cohorts, [aggregate], [{ day: 1, value: 0.1 }]);

    expect(csv).toContain("加权汇总,aggregate,100,,1,,0.1");
    expect(csv).toContain(",power,1.6,'+0.23,");
    expect(csv).toContain(",250,true,high,,汇总提示");
  });

  it("exports each aggregate day's actual contributors instead of total project spend", () => {
    const cohorts: Cohort[] = [
      { id: "a", name: "A", mode: "roi", spend: 100, observations: [{ day: 7, value: 0.4 }] },
      { id: "b", name: "B", mode: "roi", spend: 900, observations: [{ day: 30, value: 1.2 }] },
    ];
    const aggregate: AnalysisResult = {
      subjectId: "aggregate", models: [], reachesTarget: false, confidence: "low", warnings: [],
    };

    const csv = createResultsCsv(cohorts, [aggregate], [
      { day: 7, value: 0.4, contributorCount: 1, contributingSpend: 100 },
      { day: 30, value: 1.2, contributorCount: 1, contributingSpend: 900 },
    ]);

    expect(csv).toContain("加权汇总,aggregate,100,,7,,0.4,1,100");
    expect(csv).toContain("加权汇总,aggregate,900,,30,,1.2,1,900");
  });

  it("preserves negative signed target gaps for an unreached result", () => {
    const cohorts: Cohort[] = [{
      id: "below-target",
      name: "未达标批次",
      mode: "roi",
      spend: 100,
      observations: [{ day: 60, value: 0.65 }],
    }];
    const results: AnalysisResult[] = [{
      subjectId: "below-target",
      models: [],
      roi360: 1.647,
      targetGap: -0.353,
      targetGapRatio: -0.1765,
      reachesTarget: false,
      confidence: "low",
      warnings: [],
    }];

    const csv = createResultsCsv(cohorts, results);

    expect(csv).toContain(",1.647,'-0.353,'-0.1765,,false,low,");
  });
});
