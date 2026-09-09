import { useRef } from "react";

interface ProjectDocumentActionsProps {
  onExport: () => void;
  onOpen: (file: File) => Promise<void>;
}

export default function ProjectDocumentActions({ onExport, onOpen }: ProjectDocumentActionsProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" onClick={onExport}>导出数据到本地</button>
      <button type="button" onClick={() => inputRef.current?.click()}>从本地导入数据</button>
      <input hidden aria-label="从本地导入数据" ref={inputRef} type="file" accept=".json,.roi.json,application/json" onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        if (file) void onOpen(file);
        event.currentTarget.value = "";
      }} />
    </>
  );
}
