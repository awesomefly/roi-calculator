import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";
import App from "../App";
import { PROJECT_STORAGE_KEY, type StorageAdapter } from "../io/storage";

function memoryStorage(options: {
  failOnSave?: boolean;
  failOnRead?: boolean;
  initial?: Record<string, string>;
} = {}): StorageAdapter & { values: Map<string, string> } {
  const values = new Map<string, string>(Object.entries(options.initial ?? {}));
  return {
    values,
    getItem: (key) => {
      if (options.failOnRead) throw new Error("storage blocked");
      return values.get(key) ?? null;
    },
    setItem: (key, value) => {
      if (options.failOnSave) throw new Error("storage full");
      values.set(key, value);
    },
    removeItem: (key) => { values.delete(key); },
  };
}

function csvFile(contents: string): File {
  const file = new File([contents], "cohort.csv", { type: "text/csv" });
  Object.defineProperty(file, "text", { value: async () => contents });
  return file;
}

describe("historical cohort input", () => {
  it("starts with an empty status and reports demo data only after explicit loading", () => {
    render(<App storage={memoryStorage()} />);

    expect(screen.getAllByLabelText("批次名称")).toHaveLength(3);
    expect(screen.queryByLabelText("投放成本")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "本地保存状态" })).toBeEmptyDOMElement();
    expect(screen.queryByText("演示数据")).not.toBeInTheDocument();
    expect(screen.queryByText("拟合结果")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("目标 ROI")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "载入演示数据" }));
    expect(screen.getByRole("status", { name: "本地保存状态" })).toHaveTextContent("演示数据已加载");
    fireEvent.click(screen.getByRole("button", { name: "开始拟合" }));
    expect(screen.getByText("拟合结果")).toBeInTheDocument();
  });

  it("preserves ROI and LTV + CAC source drafts and restores them from local storage", async () => {
    const storage = memoryStorage();
    const first = render(<App storage={storage} />);
    fireEvent.change(screen.getAllByLabelText("D1 ROI")[0]!, { target: { value: "15%" } });
    fireEvent.click(screen.getAllByRole("radio", { name: "LTV + CAC" })[0]!);
    fireEvent.change(screen.getAllByLabelText("第 1 行 CAC")[0]!, { target: { value: "20" } });
    fireEvent.change(screen.getAllByLabelText("D1 LTV")[0]!, { target: { value: "2.5" } });
    await waitFor(() => expect(screen.getByRole("status", { name: "本地保存状态" })).toHaveTextContent("已保存到本地缓存"));
    first.unmount();

    render(<App storage={storage} />);
    expect(screen.getByRole("status", { name: "本地保存状态" })).toBeEmptyDOMElement();
    expect(screen.getAllByLabelText("第 1 行 CAC")[0]!).toHaveValue("20");
    expect(screen.getAllByLabelText("D1 LTV")[0]!).toHaveValue("2.5");
    fireEvent.click(screen.getAllByRole("radio", { name: "ROI" })[0]!);
    expect(screen.getAllByLabelText("D1 ROI")[0]!).toHaveValue("15%");
  });

  it("supports arbitrary observation days and rejects D361", () => {
    render(<App storage={memoryStorage()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "添加观测日" })[0]!);
    const dayInputs = screen.getAllByLabelText(/观测天数/u);
    const added = dayInputs[dayInputs.length - 1]!;
    fireEvent.change(added, { target: { value: "45" } });
    expect(screen.getAllByLabelText("D45 ROI")[0]!).toBeInTheDocument();
    fireEvent.change(added, { target: { value: "361" } });
    expect(screen.getByText("天数必须为 D1 到 D360 且不能重复。")).toBeInTheDocument();
  });

  it("captures retention beside each ROI observation in ROI + retention mode", () => {
    render(<App storage={memoryStorage()} />);
    fireEvent.click(screen.getAllByRole("radio", { name: "ROI + 留存率" })[0]!);

    expect(screen.queryByLabelText("次留")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("7留")).not.toBeInTheDocument();
    const retention = screen.getAllByLabelText("D1 对应留存率")[0]!;
    fireEvent.change(retention, { target: { value: "101%" } });
    expect(screen.getByText("对应留存率必须是 0% 到 100% 之间的有限数字。")).toBeInTheDocument();
    fireEvent.change(retention, { target: { value: "28%" } });
    expect(screen.queryByText("对应留存率必须是 0% 到 100% 之间的有限数字。")).not.toBeInTheDocument();
  });

  it("places observation sequence numbers in the left column and renumbers rows after deletion", () => {
    render(<App storage={memoryStorage()} />);
    const table = screen.getByRole("table", { name: /成熟 ROI 批次 A.*的观测数据/u });

    expect(within(table).getAllByRole("columnheader")[0]).toHaveAccessibleName("序号");
    const firstRow = within(table).getAllByRole("row")[1]!;
    expect(within(firstRow).getByRole("rowheader")).toHaveTextContent("1");
    expect(within(firstRow).getByLabelText("第 1 行观测天数")).toHaveValue("1");

    fireEvent.click(within(firstRow).getByRole("button", { name: "删除 D1 观测" }));
    const renumberedFirstRow = within(table).getAllByRole("row")[1]!;
    expect(within(renumberedFirstRow).getByRole("rowheader")).toHaveTextContent("1");
    expect(within(renumberedFirstRow).getByLabelText("第 1 行观测天数")).toHaveValue("7");
  });

  it("replaces all cohorts from a confirmed CSV import and reports row-specific errors", async () => {
    const confirmClear = vi.fn(() => true);
    render(<App storage={memoryStorage()} confirmClear={confirmClear} />);
    fireEvent.click(screen.getByRole("button", { name: "导入 CSV" }));
    fireEvent.change(screen.getByLabelText("选择 CSV 文件"), {
      target: { files: [csvFile("batch,mode,spend,roi_1,roi_7\n导入批次,roi,900,10%,0.3")] },
    });
    await waitFor(() => expect(screen.getAllByLabelText("批次名称")).toHaveLength(1));
    expect(confirmClear).toHaveBeenCalled();
    expect(screen.getByLabelText("批次名称")).toHaveValue("导入批次");
    expect(screen.getByLabelText("D1 ROI")).toHaveValue("0.1");

    fireEvent.click(screen.getByRole("button", { name: "导入 CSV" }));
    const source = "batch,mode,spend,roi_1\n坏批次,roi,900,oops";
    fireEvent.change(screen.getByLabelText("选择 CSV 文件"), { target: { files: [csvFile(source)] } });
    const dialog = await screen.findByRole("dialog", { name: "导入 CSV" });
    expect(within(dialog).getByText(/第 2 行.*roi_1/u)).toBeInTheDocument();
    expect(within(dialog).getByLabelText("CSV 源内容")).toHaveValue(source);
  });

  it("downloads input templates but exposes no clear-data or result-export action", () => {
    const downloadFile = vi.fn();
    render(<App storage={memoryStorage()} downloadFile={downloadFile} />);
    fireEvent.click(screen.getByRole("button", { name: "下载 ROI 模板" }));
    fireEvent.click(screen.getByRole("button", { name: "下载 LTV + CAC 模板" }));
    expect(downloadFile.mock.calls.map((call) => call[1])).toEqual([
      "roi-import-template.csv",
      "ltv-cac-import-template.csv",
    ]);
    expect(screen.queryByRole("button", { name: "清除本地数据" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "导出结果 CSV" })).not.toBeInTheDocument();
  });

  it("reports local storage failures without crashing", async () => {
    render(<App storage={memoryStorage({ failOnSave: true })} />);
    fireEvent.change(screen.getAllByLabelText("批次名称")[0]!, { target: { value: "保存失败批次" } });
    await waitFor(() => expect(screen.getByRole("status", { name: "本地保存状态" })).toHaveTextContent("本地保存失败"));
    cleanup();

    expect(() => render(<App storage={memoryStorage({ failOnRead: true })} />)).not.toThrow();
    expect(screen.getByRole("status", { name: "本地保存状态" })).toHaveTextContent("本地读取失败");
  });

  it("protects corrupted local data and offers a recovery download", () => {
    const downloadFile = vi.fn();
    const storage = memoryStorage({ initial: { [PROJECT_STORAGE_KEY]: "{bad json" } });
    render(<App storage={storage} downloadFile={downloadFile} />);
    expect(screen.getByRole("alert", { name: "本地暂存数据无法读取" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下载原始本地数据" }));
    expect(downloadFile).toHaveBeenCalledWith(expect.any(Blob), "roi-forecast-recovery.json");
  });

  it("rejects a V2 batch-CAC cache without replacing it or loading demo data", () => {
    const raw = JSON.stringify({
      version: 2,
      cohort: {
        id: "legacy-ltv",
        name: "旧版 LTV 批次",
        mode: "ltv_cac",
        cac: 20,
        observations: [{ day: 1, value: 2 }],
      },
    });
    const downloadFile = vi.fn();
    const storage = memoryStorage({ initial: { [PROJECT_STORAGE_KEY]: raw } });

    render(<App storage={storage} downloadFile={downloadFile} />);

    expect(screen.getByLabelText("批次名称")).toHaveValue("批次 1");
    expect(screen.getByRole("status", { name: "本地保存状态" })).toHaveTextContent("本地数据版本不兼容");
    expect(screen.getByRole("alert", { name: "本地暂存数据无法读取" })).toBeInTheDocument();
    expect(storage.values.get(PROJECT_STORAGE_KEY)).toBe(raw);

    fireEvent.click(screen.getByRole("button", { name: "下载原始本地数据" }));
    expect(downloadFile).toHaveBeenCalledWith(expect.any(Blob), "roi-forecast-recovery.json");
  });
});
