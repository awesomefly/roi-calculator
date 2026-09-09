export default function RiskNotices({ warnings }: { warnings: string[] }): JSX.Element {
  return (
    <aside aria-labelledby="risk-notices-title" className="risk-notices">
      <h2 id="risk-notices-title">风险提示</h2>
      {warnings.length > 0
        ? <ul>{warnings.map((warning) => <li key={warning}><span aria-hidden="true">⚠</span> {warning}</li>)}</ul>
        : <p><span aria-hidden="true">✓</span> 暂无额外风险提示。</p>}
    </aside>
  );
}
