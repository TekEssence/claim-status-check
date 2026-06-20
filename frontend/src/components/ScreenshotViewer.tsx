import type { ErrorScreenshot } from "../types/job";

export function ScreenshotViewer({ screenshots }: { screenshots: ErrorScreenshot[] }) {
  if (screenshots.length === 0) return null;

  return (
    <div className="mt-4 flex flex-col gap-4">
      {screenshots.map((err, i) => (
        <div key={i} className="rounded-md border border-red-200 bg-red-50 p-3">
          <h2 className="mb-2 text-sm font-semibold text-red-700">
            {err.index === -1 ? "Login Error Screenshot" : `Error Screenshot for Row ${err.index + 1}`}
          </h2>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`data:image/jpeg;base64,${err.image}`}
            alt="Browser state on error"
            className="max-w-full rounded border border-red-200 shadow-sm"
          />
        </div>
      ))}
    </div>
  );
}
