import { getScrapeJobDownload, type CurrentScrapeJob } from "../../../api/scrape-jobs-api";
import type { ErrorScreenshot, ScrapeJobEvent } from "../../../types/job";
import { DOWNLOADED_ARTIFACTS_PREFIX } from "./model";

export type DownloadFile = {
  filename: string;
  bytes: Uint8Array;
};
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function downloadTextFile(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  downloadBlob(filename, blob);
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binaryString = window.atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export function textToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function writeUint16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

export function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function getZipDateTime(date = new Date()): { zipDate: number; zipTime: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    zipDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    zipTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

export function createZip(files: DownloadFile[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  const { zipDate, zipTime } = getZipDateTime();

  for (const file of files) {
    const filenameBytes = textToBytes(file.filename.replace(/\\/g, "/"));
    const checksum = crc32(file.bytes);

    const localHeader = new Uint8Array(30 + filenameBytes.length);
    writeUint32(localHeader, 0, 0x04034b50);
    writeUint16(localHeader, 4, 20);
    writeUint16(localHeader, 6, 0);
    writeUint16(localHeader, 8, 0);
    writeUint16(localHeader, 10, zipTime);
    writeUint16(localHeader, 12, zipDate);
    writeUint32(localHeader, 14, checksum);
    writeUint32(localHeader, 18, file.bytes.length);
    writeUint32(localHeader, 22, file.bytes.length);
    writeUint16(localHeader, 26, filenameBytes.length);
    writeUint16(localHeader, 28, 0);
    localHeader.set(filenameBytes, 30);

    localParts.push(localHeader, file.bytes);

    const centralHeader = new Uint8Array(46 + filenameBytes.length);
    writeUint32(centralHeader, 0, 0x02014b50);
    writeUint16(centralHeader, 4, 20);
    writeUint16(centralHeader, 6, 20);
    writeUint16(centralHeader, 8, 0);
    writeUint16(centralHeader, 10, 0);
    writeUint16(centralHeader, 12, zipTime);
    writeUint16(centralHeader, 14, zipDate);
    writeUint32(centralHeader, 16, checksum);
    writeUint32(centralHeader, 20, file.bytes.length);
    writeUint32(centralHeader, 24, file.bytes.length);
    writeUint16(centralHeader, 28, filenameBytes.length);
    writeUint16(centralHeader, 30, 0);
    writeUint16(centralHeader, 32, 0);
    writeUint16(centralHeader, 34, 0);
    writeUint16(centralHeader, 36, 0);
    writeUint32(centralHeader, 38, 0);
    writeUint32(centralHeader, 42, offset);
    centralHeader.set(filenameBytes, 46);
    centralParts.push(centralHeader);

    offset += localHeader.length + file.bytes.length;
  }

  const centralDirectory = concatBytes(centralParts);
  const endRecord = new Uint8Array(22);
  writeUint32(endRecord, 0, 0x06054b50);
  writeUint16(endRecord, 4, 0);
  writeUint16(endRecord, 6, 0);
  writeUint16(endRecord, 8, files.length);
  writeUint16(endRecord, 10, files.length);
  writeUint32(endRecord, 12, centralDirectory.length);
  writeUint32(endRecord, 16, offset);
  writeUint16(endRecord, 20, 0);

  return concatBytes([...localParts, centralDirectory, endRecord]);
}

export function downloadZip(filename: string, files: DownloadFile[]): void {
  if (!files.length) return;
  const zipBytes = createZip(files);
  const arrayBuffer = zipBytes.buffer.slice(zipBytes.byteOffset, zipBytes.byteOffset + zipBytes.byteLength) as ArrayBuffer;
  downloadBlob(filename, new Blob([arrayBuffer], { type: "application/zip" }));
}

export async function downloadStoredJobOutputOnce(jobId: string): Promise<string | null> {
  if (typeof window === "undefined" || !jobId) return null;
  const storageKey = `claim-status:auto-downloaded:${jobId}`;
  if (window.localStorage.getItem(storageKey) === "true") return null;
  const { filename, downloadUrl } = await getScrapeJobDownload(jobId);
  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = filename;
  link.rel = "noreferrer";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.localStorage.setItem(storageKey, "true");
  return filename;
}
export function downloadBase64File(filename: string, base64: string, type: string): void {
  const bytes = base64ToBytes(base64);
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  downloadBlob(filename, new Blob([arrayBuffer], { type }));
}

export function getEventRowIndex(eventData: ScrapeJobEvent): number {
  if (typeof eventData.index === "number") return eventData.index;
  if (typeof eventData.rowIndex === "number") return Math.max(0, eventData.rowIndex - 1);
  return -1;
}

export function screenshotsFromArtifacts(currentJob: CurrentScrapeJob): ErrorScreenshot[] {
  return (currentJob.artifacts ?? [])
    .filter((artifact) => artifact.artifactType === "error_screenshot" && artifact.contentBase64)
    .map((artifact) => ({
      index: artifact.rowIndex === null || artifact.rowIndex === undefined ? -1 : artifact.rowIndex,
      image: artifact.contentBase64 ?? "",
    }));
}

export function downloadDebugHtmlArtifacts(currentJob: CurrentScrapeJob): void {
  for (const artifact of currentJob.artifacts ?? []) {
    if (artifact.artifactType !== "debug_html" || !artifact.contentText) continue;
    const artifactKey = `${artifact.artifactType}:${artifact.id}:${artifact.filename || artifact.createdAt}`;
    if (hasDownloadedArtifact(currentJob.jobId, artifactKey)) continue;
    downloadTextFile(
      artifact.filename || `debug_dom_line_${artifact.rowIndex === null || artifact.rowIndex === undefined ? "unknown" : artifact.rowIndex + 1}.html`,
      artifact.contentText,
      artifact.mimeType || "text/html",
    );
    rememberDownloadedArtifact(currentJob.jobId, artifactKey);
  }
}

export function getDownloadedArtifactsKey(jobId: string): string {
  return `${DOWNLOADED_ARTIFACTS_PREFIX}${jobId}`;
}

export function getDownloadedArtifactSet(jobId: string): Set<string> {
  if (typeof window === "undefined" || !jobId) return new Set<string>();
  try {
    const raw = window.localStorage.getItem(getDownloadedArtifactsKey(jobId));
    if (!raw) return new Set<string>();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set<string>();
  }
}

export function rememberDownloadedArtifact(jobId: string, artifactKey: string): void {
  if (typeof window === "undefined" || !jobId || !artifactKey) return;
  const current = getDownloadedArtifactSet(jobId);
  current.add(artifactKey);
  try {
    window.localStorage.setItem(getDownloadedArtifactsKey(jobId), JSON.stringify(Array.from(current)));
  } catch {
    // Best effort only.
  }
}

export function hasDownloadedArtifact(jobId: string, artifactKey: string): boolean {
  return getDownloadedArtifactSet(jobId).has(artifactKey);
}

export function buildDownloadArtifactKey(eventData: ScrapeJobEvent): string {
  return [
    eventData.type ?? "",
    String(getEventRowIndex(eventData)),
    eventData.filename ?? "",
    eventData.path ?? "",
  ].join("|");
}
