import type { Cohort, InputMode } from "../domain/types";
import type { ObservationRowDraft } from "../validation/observationRows";

export const DEFAULT_OBSERVATION_DAYS: number[] = [];

export interface ObservationDraft extends ObservationRowDraft {}

export interface CohortDraft {
  id: string;
  name: string;
  mode: InputMode;
  spend: string;
  retention: { nextDay: string; day7: string };
  observations: Record<InputMode, ObservationDraft[]>;
}

export type DraftErrors = Record<string, string>;

function nextId(prefix: string, existingIds: Iterable<string> = []): string {
  const existing = new Set(existingIds);
  let sequence = 1;
  while (existing.has(`${prefix}-${sequence}`)) sequence += 1;
  return `${prefix}-${sequence}`;
}

function emptyObservations(existingIds: Set<string>): ObservationDraft[] {
  const days: Array<number | ""> = DEFAULT_OBSERVATION_DAYS.length > 0 ? DEFAULT_OBSERVATION_DAYS : [""];
  return days.map((day) => {
    const id = nextId("observation", existingIds);
    existingIds.add(id);
    return { id, day: String(day), value: "", cac: "", retention: "" };
  });
}

export function createEmptyCohortDraft(index = 1, existingCohortIds: Iterable<string> = []): CohortDraft {
  const observationIds = new Set<string>();
  return {
    id: nextId("cohort", existingCohortIds),
    name: `批次 ${index}`,
    mode: "roi",
    spend: "",
    retention: { nextDay: "", day7: "" },
    observations: { roi: emptyObservations(observationIds), roi_retention: emptyObservations(observationIds), ltv_cac: emptyObservations(observationIds) },
  };
}

export function cohortToDraft(cohort: Cohort): CohortDraft {
  const observationIds = new Set<string>();
  const importRows = () => cohort.observations.map((observation) => ({
    id: (() => {
      const id = nextId("observation", observationIds);
      observationIds.add(id);
      return id;
    })(),
    day: String(observation.day),
    value: String(observation.value),
    cac: cohort.mode === "ltv_cac" ? String(observation.cac) : "",
    retention: cohort.mode === "roi_retention" && "retention" in observation && observation.retention !== undefined ? String(observation.retention) : "",
  }));
  const primary = importRows();
  const roiRows = cohort.mode === "roi" ? primary : cohort.mode === "roi_retention" ? importRows() : emptyObservations(observationIds);
  const roiRetentionRows = cohort.mode === "roi_retention" ? primary : cohort.mode === "roi" ? importRows() : emptyObservations(observationIds);
  const ltvRows = cohort.mode === "ltv_cac" ? primary : emptyObservations(observationIds);
  return {
    id: cohort.id || nextId("cohort"),
    name: cohort.name,
    mode: cohort.mode,
    spend: cohort.spend === undefined ? "" : String(cohort.spend),
    retention: cohort.mode === "roi_retention" && cohort.retention
      ? { nextDay: String(cohort.retention.nextDay), day7: String(cohort.retention.day7) }
      : { nextDay: "", day7: "" },
    observations: {
      roi: roiRows,
      roi_retention: roiRetentionRows,
      ltv_cac: ltvRows,
    },
  };
}

export function cohortDraftsFrom(cohorts: Cohort[]): CohortDraft[] {
  return cohorts.length > 0 ? cohorts.map(cohortToDraft) : [createEmptyCohortDraft()];
}

export function draftErrorKey(draftId: string, field: string): string {
  return `${draftId}:${field}`;
}

interface CohortEditorProps {
  draft: CohortDraft;
  sequence: number;
  errors: DraftErrors;
  canRemove: boolean;
  onChange: (draft: CohortDraft) => void;
  onRemove: () => void;
}

function describedBy(error: string | undefined, id: string): string | undefined {
  return error ? `${id}-error` : undefined;
}

