import { JobProgress } from "../../components/JobProgress";
import { LogsPanel } from "../../components/LogsPanel";
import { ScreenshotViewer } from "../../components/ScreenshotViewer";
import { StatusMessage } from "../../components/StatusMessage";
import type { ErrorScreenshot, JobProgressValue } from "../../types/job";

export function AerialResultView({
  errorScreenshots,
  logs,
  progress,
  status,
}: {
  errorScreenshots: ErrorScreenshot[];
  logs: string[];
  progress: JobProgressValue | null;
  status: string;
}) {
  return (
    <>
      <JobProgress progress={progress} />
      <StatusMessage status={status} />
      <ScreenshotViewer screenshots={errorScreenshots} />
      <LogsPanel logs={logs} />
    </>
  );
}
