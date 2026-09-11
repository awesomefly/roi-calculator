import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DEMO_COHORTS } from "../domain/demoData";
import type { ModelPackageV4 } from "../io/savedCurves";
import { cohortToDraft, type CohortDraft } from "./CohortEditor";
import FitWorkspace, { cohortFromDraft } from "./FitWorkspace";

function Harness(): JSX.Element {
  const [drafts, setDrafts] = useState<CohortDraft[]>([cohortToDraft(DEMO_COHORTS[0]!)]);
  const [packages, setPackages] = useState<ModelPackageV4[]>([]);
  return <FitWorkspace drafts={drafts} packages={packages} onDraftsChange={setDrafts} onSavePackage={(item) => {
    setPackages((current) => [...current, item]);
    return true;
  }} onDeletePackage={vi.fn()} downloadFile={vi.fn()} />;
}

function LtvHarness({ descending = false }: { descending?: boolean }): JSX.Element {
  const initial = cohortToDraft({
    id: "ltv-source",
    name: "LTV 来源",
    mode: "ltv_cac",
    observations: descending
      ? [{ day: 1, value: 6.5, cac: 10 }, { day: 7, value: 12.4, cac: 20 }]
      : [{ day: 1, value: 2, cac: 20 }, { day: 7, value: 6, cac: 24 }],
  });
  const [drafts, setDrafts] = useState<CohortDraft[]>([initial]);
  return <FitWorkspace drafts={drafts} packages={[]} onDraftsChange={setDrafts} onSavePackage={vi.fn(() => true)} onDeletePackage={vi.fn()} downloadFile={vi.fn()} />;
}

function MultiHarness(): JSX.Element {
  const [drafts, setDrafts] = useState<CohortDraft[]>(DEMO_COHORTS.slice(0, 2).map(cohortToDraft));
  return <FitWorkspace drafts={drafts} packages={[]} onDraftsChange={setDrafts} onSavePackage={vi.fn(() => true)} onDeletePackage={vi.fn()} downloadFile={vi.fn()} />;
}

