import type { JobProgressValue } from "../types/job";

export function JobProgress({ progress }: { progress: JobProgressValue | null }) {
  if (!progress) return null;

  return (
    <div className="mt-6">
      <div className="mb-1 flex justify-between text-sm font-medium text-slate-700">
        <span>Progress</span>
        <span>{progress.completed} of {progress.total} rows</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
        <div
          className="h-full bg-blue-600 transition-all duration-300"
          style={{ width: `${(progress.completed / progress.total) * 100}%` }}
        />
      </div>
    </div>
  );
}
