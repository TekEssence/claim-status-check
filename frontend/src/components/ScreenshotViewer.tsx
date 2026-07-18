import type { ErrorScreenshot } from "../types/job";

function getScreenshotTitle(screenshot: ErrorScreenshot): string {
  if (screenshot.index === -1) return "Login Error Screenshot";
  if (screenshot.index < 0) return "Diagnostic Screenshot";
  return `Error Screenshot for Row ${screenshot.index + 1}`;
}

export function ScreenshotViewer({ screenshots }: { screenshots: ErrorScreenshot[] }) {
  if (screenshots.length === 0) return null;

  return (
    <div className="mt-4 flex flex-col gap-4">
      {screenshots.map((err, i) => (
        <div key={i} className="rounded-md border border-red-200 bg-red-50 p-3">
          <h2 className="mb-2 text-sm font-semibold text-red-700">
            {getScreenshotTitle(err)}
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
