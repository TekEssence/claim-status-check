import type { ErrorScreenshot } from "../types/job";

function getScreenshotTitle(screenshot: ErrorScreenshot): string {
  if (screenshot.index === -1) return "Login Error Screenshot";
  if (screenshot.index < 0) return "Diagnostic Screenshot";
  return `Error Screenshot for Line ${screenshot.index + 1}`;
}

export function ScreenshotViewer({ screenshots }: { screenshots: ErrorScreenshot[] }) {
  if (screenshots.length === 0) return null;

  return (
    <div className="mt-4 flex flex-col gap-4">
      {screenshots.map((err, i) => (
        <div key={i} className="rounded-md border border-red-200 bg-red-50 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-red-700">
              {getScreenshotTitle(err)}
            </h2>
            <a
              href={`data:image/jpeg;base64,${err.image}`}
              download={`error_screenshot_line_${err.index >= 0 ? err.index + 1 : "unknown"}.jpg`}
              className="rounded-md border border-red-200 bg-white px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-100"
            >
              Download screenshot
            </a>
          </div>
          <div className="max-h-[72vh] overflow-auto rounded border border-red-200 bg-white">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`data:image/jpeg;base64,${err.image}`}
              alt="Browser state on error"
              className="block min-w-[900px] max-w-none shadow-sm"
            />
          </div>
        </div>
      ))}
    </div>
  );
}
