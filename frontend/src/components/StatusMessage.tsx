export function StatusMessage({ status }: { status: string }) {
  if (!status) return null;

  return (
    <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm font-medium">
      {status}
    </div>
  );
}
