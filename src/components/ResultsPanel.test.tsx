import { fireEvent, render, screen, within } from "@testing-library/react";
import { vi } from "vitest";
import type { AnalysisResult, ModelResult, Observation } from "../domain/types";
import ForecastChart from "./ForecastChart";
import ForecastTable from "./ForecastTable";
import ModelComparison from "./ModelComparison";
import RiskNotices from "./RiskNotices";
import SummaryCards from "./SummaryCards";

const models: ModelResult[] = [
  {
    id: "power",
    label: "幂函数模型",
    status: "ok",
    score: 0.12,
    backtestError: 0.08,
    predictions: [
      { day: 1, value: 0.1, lower: 0.08, upper: 0.12 },
      { day: 7, value: 0.3, lower: 0.25, upper: 0.35 },
      { day: 30, value: 0.8, lower: 0.7, upper: 0.9 },
      { day: 360, value: 1.5, lower: 1.3, upper: 1.7 },
    ],
  },
  {
    id: "logarithmic",
    label: "对数模型",
    status: "ok",
    score: 0.2,
    backtestError: 0.14,
    predictions: [
      { day: 1, value: 0.1 },
      { day: 7, value: 0.28 },
      { day: 30, value: 0.7 },
      { day: 360, value: 1.25 },
    ],
  },
  {
    id: "saturation",
    label: "饱和模型",
    status: "invalid",
    predictions: [],
    reason: "拟合未收敛。",
  },
  {
    id: "historical_multiplier",
    label: "历史倍率",
    status: "insufficient_data",
    predictions: [],
    reason: "至少需要 3 个成熟批次。",
  },
];

const successful: AnalysisResult = {
  subjectId: "a",
  models,
  selectedModelId: "power",
  roi360: 1.5,
  targetGap: 0.13,
  targetGapRatio: 0.13 / 1.37,
  targetDay: 270,
  reachesTarget: true,
  confidence: "medium",
  confidenceReasons: ["时间回测误差较低。"],
  warnings: ["成熟批次样本较少（3 个）。"],
};

describe("results summary", () => {
  it("shows a positive target margin for a reached target with its conclusion and payback day", () => {
    render(<SummaryCards result={successful} target={1.37} />);

    expect(screen.getByText("目标 ROI 1.370")).toBeInTheDocument();
    expect(screen.getByText("1.500")).toBeInTheDocument();
    expect(screen.getByText("目标差距")).toBeInTheDocument();
    expect(screen.getByText("+0.130")).toBeInTheDocument();
    expect(screen.getByText("+9.5%")).toBeInTheDocument();
    expect(screen.getByText("预计达标")).toBeInTheDocument();
    expect(screen.getByText("预计第 270 天达到目标")).toBeInTheDocument();
    expect(screen.getByText("幂函数模型")).toBeInTheDocument();
    expect(screen.getByText("中置信度")).toBeInTheDocument();
    expect(screen.getByText("时间回测误差较低。")).toBeInTheDocument();
  });

  it("shows a negative target margin when ROI360 is below the target", () => {
    render(<SummaryCards result={{ ...successful, roi360: 1.647, targetGap: -0.353, targetGapRatio: -0.353 / 2, targetDay: undefined, reachesTarget: false }} target={2} />);

    expect(screen.getByText("目标 ROI 2.000")).toBeInTheDocument();
    expect(screen.getByText("目标差距")).toBeInTheDocument();
    expect(screen.getByText("-0.353")).toBeInTheDocument();
    expect(screen.getByText("-17.7%")).toBeInTheDocument();
    expect(screen.getByText("预计未达标")).toBeInTheDocument();
    expect(screen.getByText("预计 360 天内无法达到目标")).toBeInTheDocument();
  });
});

describe("model comparison and preview", () => {
  it("keeps the automatic recommendation as the conclusion while previewing another usable model", () => {
    const onPreviewChange = vi.fn();
    render(<ModelComparison result={successful} previewModelId="logarithmic" onPreviewChange={onPreviewChange} />);

    expect(screen.getByText("自动推荐", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText(/业务结论始终基于自动推荐的幂函数模型/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /预览对数模型/ })).toBeChecked();
    expect(screen.getByText("得分 0.200")).toBeInTheDocument();
    expect(screen.getByText("回测误差 14.0%")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: /预览幂函数模型/ }));
    expect(onPreviewChange).toHaveBeenCalledWith("power");
  });

  it("shows failure and sample status as text and never makes failed models selectable", () => {
    render(<ModelComparison result={successful} previewModelId="saturation" onPreviewChange={vi.fn()} />);

    expect(screen.getByText("拟合失败")).toBeInTheDocument();
    expect(screen.getByText("样本不足")).toBeInTheDocument();
    expect(screen.getByText("拟合未收敛。")).toBeInTheDocument();
    expect(screen.getByText("至少需要 3 个成熟批次。")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /预览饱和模型/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /预览饱和模型/ })).not.toBeChecked();
  });
});