describe("fit workspace", () => {
  it("explains the recommended batch and observation counts for every input mode", () => {
    render(<Harness />);

    const trigger = screen.getByRole("button", { name: "查看历史数据量建议" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: "历史数据量建议" })).not.toBeInTheDocument();

    fireEvent.click(trigger);

    const guidance = screen.getByRole("region", { name: "历史数据量建议" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(guidance).toHaveTextContent("ROI：建议至少 5 批，每批至少 6 条观测，尽量包含 D360。");
    expect(guidance).toHaveTextContent("ROI + 留存率：建议至少 5 个成熟批次，合计至少 20 条有效观测；留存率至少覆盖 3 个不同观测日（如 D1、D7、D30）。");
    expect(guidance).toHaveTextContent("若要启用单调样条模型，建议 30 批、100 条观测，并覆盖 4 个不同留存观测日。");
    expect(guidance).toHaveTextContent("LTV + CAC：建议至少 5 批，每批至少 6 条观测；每条需同时填写 LTV 和 CAC。");

    fireEvent.click(trigger);
    expect(screen.queryByRole("region", { name: "历史数据量建议" })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("region", { name: "历史数据量建议" })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "历史数据量建议" })).not.toBeInTheDocument();
  });

  it("shows the ensemble curve toggle after fitting in all three input modes", () => {
    const roi = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "开始拟合" }));
    expect(screen.getByRole("checkbox", { name: "多模型等权综合曲线" })).toBeChecked();
    roi.unmount();

    const retention = render(<Harness />);
    fireEvent.click(screen.getByRole("radio", { name: "ROI + 留存率" }));
    fireEvent.click(screen.getByRole("button", { name: "开始拟合" }));
    expect(screen.getByRole("checkbox", { name: "多模型等权综合曲线" })).toBeChecked();
    retention.unmount();

    render(<LtvHarness />);
    fireEvent.click(screen.getByRole("button", { name: "开始拟合" }));
    expect(screen.getByRole("checkbox", { name: "多模型等权综合曲线" })).toBeChecked();
  });

  it("accepts ROI + 留存率 as a third fitting mode with point retention", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("radio", { name: "ROI + 留存率" }));
    fireEvent.change(screen.getByLabelText("D1 对应留存率"), { target: { value: "28%" } });
    fireEvent.change(screen.getByLabelText("D7 对应留存率"), { target: { value: "0.16" } });

    expect(screen.getByRole("button", { name: "开始拟合" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "开始拟合" }));
    expect(screen.getByRole("heading", { name: "拟合结果" })).toBeInTheDocument();
  });

  it("allows missing point retention but blocks an entered value above 100%", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("radio", { name: "ROI + 留存率" }));

    expect(screen.getByRole("button", { name: "开始拟合" })).toBeEnabled();

    fireEvent.change(screen.getByLabelText("D1 对应留存率"), { target: { value: "101%" } });
    expect(screen.getByRole("alert")).toHaveTextContent("对应留存率必须是 0% 到 100% 之间的有限数字。");
    expect(screen.getByRole("button", { name: "开始拟合" })).toBeDisabled();
  });

  it("drops legacy spend from a new single-cohort fit source", () => {
    const prepared = cohortFromDraft(cohortToDraft(DEMO_COHORTS[0]!));

    expect(prepared.cohort).toBeDefined();
    expect(prepared.cohort).not.toHaveProperty("spend");
  });

  it("does not fit until the user explicitly starts fitting", () => {
    render(<Harness />);
    expect(screen.queryByRole("heading", { name: "拟合结果" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "开始拟合" }));
    expect(screen.getByRole("heading", { name: "拟合结果" })).toBeInTheDocument();
    expect(screen.getByText(/有效模型 \d+ 个/)).toBeInTheDocument();
  });

  it("keeps the observation error table in each successful cohort fit detail", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "开始拟合" }));

    const modelCard = screen.getByRole("heading", { name: "对数模型" }).closest("article");
    expect(modelCard).not.toBeNull();
    fireEvent.click(within(modelCard as HTMLElement).getByText("逐批次拟合明细"));

    const table = within(modelCard as HTMLElement).getByRole("table", { name: /误差明细/u });
    expect(within(table).getByRole("columnheader", { name: "观测日" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "真实 ROI" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "拟合 ROI" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "绝对误差" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "相对误差" })).toBeInTheDocument();
  });

  it("adds and removes historical cohorts while keeping the final cohort", () => {
    render(<Harness />);
    expect(screen.getByRole("group", { name: "批次 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /删除批次/ })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "添加批次" }));
    expect(screen.getAllByLabelText("批次名称")).toHaveLength(2);
    expect(screen.getByRole("group", { name: "批次 2" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除批次 批次 2" }));

    expect(screen.getAllByLabelText("批次名称")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /删除批次/ })).toBeDisabled();
  });

  it("defaults multi-cohort results to the aggregate view with five model choices", () => {
    render(<MultiHarness />);
    fireEvent.click(screen.getByRole("button", { name: "开始拟合" }));

    expect(screen.getByRole("radio", { name: "批次综合曲线" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "历史倍率" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "对数模型" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "幂函数模型" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "饱和模型" })).toBeInTheDocument();
    expect(screen.getAllByText(/有效批次 2\/2/)).toHaveLength(4);
  });

  it("expands and collapses an accessible principle explanation for each model", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "开始拟合" }));

    expect(screen.getByRole("button", { name: "查看历史倍率原理" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "查看对数模型原理" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看幂函数模型原理" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看饱和模型原理" })).toBeInTheDocument();

    const trigger = screen.getByRole("button", { name: "查看历史倍率原理" });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("region", { name: "历史倍率原理说明" })).toHaveTextContent("真实 D360");

    fireEvent.click(trigger);
    expect(screen.queryByRole("region", { name: "历史倍率原理说明" })).not.toBeInTheDocument();
  });

  it("marks a completed fit stale after an input edit and blocks saving", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "开始拟合" }));
    fireEvent.change(screen.getByLabelText("批次名称"), { target: { value: "已修改批次" } });

    expect(screen.getByText("拟合结果已过期，请重新拟合")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存模型包" })).toBeDisabled();
  });

  it("saves same-name model packages as new timestamped versions", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "开始拟合" }));
    fireEvent.change(screen.getByLabelText("模型包名称"), { target: { value: "渠道基准" } });
    fireEvent.click(screen.getByRole("button", { name: "保存模型包" }));
    fireEvent.click(screen.getByRole("button", { name: "保存模型包" }));

    expect(screen.getAllByText("渠道基准")).toHaveLength(2);
  });

  it("restores the saved observations and fit results when viewing a model package", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "开始拟合" }));
    fireEvent.change(screen.getByLabelText("模型包名称"), { target: { value: "渠道历史模型" } });
    fireEvent.click(screen.getByRole("button", { name: "保存模型包" }));

    fireEvent.change(screen.getByLabelText("批次名称"), { target: { value: "未保存的新输入" } });
    expect(screen.getByText("拟合结果已过期，请重新拟合")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查看模型包 渠道历史模型" }));

    expect(screen.getByLabelText("批次名称")).toHaveValue("成熟 ROI 批次 A（高投入）");
    expect(screen.getByLabelText("第 1 行观测天数")).toHaveValue("1");
    expect(screen.getByLabelText("D1 ROI")).toHaveValue("0.1");
    expect(screen.queryByText("拟合结果已过期，请重新拟合")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "拟合结果" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("已加载模型包“渠道历史模型”");
  });

  it("renders CAC on every LTV observation row and no batch-level CAC", () => {
    render(<LtvHarness />);

    expect(screen.queryByLabelText(/^CAC$/u)).not.toBeInTheDocument();
    expect(screen.getByLabelText("第 1 行 CAC")).toHaveValue("20");
    expect(screen.getByLabelText("第 2 行 CAC")).toHaveValue("24");
    expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "序号", "天数", "累计 LTV", "CAC", "操作",
    ]);
  });

  it("highlights the row and blocks fitting when converted cumulative ROI decreases", () => {
    render(<LtvHarness descending />);

    expect(screen.getByRole("alert")).toHaveTextContent("D7 换算 ROI 0.62，低于 D1 的 0.65；累计 ROI 不允许下降。");
    expect(screen.getByLabelText("第 2 行 CAC").closest("tr")).toHaveClass("observation-row--error");
    expect(screen.getByRole("button", { name: "开始拟合" })).toBeDisabled();
  });
});
