import { expect, test, type Download, type Page } from "@playwright/test";

const IMPORT_CSV = [
  "batch,mode,spend,cac,roi_1,roi_7,roi_30,roi_60,ltv_1,ltv_7,ltv_30,ltv_60",
  "ROI 导入批次,roi,1200,,0.10,0.22,0.45,0.65,,,,",
  "LTV 导入批次,ltv_cac,800,20,,,,,2,4.4,9,13",
].join("\n");

const browserProblems = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const problems: string[] = [];
  browserProblems.set(page, problems);
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console.error: ${message.text()}`);
  });
  await page.addInitScript(() => {
    const resetMarker = "roi-e2e-storage-reset";
    if (sessionStorage.getItem(resetMarker) !== "done") {
      localStorage.clear();
      sessionStorage.setItem(resetMarker, "done");
    }
  });
});

test.afterEach(async ({ page }) => {
  expect(browserProblems.get(page) ?? [], "页面不应出现未捕获异常或 console.error").toEqual([]);
});

async function expectDownload(page: Page, buttonName: string, filename: string): Promise<Download> {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: buttonName, exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(filename);
  expect(await download.failure()).toBeNull();
  return download;
}

async function loadDemo(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByLabel("分析状态")).toContainText("已准备 4 个批次的分析结果");
  await expect(page.getByLabel("批次名称").first()).toHaveValue("成熟 ROI 批次 A（高投入）");
}

test("完整工作台流程支持目标、对象、模式、CSV、导出和双模式持久化", async ({ page }) => {
  await loadDemo(page);

  const summary = page.getByRole("region", { name: "结论概览" });
  await expect(summary.getByText("预测 ROI360")).toBeVisible();
  await expect(summary.locator("dd").filter({ hasText: /^\d+\.\d{3}$/ }).first()).toBeVisible();
  await expect(summary.getByText("预计达标", { exact: true })).toBeVisible();
  await expect(summary.getByText(/^预计第 \d+ 天达到目标$/)).toBeVisible();

  await page.getByLabel("目标 ROI").fill("2");
  await expect(summary.getByText("目标 ROI 2.000")).toBeVisible();
  await expect(summary.getByText("预计未达标", { exact: true })).toBeVisible();
  await expect(summary.getByText("预计 360 天内无法达到目标", { exact: true })).toBeVisible();

  const subject = page.getByLabel("分析对象");
  await subject.selectOption({ label: "成熟 LTV/CAC 批次 B（中投入）" });
  await expect(subject).toHaveValue("mature-ltv-q2");
  await subject.selectOption({ label: "加权汇总" });
  await expect(subject).toHaveValue("aggregate");

  const firstCohort = page.locator(".cohort-editor").first();
  await expect(firstCohort.getByRole("radio", { name: "ROI", exact: true })).toBeChecked();
  await firstCohort.getByRole("radio", { name: "LTV + CAC" }).check();
  await expect(firstCohort.getByLabel("CAC", { exact: true })).toBeVisible();
  await firstCohort.getByRole("radio", { name: "ROI", exact: true }).check();

  await expectDownload(page, "下载 ROI 模板", "roi-import-template.csv");
  await expectDownload(page, "下载 LTV + CAC 模板", "ltv-cac-import-template.csv");

  await page.getByRole("button", { name: "导入 CSV", exact: true }).click();
  await page.getByLabel("选择 CSV 文件").setInputFiles({
    name: "two-modes.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(IMPORT_CSV, "utf8"),
  });
  await expect(page.getByRole("dialog", { name: "导入 CSV" })).toBeHidden();
  await expect(page.locator(".cohort-editor")).toHaveCount(2);
  await expect(page.locator(".cohort-editor").nth(0).getByRole("radio", { name: "ROI", exact: true })).toBeChecked();
  await expect(page.locator(".cohort-editor").nth(1).getByRole("radio", { name: "LTV + CAC" })).toBeChecked();
  await expect(page.locator(".cohort-editor").nth(1).getByLabel("CAC", { exact: true })).toHaveValue("20");

  await expectDownload(page, "导出结果 CSV", "roi-forecast-results.csv");
  await expectDownload(page, "导出图表 PNG", "roi-forecast-chart.png");
  await expect(page.getByRole("status", { name: "本地保存状态" })).toHaveText("已保存到本地");

  await page.reload();
  await expect(page.getByLabel("目标 ROI")).toHaveValue("2");
  await expect(page.locator(".cohort-editor")).toHaveCount(2);
  await expect(page.locator(".cohort-editor").nth(0).getByLabel("批次名称")).toHaveValue("ROI 导入批次");
  await expect(page.locator(".cohort-editor").nth(0).getByRole("radio", { name: "ROI", exact: true })).toBeChecked();
  await expect(page.locator(".cohort-editor").nth(1).getByLabel("批次名称")).toHaveValue("LTV 导入批次");
  await expect(page.locator(".cohort-editor").nth(1).getByRole("radio", { name: "LTV + CAC" })).toBeChecked();
  await expect(page.locator(".cohort-editor").nth(1).getByLabel("CAC", { exact: true })).toHaveValue("20");
});

async function expectReachable(page: Page, name: string): Promise<void> {
  const button = page.getByRole("button", { name, exact: true });
  await button.scrollIntoViewIfNeeded();
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
}

async function expectResponsiveWorkbench(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await loadDemo(page);

  await expect(page.getByRole("region", { name: "结论概览" })).toBeVisible();
  await expect(page.getByRole("region", { name: "预测曲线" })).toBeVisible();
  const pageWidth = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(pageWidth.scrollWidth).toBeLessThanOrEqual(pageWidth.clientWidth + 1);

  const tableWrapper = page.locator(".cohort-editor .table-scroll").first();
  const tableWidths = await tableWrapper.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    right: element.getBoundingClientRect().right,
    viewportWidth: document.documentElement.clientWidth,
  }));
  expect(tableWidths.right).toBeLessThanOrEqual(tableWidths.viewportWidth + 1);
  if (width <= 390) expect(tableWidths.scrollWidth).toBeGreaterThan(tableWidths.clientWidth);

  for (const action of ["导入 CSV", "添加批次", "导出结果 CSV", "导出图表 PNG"]) {
    await expectReachable(page, action);
  }
}

test("桌面布局保持摘要、图表、表格和主操作可用", async ({ page }) => {
  await expectResponsiveWorkbench(page, 1440);
});

for (const width of [390, 320]) {
  test(`${width}px 移动布局无页面级横向溢出且表格可独立滚动`, async ({ page }) => {
    await expectResponsiveWorkbench(page, width);
  });
}