export default function CohortEditor({ draft, sequence, errors, canRemove, onChange, onRemove }: CohortEditorProps): JSX.Element {
  const rows = draft.observations[draft.mode];
  const metricName = draft.mode === "ltv_cac" ? "LTV" : "ROI";
  const update = (patch: Partial<CohortDraft>) => onChange({ ...draft, ...patch });
  const updateRow = (id: string, patch: Partial<ObservationDraft>) => update({
    observations: {
      ...draft.observations,
      [draft.mode]: rows.map((row) => row.id === id ? { ...row, ...patch } : row),
    },
  });
  const removeRow = (id: string) => update({
    observations: { ...draft.observations, [draft.mode]: rows.filter((row) => row.id !== id) },
  });
  const addRow = () => update({
    observations: {
      ...draft.observations,
      [draft.mode]: [...rows, {
        id: nextId("observation", [...draft.observations.roi, ...draft.observations.roi_retention, ...draft.observations.ltv_cac].map((row) => row.id)),
        day: "",
        value: "",
        cac: "",
        retention: "",
      }],
    },
  });
  const nameKey = draftErrorKey(draft.id, "name");

  return (
    <fieldset className="cohort-editor">
      <legend>批次 {sequence}</legend>
      <div className="cohort-editor__meta">
        <label>
          批次名称
          <input value={draft.name} onChange={(event) => update({ name: event.currentTarget.value })} aria-describedby={describedBy(errors[nameKey], nameKey)} />
        </label>
        {errors[nameKey] && <p id={`${nameKey}-error`} role="alert">{errors[nameKey]}</p>}
      </div>

      <div className="table-scroll">
        <table aria-label={`${draft.name || "未命名批次"} 的观测数据`}>
          <thead><tr><th scope="col" className="observation-index">序号</th><th scope="col">天数</th><th scope="col">累计 {metricName}</th>{draft.mode === "roi_retention" && <th scope="col">对应留存率</th>}{draft.mode === "ltv_cac" && <th scope="col">CAC</th>}<th scope="col">操作</th></tr></thead>
          <tbody>
            {rows.map((row, index) => {
              const dayKey = draftErrorKey(draft.id, `observation:${draft.mode}:${row.id}:day`);
              const valueKey = draftErrorKey(draft.id, `observation:${draft.mode}:${row.id}:value`);
              const cacKey = draftErrorKey(draft.id, `observation:${draft.mode}:${row.id}:cac`);
              const roiKey = draftErrorKey(draft.id, `observation:${draft.mode}:${row.id}:roi`);
              const retentionKey = draftErrorKey(draft.id, `observation:${draft.mode}:${row.id}:retention`);
              const rowError = errors[roiKey];
              const dayLabel = row.day.trim() || String(index + 1);
              return (
                <tr key={row.id} className={rowError ? "observation-row--error" : undefined} aria-invalid={rowError ? "true" : undefined}>
                  <th scope="row" className="observation-index">{index + 1}</th>
                  <td>
                    <label><span>观测天数</span><input aria-label={`第 ${index + 1} 行观测天数`} inputMode="numeric" value={row.day} onChange={(event) => updateRow(row.id, { day: event.currentTarget.value })} aria-describedby={describedBy(errors[dayKey], dayKey)} /></label>
                    {errors[dayKey] && <p id={`${dayKey}-error`} role="alert">{errors[dayKey]}</p>}
                  </td>
                  {draft.mode === "roi_retention" && <td>
                    <label><span>D{dayLabel} 对应留存率</span><input inputMode="decimal" value={row.retention ?? ""} onChange={(event) => updateRow(row.id, { retention: event.currentTarget.value })} aria-describedby={describedBy(errors[retentionKey], retentionKey)} /></label>
                    {errors[retentionKey] && <p id={`${retentionKey}-error`} role="alert">{errors[retentionKey]}</p>}
                  </td>}
                  <td>
                    <label><span>D{dayLabel} {metricName}</span><input inputMode="decimal" value={row.value} onChange={(event) => updateRow(row.id, { value: event.currentTarget.value })} aria-describedby={describedBy(errors[valueKey], valueKey)} /></label>
                    {errors[valueKey] && <p id={`${valueKey}-error`} role="alert">{errors[valueKey]}</p>}
                  </td>
                  {draft.mode === "ltv_cac" && <td>
                    <label><span>D{dayLabel} CAC</span><input aria-label={`第 ${index + 1} 行 CAC`} inputMode="decimal" value={row.cac} onChange={(event) => updateRow(row.id, { cac: event.currentTarget.value })} aria-describedby={describedBy(errors[cacKey] ?? rowError, errors[cacKey] ? cacKey : roiKey)} /></label>
                    {errors[cacKey] && <p id={`${cacKey}-error`} role="alert">{errors[cacKey]}</p>}
                    {rowError && <p id={`${roiKey}-error`} className="observation-row__error" role="alert">{rowError}</p>}
                  </td>}
                  <td><button type="button" onClick={() => removeRow(row.id)} aria-label={`删除 D${dayLabel} 观测`}>删除</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="cohort-editor__actions">
        <button type="button" onClick={addRow}>添加观测日</button>
        <button type="button" onClick={onRemove} disabled={!canRemove} aria-label={`删除批次 ${draft.name || "未命名批次"}`}>删除批次</button>
      </div>
    </fieldset>
  );
}
