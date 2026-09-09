import type { Cohort } from "./types";

/** Built-in cohorts are cumulative and intentionally span different spend weights. */
export const DEMO_COHORTS: Cohort[] = [
  {
    id: "mature-roi-q1",
    name: "成熟 ROI 批次 A（高投入）",
    mode: "roi",
    spend: 32_000,
    observations: [
      { day: 1, value: 0.1 }, { day: 7, value: 0.25 }, { day: 15, value: 0.36 },
      { day: 30, value: 0.46 }, { day: 60, value: 0.65 }, { day: 90, value: 0.9 },
      { day: 120, value: 1.05 }, { day: 180, value: 1.2 }, { day: 360, value: 1.6 },
    ],
  },
  {
    id: "mature-ltv-q2",
    name: "成熟 LTV/CAC 批次 B（中投入）",
    mode: "ltv_cac",
    spend: 15_000,
    observations: [
      { day: 1, value: 2, cac: 20 }, { day: 7, value: 5, cac: 20 }, { day: 15, value: 7, cac: 20 },
      { day: 30, value: 9, cac: 20 }, { day: 60, value: 13, cac: 20 }, { day: 90, value: 17, cac: 20 },
      { day: 120, value: 20, cac: 20 }, { day: 180, value: 25, cac: 20 }, { day: 360, value: 31, cac: 20 },
    ],
  },
  {
    id: "mature-roi-q3",
    name: "成熟 ROI 批次 C（低投入）",
    mode: "roi",
    spend: 8_000,
    observations: [
      { day: 1, value: 0.11 }, { day: 7, value: 0.28 }, { day: 15, value: 0.38 },
      { day: 30, value: 0.52 }, { day: 60, value: 0.72 }, { day: 90, value: 0.94 },
      { day: 120, value: 1.12 }, { day: 180, value: 1.38 }, { day: 360, value: 1.72 },
    ],
  },
  {
    id: "active-roi-current",
    name: "进行中 ROI 批次（截至 D60）",
    mode: "roi",
    spend: 5_000,
    observations: [
      { day: 1, value: 0.09 }, { day: 7, value: 0.22 }, { day: 15, value: 0.31 },
      { day: 30, value: 0.43 }, { day: 60, value: 0.62 },
    ],
  },
];

export const demoCohorts = DEMO_COHORTS;

/** Public-benchmark-inspired synthetic data; not a single advertiser's real cohorts. */
export const RETENTION_DEMO_COHORTS: Cohort[] = [
  ["retention-demo-a", "留存演示 A｜基准型", [0.10, 0.27, 0.48, 0.67, 1.08, 1.48], [0.26, 0.13, 0.07, 0.048, 0.025, 0.018]],
  ["retention-demo-b", "留存演示 B｜高留存", [0.11, 0.31, 0.56, 0.76, 1.22, 1.67], [0.30, 0.16, 0.09, 0.064, 0.036, 0.026]],
  ["retention-demo-c", "留存演示 C｜低留存", [0.09, 0.23, 0.41, 0.57, 0.91, 1.25], [0.22, 0.10, 0.05, 0.033, 0.017, 0.012]],
  ["retention-demo-d", "留存演示 D｜前置收入", [0.13, 0.34, 0.57, 0.74, 1.09, 1.40], [0.27, 0.14, 0.075, 0.051, 0.027, 0.019]],
  ["retention-demo-e", "留存演示 E｜长尾收入", [0.08, 0.22, 0.43, 0.62, 1.15, 1.72], [0.28, 0.145, 0.08, 0.056, 0.031, 0.023]],
].map(([id, name, roi, retention]) => ({
  id: id as string, name: name as string, mode: "roi_retention" as const,
  observations: [1, 7, 30, 60, 180, 360].map((day, index) => ({
    day, value: (roi as number[])[index]!, retention: (retention as number[])[index]!,
  })),
}));
