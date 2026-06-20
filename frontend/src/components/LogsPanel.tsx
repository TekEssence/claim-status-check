export function LogsPanel({ logs }: { logs: string[] }) {
  if (logs.length === 0) return null;

  return (
    <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
      <h2 className="mb-2 text-sm font-semibold">Live Processing Logs</h2>
      <ul className="max-h-64 list-disc space-y-1 overflow-auto pl-5 text-xs text-slate-700">
        {logs.map((line, idx) => (
          <li key={idx}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
