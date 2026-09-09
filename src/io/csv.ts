import Papa from "papaparse";
import type { AnalysisResult, Cohort, InputMode, LtvObservation, ModelResult, Observation, RoiObservation } from "../domain/types";
import { cohortToRoi, parseMetric } from "../validation/normalize";

export interface CsvIssue {
  row: number;
  column: string;
  rawValue: string;
  message: string;
}

export interface CohortCsvParseResult {
  cohorts: Cohort[];
  repairableCohorts: Cohort[];
  issues: CsvIssue[];
}

const TEMPLATE_DAYS = [1, 7, 15, 30, 60, 90, 120, 180, 360];
const MODEL_IDS: ModelResult["id"][] = [
  "logarithmic",
  "power",
  "saturation",
  "historical_multiplier",
];

function withBom(csv: string): string {
  return `\uFEFF${csv}`;
}

function safeCsvCell(value: unknown): unknown {
  return typeof value === "string" && /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
}

function safeRows(rows: unknown[][]): unknown[][] {
  return rows.map((row) => row.map(safeCsvCell));
}

/** Turns BOM-prefixed CSV text into a browser-downloadable UTF-8 Blob. */
export function createCsvBlob(csv: string): Blob {
  return new Blob([csv], { type: "text/csv;charset=utf-8" });
}

