import type { Cohort, InputMode, LtvObservation, RoiObservation } from "../domain/types";
import { parseMetric } from "./normalize";

export interface ObservationRowDraft {
  id: string;
  day: string;
  value: string;
  cac: string;
  retention?: string;
}

export type ObservationRowField = "day" | "value" | "cac" | "retention" | "roi";

export interface ObservationRowIssue {
  rowId: string;
  field: ObservationRowField;
  message: string;
}

export interface ParsedObservationRows {
  sourceObservations: Cohort["observations"];
  roiObservations: RoiObservation[];
  issues: ObservationRowIssue[];
}

const ROI_MONOTONIC_EPSILON = 1e-12;

function displayMetric(value: number): string {
  return String(Number(value.toFixed(4)));
}

/** Parses editable rows once for both fitting and ROI estimation flows. */
export function parseObservationRows(rows: ObservationRowDraft[], mode: InputMode): ParsedObservationRows {
  const issues: ObservationRowIssue[] = [];
  const seenDays = new Set<number>();
  const roiSource: Array<{ rowId: string; observation: RoiObservation }> = [];
  const ltvSource: Array<{ rowId: string; observation: LtvObservation }> = [];

  for (const row of rows) {
    const isRoiMode = mode !== "ltv_cac";
    const completelyEmpty = !row.day.trim() && !row.value.trim() && (isRoiMode || !row.cac.trim()) && (mode !== "roi_retention" || !(row.retention ?? "").trim());
    if (completelyEmpty) continue;

    const day = Number(row.day);
    const value = parseMetric(row.value);
    const cac = mode === "ltv_cac" ? parseMetric(row.cac) : null;
    const retention = mode === "roi_retention" && (row.retention ?? "").trim() ? parseMetric(row.retention ?? "") : undefined;
    const validDay = Number.isInteger(day) && day >= 1 && day <= 360 && !seenDays.has(day);
    const validValue = value !== null && value >= 0;
    const validCac = isRoiMode || (cac !== null && cac > 0);
    const validRetention = mode !== "roi_retention" || retention === undefined || (retention !== null && retention >= 0 && retention <= 1);

    if (!validDay) issues.push({ rowId: row.id, field: "day", message: "天数必须为 D1 到 D360 且不能重复。" });
    if (!validValue) issues.push({ rowId: row.id, field: "value", message: "累计值必须为非负有限数。" });
    if (!validCac) issues.push({ rowId: row.id, field: "cac", message: "CAC 必须是大于 0 的有限数字。" });
    if (!validRetention) issues.push({ rowId: row.id, field: "retention", message: "对应留存率必须是 0% 到 100% 之间的有限数字。" });

    if (Number.isInteger(day) && day >= 1 && day <= 360 && !seenDays.has(day)) seenDays.add(day);
    if (!validDay || !validValue || !validCac || !validRetention || value === null) continue;

    if (isRoiMode) {
      roiSource.push({ rowId: row.id, observation: { day, value, ...(retention === undefined || retention === null ? {} : { retention }) } });
    } else if (cac !== null) {
      ltvSource.push({ rowId: row.id, observation: { day, value, cac } });
    }
  }

  const source = (mode !== "ltv_cac" ? roiSource : ltvSource).sort(
    (left, right) => left.observation.day - right.observation.day,
  );
  let previousSource = Number.NEGATIVE_INFINITY;
  for (const point of source) {
    if (point.observation.value < previousSource) {
      issues.push({ rowId: point.rowId, field: "value", message: "累计值不能下降。" });
    }
    previousSource = Math.max(previousSource, point.observation.value);
  }

  const roiPoints = source.map((point) => ({
    rowId: point.rowId,
    observation: {
      day: point.observation.day,
      value: mode === "ltv_cac"
        ? point.observation.value / (point.observation as LtvObservation).cac
        : point.observation.value,
      ...(mode === "roi_retention" && "retention" in point.observation && point.observation.retention !== undefined
        ? { retention: point.observation.retention }
        : {}),
    },
  }));
  let previousRoi: { day: number; value: number } | undefined;
  for (const point of roiPoints) {
    if (previousRoi && point.observation.value < previousRoi.value - ROI_MONOTONIC_EPSILON) {
      issues.push({
        rowId: point.rowId,
        field: "roi",
        message: `D${point.observation.day} 换算 ROI ${displayMetric(point.observation.value)}，低于 D${previousRoi.day} 的 ${displayMetric(previousRoi.value)}；累计 ROI 不允许下降。`,
      });
    }
    if (!previousRoi || point.observation.value > previousRoi.value) previousRoi = point.observation;
  }

  return {
    sourceObservations: source.map((point) => point.observation) as Cohort["observations"],
    roiObservations: roiPoints.map((point) => point.observation),
    issues,
  };
}
