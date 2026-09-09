import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Cohort } from "../domain/types";
import { parseCohortCsv, type CsvIssue } from "../io/csv";
import { cumulativeMax, validateCohorts, type ValidationIssue } from "../validation/validate";

interface ImportDialogProps {
  onImport: (cohorts: Cohort[]) => void;
  onClose: () => void;
}

async function readFileText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
    reader.readAsText(file);
  });
}

function sourceRow(cohortId: string): number {
  const match = /^csv-row-(\d+)$/u.exec(cohortId);
  return match ? Number(match[1]) : 1;
}

function semanticIssue(issue: ValidationIssue, cohorts: Cohort[]): CsvIssue {
  const cohort = cohorts.find((candidate) => candidate.id === issue.cohortId);
  const row = sourceRow(issue.cohortId);
  if (!cohort) return { row, column: issue.field, rawValue: "", message: issue.message };
  if (issue.field === "name") return { row, column: "batch", rawValue: cohort.name, message: "批次名称必须唯一。" };
  if (issue.field === "spend") return { row, column: "spend", rawValue: cohort.spend === undefined ? "" : String(cohort.spend), message: "投放成本必须大于 0。" };
  return { row, column: issue.field, rawValue: "", message: issue.message };
}

export default function ImportDialog({ onImport, onClose }: ImportDialogProps): JSX.Element {
  const [source, setSource] = useState("");
  const [issues, setIssues] = useState<CsvIssue[]>([]);
  const [repairableCohorts, setRepairableCohorts] = useState<Cohort[]>([]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => fileRef.current?.focus(), []);

  const importSource = (csv: string) => {
    const result = parseCohortCsv(csv);
    setRepairableCohorts(
      result.issues.length > 0 && result.issues.every((item) => item.message === "累计值不能下降。")
        ? [...result.cohorts, ...result.repairableCohorts]
        : [],
    );
    if (result.issues.length > 0) return setIssues(result.issues);
    if (result.cohorts.length === 0) {
      return setIssues([{ row: 1, column: "", rawValue: "", message: "未找到可导入的批次。" }]);
    }
    const validation = validateCohorts(result.cohorts);
    if (!validation.isValid) return setIssues(validation.errors.map((item) => semanticIssue(item, result.cohorts)));
    onImport(result.cohorts);
    onClose();
  };
  const repairCurrentSource = () => {
    const result = parseCohortCsv(source);
    setIssues(result.issues);
    const repairable = result.issues.length > 0 && result.issues.every((item) => item.message === "累计值不能下降。")
      ? [...result.cohorts, ...result.repairableCohorts]
      : [];
    setRepairableCohorts(repairable);
    if (repairable.length === 0) return;
    onImport(repairable.map((cohort): Cohort => {
      if (cohort.mode === "ltv_cac") return { ...cohort, observations: cumulativeMax(cohort.observations) };
      if (cohort.mode === "roi_retention") return { ...cohort, observations: cumulativeMax(cohort.observations) };
      return { ...cohort, observations: cumulativeMax(cohort.observations) };
    }));
    onClose();
  };
  const chooseFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const csv = await readFileText(file);
      setSource(csv);
      importSource(csv);
    } catch {
      setIssues([{ row: 1, column: "", rawValue: file.name, message: "无法读取所选文件。" }]);
    }
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button, input, textarea, [tabindex]:not([tabindex='-1'])") ?? [])]
      .filter((element) => !element.hasAttribute("disabled"));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="import-dialog-title" className="import-dialog" onKeyDown={handleKeyDown}>
      <h2 id="import-dialog-title">导入 CSV</h2>
      <label>选择 CSV 文件<input ref={fileRef} type="file" accept=".csv,text/csv" onChange={(event) => void chooseFile(event.currentTarget.files?.[0])} /></label>
      <label>CSV 源内容<textarea value={source} onChange={(event) => setSource(event.currentTarget.value)} rows={8} /></label>
      {issues.length > 0 && (
        <ul aria-label="CSV 导入错误">
          {issues.map((item, index) => (
            <li key={`${item.row}-${item.column}-${index}`}>
              第 {item.row} 行{item.column ? ` · ${item.column}` : ""}：{item.message}{item.rawValue ? `（原值：${item.rawValue}）` : ""}
            </li>
          ))}
        </ul>
      )}
      <div className="import-dialog__actions"><button type="button" onClick={() => importSource(source)}>解析并导入</button><button type="button" onClick={onClose}>取消</button></div>
      {repairableCohorts.length > 0 && (
        <button type="button" onClick={repairCurrentSource}>按累计最大值修正并导入</button>
      )}
    </div>
  );
}