function rawCell(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function parseCell(value: unknown): string {
  return rawCell(value).trim();
}

function issue(row: number, column: string, rawValue: string, message: string): CsvIssue {
  return { row, column, rawValue, message };
}

interface DayColumn {
  kind: "roi" | "ltv" | "cac" | "retention";
  day: number;
}

function dayColumn(column: string): DayColumn | undefined {
  const match = /^(roi|ltv|cac|retention)_(\d+)$/u.exec(column);
  if (!match) return undefined;
  const day = Number(match[2]);
  if (!Number.isInteger(day) || day < 1 || day > 360) return undefined;
  return { kind: match[1] as DayColumn["kind"], day };
}

function createTemplate(mode: InputMode): string {
  const headers = mode !== "ltv_cac"
    ? ["batch", "mode", ...TEMPLATE_DAYS.flatMap((day) => mode === "roi_retention" ? [`roi_${day}`, `retention_${day}`] : [`roi_${day}`])]
    : ["batch", "mode", ...TEMPLATE_DAYS.flatMap((day) => [`ltv_${day}`, `cac_${day}`])];
  const example = mode !== "ltv_cac"
    ? ["示例批次", mode, ...(mode === "roi_retention"
      ? ["10%", "28%", "22%", "16%", "", "", "45%", "9%", "", "", "", "", "", "", "", "", "", ""]
      : ["10%", "22%", "", "45%", "", "", "", "", ""])]
    : ["示例批次", "ltv_cac", "2", "20", "4.4", "20", "", "", "9", "20", "", "", "", "", "", "", "", "", "", ""];
  return withBom(Papa.unparse(safeRows([headers, example])));
}

/** Creates an Excel-compatible ROI import template with recommended observation days. */
export function createRoiTemplate(): string {
  return createTemplate("roi");
}

/** Creates an ROI template with cohort-level next-day and D7 retention. */
export function createRoiRetentionTemplate(): string {
  return createTemplate("roi_retention");
}

/** Creates an Excel-compatible LTV/CAC import template with recommended observation days. */
export function createLtvTemplate(): string {
  return createTemplate("ltv_cac");
}

/** Parses CSV rows without repairing or silently discarding malformed values. */
export function parseCohortCsv(csv: string): CohortCsvParseResult {
  const source = csv.replace(/^\uFEFF/u, "");
  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  const issues: CsvIssue[] = [];
  let priorCursor = 0;

  const physicalRowAt = (offset: number): number => {
    let scan = offset;
    while (scan < source.length) {
      const ending = source.slice(scan).search(/\r\n|\r|\n/u);
      const lineEnd = ending === -1 ? source.length : scan + ending;
      if (source.slice(scan, lineEnd).trim().length > 0) break;
      scan = lineEnd + (source.startsWith("\r\n", lineEnd) ? 2 : 1);
    }
    return source.slice(0, scan).split(/\r\n|\r|\n/u).length;
  };

  Papa.parse<string[]>(source, {
    skipEmptyLines: "greedy",
    step: (result) => {
      const rowNumber = physicalRowAt(priorCursor);
      const cells = result.data;
      const rawRow = cells.map(rawCell).join(",");
      rows.push(cells);
      rowNumbers.push(rowNumber);
      for (const error of result.errors) {
        issues.push(issue(rowNumber, error.code ?? "", rawRow, error.message));
      }
      priorCursor = result.meta.cursor;
    },
  });
  const [headerRow, ...dataRows] = rows;
  if (!headerRow) return { cohorts: [], repairableCohorts: [], issues: [...issues, issue(1, "", "", "缺少 CSV 表头。")] };

  const headerRowNumber = rowNumbers[0] ?? 1;
  const rawHeaders = headerRow.map(rawCell);
  const headers = rawHeaders.map((header) => parseCell(header).toLowerCase());
  const nameIndex = headers.findIndex((header) => header === "batch" || header === "cohort_name");
  const modeIndex = headers.indexOf("mode");
  const spendIndex = headers.indexOf("spend");
  const nextDayRetentionIndex = headers.indexOf("next_day_retention");
  const day7RetentionIndex = headers.indexOf("day_7_retention");
  if (nameIndex === -1) issues.push(issue(headerRowNumber, "batch", "", "缺少 batch 或 cohort_name 列。"));
  if (modeIndex === -1) issues.push(issue(headerRowNumber, "mode", "", "缺少 mode 列。"));
  if (headers.includes("cac")) issues.push(issue(headerRowNumber, "cac", rawHeaders[headers.indexOf("cac")] ?? "cac", "旧版批次级 cac 列不再支持，请使用 cac_天数。"));

  const dayColumns = headers
    .map((column, index) => {
      const field = dayColumn(column);
      const canonicalColumn = field ? `${field.kind}_${field.day}` : column;
      return { column: canonicalColumn, index, field };
    })
    .filter((entry): entry is { column: string; index: number; field: DayColumn } => entry.field !== undefined);
  const seenDayColumns = new Set<string>();
  headers.forEach((header, index) => {
    if (!/^(roi|ltv|cac|retention)_/u.test(header)) return;
    const numericDay = /^(roi|ltv|cac|retention)_(\d+)$/u.exec(header);
    if (!numericDay) {
      issues.push(issue(headerRowNumber, header, rawCell(headerRow[index]), "观测列必须使用 roi_天数、retention_天数、ltv_天数 或 cac_天数 格式。"));
      return;
    }
    const day = Number(numericDay[2]);
    if (!Number.isInteger(day) || day < 1 || day > 360) {
      issues.push(issue(headerRowNumber, header, rawCell(headerRow[index]), "观测列天数必须是 1 到 360 的整数。"));
      return;
    }
    const canonicalColumn = `${numericDay[1]}_${day}`;
    if (seenDayColumns.has(canonicalColumn)) {
      issues.push(issue(headerRowNumber, canonicalColumn, rawHeaders[index], `观测列 ${canonicalColumn} 重复。`));
    } else {
      seenDayColumns.add(canonicalColumn);
    }
  });
  if (!dayColumns.some(({ field }) => field.kind === "roi" || field.kind === "ltv")) issues.push(issue(headerRowNumber, "", "", "缺少 roi_天数 或 ltv_天数 观测列。"));
  if (issues.length > 0) return { cohorts: [], repairableCohorts: [], issues };

  const cohorts: Cohort[] = [];
  const repairableCohorts: Cohort[] = [];
  const seenNames = new Set<string>();
  dataRows.forEach((row, index) => {
    const rowNumber = rowNumbers[index + 1] ?? index + 2;
    const rowIssues: CsvIssue[] = [];
    const nameRaw = rawCell(row[nameIndex]);
    const name = parseCell(row[nameIndex]);
    const modeRaw = parseCell(row[modeIndex]);
    const mode = modeRaw === "roi" || modeRaw === "roi_retention" || modeRaw === "ltv_cac" ? modeRaw : undefined;
    if (!name) rowIssues.push(issue(rowNumber, headers[nameIndex], nameRaw, "批次名称不能为空。"));
    if (name && seenNames.has(name)) rowIssues.push(issue(rowNumber, headers[nameIndex], nameRaw, "批次名称必须唯一。"));
    if (name) seenNames.add(name);
    if (!mode) rowIssues.push(issue(rowNumber, "mode", rawCell(row[modeIndex]), "模式必须是 roi、roi_retention 或 ltv_cac。"));

    const optionalNumber = (column: "spend", position: number): number | undefined => {
      const raw = rawCell(row[position]);
      if (!raw.trim()) return undefined;
      const value = parseMetric(raw);
      if (value === null) {
        rowIssues.push(issue(rowNumber, column, raw, "必须是有限数字或百分比。"));
        return undefined;
      }
      return value;
    };
    const spend = spendIndex === -1 ? undefined : optionalNumber("spend", spendIndex);
    if (spendIndex !== -1 && rawCell(row[spendIndex]).trim() && spend !== undefined && spend <= 0) {
      rowIssues.push(issue(rowNumber, "spend", rawCell(row[spendIndex]), "投放成本必须是大于 0 的有限数字。"));
    }
    const roiObservations: RoiObservation[] = [];
    const ltvObservations: LtvObservation[] = [];
    const observationCells: Array<{ day: number; value: number; roi: number; column: string; rawValue: string }> = [];
    const legacyRetention = new Map<number, number>();
    if (mode === "roi_retention") {
      const parseRetention = (label: string, column: string, position: number): number | undefined => {
        if (position === -1) return undefined;
        const raw = rawCell(row[position]);
        if (!raw.trim()) return undefined;
        const value = parseMetric(raw);
        if (value === null || value < 0 || value > 1) rowIssues.push(issue(rowNumber, column, raw, `${label}必须是 0% 到 100% 之间的有限数字。`));
        return value !== null && value >= 0 && value <= 1 ? value : undefined;
      };
      const nextDay = parseRetention("次留", "next_day_retention", nextDayRetentionIndex);
      const day7 = parseRetention("7留", "day_7_retention", day7RetentionIndex);
      if (nextDay !== undefined) legacyRetention.set(1, nextDay);
      if (day7 !== undefined) legacyRetention.set(7, day7);
    }
    if (mode === "roi" || mode === "roi_retention") {
      const pointRetention = new Map<number, number>();
      for (const { column, index: columnIndex, field } of dayColumns.filter((entry) => entry.field.kind === "retention")) {
        const raw = rawCell(row[columnIndex]);
        if (!raw.trim()) continue;
        if (mode !== "roi_retention") {
          rowIssues.push(issue(rowNumber, column, raw, "只有 ROI + 留存率模式可以使用 retention_天数 列。"));
          continue;
        }
        const value = parseMetric(raw);
        if (value === null || value < 0 || value > 1) rowIssues.push(issue(rowNumber, column, raw, "对应留存率必须是 0% 到 100% 之间的有限数字。"));
        else pointRetention.set(field.day, value);
      }
      for (const { column, index: columnIndex, field } of dayColumns.filter((entry) => entry.field.kind !== "retention")) {
        const raw = rawCell(row[columnIndex]);
        if (!raw.trim()) continue;
        if (field.kind !== "roi") {
          rowIssues.push(issue(rowNumber, column, raw, "ROI 模式只能使用 roi_天数 列。"));
          continue;
        }
        const value = parseMetric(raw);
        if (value === null) rowIssues.push(issue(rowNumber, column, raw, "必须是有限数字或百分比。"));
        else if (value < 0) rowIssues.push(issue(rowNumber, column, raw, "必须是非负数字。"));
        else {
          const retentionValue = mode === "roi_retention" ? pointRetention.get(field.day) ?? legacyRetention.get(field.day) : undefined;
          roiObservations.push({ day: field.day, value, ...(retentionValue === undefined ? {} : { retention: retentionValue }) });
          observationCells.push({ day: field.day, value, roi: value, column, rawValue: raw });
        }
      }
    } else if (mode === "ltv_cac") {
      const byDay = new Map<number, Partial<Record<DayColumn["kind"], { column: string; index: number }>>>();
      for (const entry of dayColumns) {
        const fields = byDay.get(entry.field.day) ?? {};
        fields[entry.field.kind] = { column: entry.column, index: entry.index };
        byDay.set(entry.field.day, fields);
      }
      for (const [day, fields] of [...byDay].sort(([left], [right]) => left - right)) {
        const roiRaw = fields.roi ? rawCell(row[fields.roi.index]) : "";
        if (roiRaw.trim()) rowIssues.push(issue(rowNumber, fields.roi?.column ?? `roi_${day}`, roiRaw, "LTV/CAC 模式只能使用 ltv_天数 和 cac_天数 列。"));
        const ltvRaw = fields.ltv ? rawCell(row[fields.ltv.index]) : "";
        const cacRaw = fields.cac ? rawCell(row[fields.cac.index]) : "";
        if (!ltvRaw.trim() && !cacRaw.trim()) continue;
        if (!ltvRaw.trim()) {
          rowIssues.push(issue(rowNumber, `ltv_${day}`, "", `cac_${day} 必须配对 ltv_${day}。`));
          continue;
        }
        if (!cacRaw.trim()) {
          rowIssues.push(issue(rowNumber, `cac_${day}`, "", `ltv_${day} 必须配对 cac_${day}。`));
          continue;
        }
        const value = parseMetric(ltvRaw);
        const cac = parseMetric(cacRaw);
        if (value === null) rowIssues.push(issue(rowNumber, `ltv_${day}`, ltvRaw, "必须是有限数字或百分比。"));
        else if (value < 0) rowIssues.push(issue(rowNumber, `ltv_${day}`, ltvRaw, "必须是非负数字。"));
        if (cac === null || cac <= 0) rowIssues.push(issue(rowNumber, `cac_${day}`, cacRaw, "CAC 必须是大于 0 的有限数字。"));
        if (value !== null && value >= 0 && cac !== null && cac > 0) {
          ltvObservations.push({ day, value, cac });
          observationCells.push({ day, value, roi: value / cac, column: `ltv_${day}`, rawValue: ltvRaw });
        }
      }
    }
    let cumulativeMaximum = Number.NEGATIVE_INFINITY;
    for (const observation of [...observationCells].sort((left, right) => left.day - right.day)) {
      if (observation.value < cumulativeMaximum) {
        rowIssues.push(issue(rowNumber, observation.column, observation.rawValue, "累计值不能下降。"));
      }
      cumulativeMaximum = Math.max(cumulativeMaximum, observation.value);
    }
    if (mode === "ltv_cac") {
      let previousRoi: { day: number; value: number } | undefined;
      for (const observation of [...observationCells].sort((left, right) => left.day - right.day)) {
        if (previousRoi && observation.roi < previousRoi.value - 1e-12) {
          rowIssues.push(issue(
            rowNumber,
            observation.column,
            observation.rawValue,
            `D${observation.day} 换算 ROI ${Number(observation.roi.toFixed(4))}，低于 D${previousRoi.day} 的 ${Number(previousRoi.value.toFixed(4))}；累计 ROI 不允许下降。`,
          ));
        }
        if (!previousRoi || observation.roi > previousRoi.value) previousRoi = { day: observation.day, value: observation.roi };
      }
    }
    const observationCount = mode === "roi" || mode === "roi_retention" ? roiObservations.length : mode === "ltv_cac" ? ltvObservations.length : 0;
    if (mode && observationCount === 0) {
      rowIssues.push(issue(rowNumber, mode === "ltv_cac" ? "ltv_天数" : "roi_天数", "", "至少需要一个观测值。"));
    }
    const candidate: Cohort | undefined = mode && observationCount > 0 && name
      ? mode === "roi"
        ? { id: `csv-row-${rowNumber}`, name, mode: "roi", ...(spend === undefined ? {} : { spend }), observations: roiObservations.sort((left, right) => left.day - right.day) }
        : mode === "roi_retention"
          ? { id: `csv-row-${rowNumber}`, name, mode: "roi_retention", ...(spend === undefined ? {} : { spend }), observations: roiObservations.sort((left, right) => left.day - right.day) }
        : { id: `csv-row-${rowNumber}`, name, mode: "ltv_cac", ...(spend === undefined ? {} : { spend }), observations: ltvObservations.sort((left, right) => left.day - right.day) }
      : undefined;
    if (rowIssues.length > 0) {
      issues.push(...rowIssues);
      if (candidate && rowIssues.every((item) => item.message === "累计值不能下降。")) repairableCohorts.push(candidate);
      return;
    }
    if (candidate) cohorts.push(candidate);
  });
  return { cohorts, repairableCohorts, issues };
}

function signed(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "";
  return `${value > 0 ? "+" : ""}${value}`;
}

function predictionAt360(model: ModelResult | undefined): number | undefined {
  const value = model?.predictions.find((point) => point.day === 360)?.value;
  return Number.isFinite(value) ? value : undefined;
}

function resultColumns(result: AnalysisResult | undefined): Record<string, string | number | boolean> {
  const models = new Map(result?.models.map((model) => [model.id, model]));
  const modelColumns = Object.fromEntries(MODEL_IDS.flatMap((id) => {
    const model = models.get(id);
    return [
      [`${id}_roi360`, predictionAt360(model) ?? ""],
      [`${id}_score`, model?.score ?? ""],
      [`${id}_backtest_error`, model?.backtestError ?? ""],
      [`${id}_status`, model?.status ?? "missing"],
      [`${id}_reason`, model?.reason ?? ""],
    ];
  }));
  return {
    ...modelColumns,
    selected_model: result?.selectedModelId ?? "",
    roi360: result?.roi360 ?? "",
    target_gap: signed(result?.targetGap),
    target_gap_ratio: signed(result?.targetGapRatio),
    target_day: result?.targetDay ?? "",
    reaches_target: result?.reachesTarget ?? "",
    confidence: result?.confidence ?? "",
    confidence_reasons: result?.confidenceReasons?.join("；") ?? "",
    warnings: result?.warnings.join("；") ?? "",
  };
}

interface ResultsCsvRow {
  batch: string;
  mode: string;
  spend: string | number;
  cac: string | number;
  day: string | number;
  original_observation: string | number;
  roi_observation: string | number;
  contributor_count: string | number;
  contributing_spend: string | number;
  [column: string]: string | number | boolean;
}

/** Creates an Excel-compatible, row-per-observation result export. */
export function createResultsCsv(
  cohorts: Cohort[],
  results: AnalysisResult[],
  aggregateObservations: Observation[] = [],
): string {
  const resultBySubject = new Map(results.map((result) => [result.subjectId, result]));
  const rows: ResultsCsvRow[] = cohorts.flatMap((cohort): ResultsCsvRow[] => {
    const result = resultBySubject.get(cohort.id);
    const roiByDay = new Map(cohortToRoi(cohort).map((observation) => [observation.day, observation.value]));
    const resultRow = (observation: Observation, cac: number | ""): ResultsCsvRow => {
      return {
        batch: cohort.name,
        mode: cohort.mode,
        spend: cohort.spend ?? "",
        cac,
        day: observation.day,
        original_observation: observation.value,
        roi_observation: roiByDay.get(observation.day) ?? "",
        contributor_count: "",
        contributing_spend: "",
        ...resultColumns(result),
      };
    };
    return cohort.mode !== "ltv_cac"
      ? cohort.observations.map((observation) => resultRow(observation, ""))
      : cohort.observations.map((observation) => resultRow(observation, observation.cac));
  });
  const aggregateResult = resultBySubject.get("aggregate");
  if (aggregateResult) {
    const totalSpend = cohorts.every((cohort) => cohort.spend !== undefined && cohort.spend > 0)
      ? cohorts.reduce((sum, cohort) => sum + (cohort.spend ?? 0), 0)
      : "";
    const aggregateRows: Array<Observation | undefined> = aggregateObservations.length > 0 ? aggregateObservations : [undefined];
    rows.push(...aggregateRows.map((observation) => ({
      batch: "加权汇总",
      mode: "aggregate",
      spend: observation?.contributingSpend ?? totalSpend,
      cac: "",
      day: observation?.day ?? "",
      original_observation: "",
      roi_observation: observation?.value ?? "",
      contributor_count: observation?.contributorCount ?? "",
      contributing_spend: observation?.contributingSpend ?? "",
      ...resultColumns(aggregateResult),
    })));
  }
  const safe = rows.map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, safeCsvCell(value)]),
  ));
  return withBom(Papa.unparse(safe));
}
