import fs from "node:fs/promises";
import path from "node:path";
import { blueShieldWritableDataPath } from "./storage";

export type BlueShieldCheckpoint = {
  checkpointId: string;
  lastCompletedMember: string;
  completedMembers: string[];
  outputWorkbookPath: string;
  updatedAt: string;
};

function safeId(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "blue-shield";
}

export function getBlueShieldCheckpointPath(checkpointId: string): string {
  return blueShieldWritableDataPath("checkpoints", "blue-shield", `${safeId(checkpointId)}.json`);
}

export async function readBlueShieldCheckpoint(checkpointId: string): Promise<BlueShieldCheckpoint | null> {
  const checkpointPath = getBlueShieldCheckpointPath(checkpointId);
  const content = await fs.readFile(checkpointPath, "utf8").catch(() => "");
  if (!content) return null;
  return JSON.parse(content) as BlueShieldCheckpoint;
}

export async function clearBlueShieldCheckpoint(checkpointId: string): Promise<void> {
  await fs.unlink(getBlueShieldCheckpointPath(checkpointId)).catch(() => {});
}

export async function saveBlueShieldCheckpoint(checkpoint: BlueShieldCheckpoint): Promise<string> {
  const checkpointPath = getBlueShieldCheckpointPath(checkpoint.checkpointId);
  await fs.mkdir(path.dirname(checkpointPath), { recursive: true });
  await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2), "utf8");
  return checkpointPath;
}