describe("forecast chart and table", () => {
  const observed: Observation[] = [{ day: 1, value: 0.1 }, { day: 7, value: 0.3 }];

  it("provides chart controls, target/reference semantics, interval status, and an accessible data table fallback", () => {
    render(<ForecastChart observed={observed} result={successful} target={1.37} previewModelId="power" />);

    expect(screen.getByText(/观测点 2 个/)).toBeInTheDocument();
    expect(screen.getByText(/含下限与上限预测区间/)).toBeInTheDocument();
    expect(screen.getByText(/目标线 ROI 1.370/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "显示其他可用模型" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "显示其他可用模型" }));
    expect(screen.getByText("对数模型对比曲线")).toBeInTheDocument();

    const fallback = screen.getByRole("table", { name: "图表数据" });
    expect(within(fallback).getByRole("columnheader", { name: "对数模型 ROI" })).toBeInTheDocument();
    const day360 = within(fallback).getByRole("cell", { name: "D360" }).closest("tr");
    expect(day360).not.toBeNull();
    expect(within(day360!).getByRole("cell", { name: "1.250" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "显示 ROI 1.0 参考线" }));
    expect(screen.getByText("ROI 1.0 参考线已显示")).toBeInTheDocument();

    expect(within(fallback).getByRole("columnheader", { name: "观测 ROI" })).toBeInTheDocument();
    expect(within(fallback).getByRole("columnheader", { name: "下限" })).toBeInTheDocument();
    expect(within(fallback).getByText("D360")).toBeInTheDocument();
  });

  it("extends the Y domain to keep an out-of-range target and optional ROI 1.0 reference line visible", () => {
    const lowModels: ModelResult[] = [{
      id: "power",
      label: "幂函数模型",
      status: "ok",
      predictions: [{ day: 1, value: 0.1 }, { day: 360, value: 0.5 }],
    }];
    const lowResult: AnalysisResult = { ...successful, models: lowModels, selectedModelId: "power", roi360: 0.5 };
    render(<ForecastChart observed={[{ day: 1, value: 0.1 }]} result={lowResult} target={0.4} previewModelId="power" />);

    const chart = screen.getByTestId("forecast-chart-export");
    expect(chart).toHaveAttribute("data-y-domain-max", "0.5");
    fireEvent.click(screen.getByRole("checkbox", { name: "显示 ROI 1.0 参考线" }));
    expect(chart).toHaveAttribute("data-y-domain-max", "1");
  });

  it("extends the Y domain to an out-of-range business target", () => {
    render(<ForecastChart observed={observed} result={successful} target={3.2} previewModelId="power" />);

    expect(screen.getByTestId("forecast-chart-export")).toHaveAttribute("data-y-domain-max", "3.2");
  });

  it("switches between key-day and daily forecast rows", () => {
    render(<ForecastTable result={successful} previewModelId="power" />);

    expect(screen.getByRole("button", { name: "关键日" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("cell", { name: "D360" })).toBeInTheDocument();
    expect(screen.queryByRole("cell", { name: "D2" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "逐日" }));
    expect(screen.getByRole("button", { name: "逐日" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("cell", { name: "D1" })).toBeInTheDocument();
  });
});

describe("risk notices", () => {
  it("surfaces unavailable intervals, insufficient historical samples, and other warnings", () => {
    render(<RiskNotices warnings={[
      "预测区间不可用：时间残差或跨模型证据不足。",
      "成熟批次不足：仅 2 个有效 D360 样本。",
      "模型分歧较大。",
    ]} />);

    expect(screen.getByText(/预测区间不可用/)).toBeInTheDocument();
    expect(screen.getByText(/成熟批次不足/)).toBeInTheDocument();
    expect(screen.getByText(/模型分歧较大/)).toBeInTheDocument();
  });
});
