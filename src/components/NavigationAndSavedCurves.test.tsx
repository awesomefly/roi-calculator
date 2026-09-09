import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import App from "../App";
import type { StorageAdapter } from "../io/storage";

function memoryStorage(): StorageAdapter {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

function csvFile(contents: string): File {
  const file = new File([contents], "current.csv", { type: "text/csv" });
  Object.defineProperty(file, "text", { value: async () => contents });
  return file;
}

function jsonFile(contents: string, name = "legacy.roi.json"): File {
  const file = new File([contents], name, { type: "application/json" });
  Object.defineProperty(file, "text", { value: async () => contents });
  return file;
}

describe("two-workspace navigation", () => {
  it("uses a navigation-only shell without the legacy header or clear action", () => {
    const { container } = render(<App storage={memoryStorage()} />);

    expect(screen.getByRole("navigation", { name: "主导航" })).toBeInTheDocument();
    expect(container.querySelector(".app-header")).toBeNull();
    expect(screen.queryByRole("button", { name: "清除本地数据" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "预估曲线拟合", level: 1 })).toBeInTheDocument();
    const localActions = screen.getByRole("group", { name: "本地数据操作" });
    expect(within(localActions).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "载入演示数据",
      "载入 ROI + 留存率演示数据",
      "导出数据到本地",
      "从本地导入数据",
    ]);
    expect(screen.queryByRole("region", { name: "本地项目文档" })).not.toBeInTheDocument();
  });

  it("keeps the native local-data file input hidden behind the import button", () => {
    render(<App storage={memoryStorage()} />);
    const localActions = screen.getByRole("group", { name: "本地数据操作" });

    expect(within(localActions).getAllByText("从本地导入数据")).toHaveLength(1);
    expect(within(localActions).getByLabelText("从本地导入数据", { selector: "input" })).not.toBeVisible();
  });

  it("shows local action feedback in the left status and clears it after 10 seconds", () => {
    vi.useFakeTimers();
    try {
      render(<App storage={memoryStorage()} downloadFile={vi.fn()} />);
      const localActions = screen.getByRole("group", { name: "本地数据操作" });
      fireEvent.click(within(localActions).getByRole("button", { name: "导出数据到本地" }));

      const status = within(localActions).getByRole("status", { name: "本地保存状态" });
      expect(within(localActions).getAllByRole("status")).toHaveLength(1);
      expect(status).toHaveTextContent("数据已导出到本地下载目录。");
      act(() => vi.advanceTimersByTime(9_999));
      expect(status).toHaveTextContent("数据已导出到本地下载目录。");
      act(() => vi.advanceTimersByTime(1));
      expect(status).toBeEmptyDOMElement();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the exact demo notice and automatically clears it", () => {
    vi.useFakeTimers();
    try {
      render(<App storage={memoryStorage()} />);
      const localActions = screen.getByRole("group", { name: "本地数据操作" });
      fireEvent.click(within(localActions).getByRole("button", { name: "载入演示数据" }));

      const status = within(localActions).getByRole("status", { name: "本地保存状态" });
      expect(status).toHaveTextContent("演示数据已加载");
      act(() => vi.advanceTimersByTime(80));
      act(() => vi.advanceTimersByTime(9_999));
      expect(status).toHaveTextContent("演示数据已加载");
      act(() => vi.advanceTimersByTime(1));
      expect(status).toBeEmptyDOMElement();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an old batch-CAC data file and preserves the current page state", async () => {
    render(<App storage={memoryStorage()} />);
    fireEvent.change(screen.getAllByLabelText("批次名称")[0]!, { target: { value: "当前批次" } });

    fireEvent.change(screen.getByLabelText("从本地导入数据", { selector: "input" }), {
      target: {
        files: [jsonFile(JSON.stringify({
          documentVersion: 2,
          project: { version: 2 },
          modelPackages: [],
        }))],
      },
    });

    await waitFor(() => expect(screen.getByRole("status", { name: "本地保存状态" }))
      .toHaveTextContent("本地数据版本不兼容，当前数据未更改。"));
    expect(screen.getAllByLabelText("批次名称")[0]).toHaveValue("当前批次");
  });

  it("keeps target outcome and payback content only in ROI estimation", () => {
    render(<App storage={memoryStorage()} />);
    expect(screen.queryByText("综合预估结论")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("目标 ROI")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "ROI 预估" }));
    expect(screen.getByRole("heading", { name: "ROI 预估", level: 1 })).toBeInTheDocument();
  });

  it("creates a model package in fitting and uses explicit ROI estimation", () => {
    render(<App storage={memoryStorage()} />);
    fireEvent.click(screen.getByRole("button", { name: "开始拟合" }));
    fireEvent.change(screen.getByLabelText("模型包名称"), { target: { value: "国内渠道基准" } });
    fireEvent.click(screen.getByRole("button", { name: "保存模型包" }));
    fireEvent.click(screen.getByRole("button", { name: "ROI 预估" }));

    expect(screen.getByLabelText("选择模型包")).toHaveDisplayValue(/国内渠道基准/);
    expect(screen.queryByText("综合预估结论")).not.toBeInTheDocument();
    const observationsTable = screen.getByRole("table", { name: "新批次观测数据" });
    expect(within(observationsTable).getAllByRole("columnheader")[0]).toHaveAccessibleName("序号");
    expect(within(observationsTable).getByRole("rowheader")).toHaveTextContent("1");
    fireEvent.change(screen.getByLabelText("第 1 行观测天数"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("D30 ROI"), { target: { value: "0.5" } });
    fireEvent.click(screen.getByRole("button", { name: "开始预估" }));
    expect(screen.getByRole("heading", { name: "综合预估结论" })).toBeInTheDocument();
    expect(screen.getByText(/有效模型 \d+ 个，全部参与多模型等权综合曲线/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "历史倍率" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "对数模型" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "幂函数模型" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "饱和模型" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查看对数模型原理" }));
    expect(screen.getByRole("region", { name: "对数模型原理说明" })).toHaveTextContent("首个真实观测点");

    fireEvent.change(screen.getByLabelText("目标 ROI"), { target: { value: "1.5" } });
    expect(screen.getByText("预估结果已过期，请重新预估")).toBeInTheDocument();
  });

  it("imports transient new-batch observations from CSV without saving an estimate record", async () => {
    render(<App storage={memoryStorage()} />);
    fireEvent.click(screen.getByRole("button", { name: "开始拟合" }));
    fireEvent.change(screen.getByLabelText("模型包名称"), { target: { value: "导入测试包" } });
    fireEvent.click(screen.getByRole("button", { name: "保存模型包" }));
    fireEvent.click(screen.getByRole("button", { name: "ROI 预估" }));

    fireEvent.click(screen.getByRole("button", { name: "导入 CSV" }));
    fireEvent.change(screen.getByLabelText("选择 CSV 文件"), {
      target: { files: [csvFile("batch,mode,spend,roi_30,roi_60\n当前批次,roi,,0.5,0.7")] },
    });

    await waitFor(() => expect(screen.getByLabelText("D30 ROI")).toHaveValue("0.5"));
    expect(screen.getByLabelText("D60 ROI")).toHaveValue("0.7");
    expect(screen.queryByText("综合预估结论")).not.toBeInTheDocument();
  });

  it("uses per-row CAC in ROI estimation and blocks a descending converted ROI", () => {
    render(<App storage={memoryStorage()} />);
    fireEvent.click(screen.getByRole("button", { name: "开始拟合" }));
    fireEvent.change(screen.getByLabelText("模型包名称"), { target: { value: "逐行 CAC 包" } });
    fireEvent.click(screen.getByRole("button", { name: "保存模型包" }));
    fireEvent.click(screen.getByRole("button", { name: "ROI 预估" }));
    fireEvent.click(screen.getByRole("radio", { name: "LTV + CAC" }));

    const table = screen.getByRole("table", { name: "新批次观测数据" });
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "序号", "天数", "累计 LTV", "CAC", "操作",
    ]);
    expect(screen.queryByLabelText(/^CAC$/u)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("第 1 行观测天数"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("D1 LTV"), { target: { value: "6.5" } });
    fireEvent.change(screen.getByLabelText("第 1 行 CAC"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "添加观测日" }));
    fireEvent.change(screen.getByLabelText("第 2 行观测天数"), { target: { value: "7" } });
    fireEvent.change(screen.getByLabelText("D7 LTV"), { target: { value: "12.4" } });
    fireEvent.change(screen.getByLabelText("第 2 行 CAC"), { target: { value: "20" } });

    expect(screen.getByRole("alert")).toHaveTextContent("D7 换算 ROI 0.62，低于 D1 的 0.65；累计 ROI 不允许下降。");
    expect(screen.getByLabelText("第 2 行 CAC").closest("tr")).toHaveClass("observation-row--error");
    expect(screen.getByRole("button", { name: "开始预估" })).toBeDisabled();
  });
});
