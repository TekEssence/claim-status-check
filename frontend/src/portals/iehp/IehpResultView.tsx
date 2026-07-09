import { LogsPanel } from "../../components/LogsPanel";
import { ScreenshotViewer } from "../../components/ScreenshotViewer";
import { StatusMessage } from "../../components/StatusMessage";
import type { ErrorScreenshot } from "../../types/job";

export function IehpResultView({
  errorScreenshots,
  logs,
  status,
}: {
  errorScreenshots: ErrorScreenshot[];
  logs: string[];
  status: string;
}) {
  return (
    <>
      <StatusMessage status={status} />
      <ScreenshotViewer screenshots={errorScreenshots} />
      <LogsPanel logs={logs} />
    </>
  );
}


