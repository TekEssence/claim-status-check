import fs from "node:fs/promises";
import path from "node:path";
import type { AutomationContext } from "../../../types";
import type { PaymentEobCredentials, PaymentEobSharePointCredentials } from "../../types";

type SharePointConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  siteUrl: string;
  folderPath: string;
};

type GraphDrive = {
  id: string;
  name?: string;
};

type GraphUploadResult = {
  webUrl?: string;
};

type GraphClient = {
  get<T>(path: string): Promise<T | null>;
  post<T>(path: string, body: unknown): Promise<T>;
  putContent<T>(path: string, content: Buffer, contentType: string): Promise<T>;
};

const ENV_KEYS = {
  tenantId: "PAYMENT_EOB_SHAREPOINT_TENANT_ID",
  clientId: "PAYMENT_EOB_SHAREPOINT_CLIENT_ID",
  clientSecret: "PAYMENT_EOB_SHAREPOINT_CLIENT_SECRET",
  siteUrl: "PAYMENT_EOB_SHAREPOINT_SITE_URL",
  folderPath: "PAYMENT_EOB_SHAREPOINT_FOLDER",
} as const;

function valueFromCredentialOrEnv(
  credentials: PaymentEobSharePointCredentials | undefined,
  key: keyof SharePointConfig,
): string {
  return (credentials?.[key]?.trim() || process.env[ENV_KEYS[key]]?.trim() || "");
}

export function resolvePaymentEobSharePointConfig(credentials: PaymentEobCredentials): SharePointConfig | null {
  const config = {
    tenantId: valueFromCredentialOrEnv(credentials.sharePoint, "tenantId"),
    clientId: valueFromCredentialOrEnv(credentials.sharePoint, "clientId"),
    clientSecret: valueFromCredentialOrEnv(credentials.sharePoint, "clientSecret"),
    siteUrl: valueFromCredentialOrEnv(credentials.sharePoint, "siteUrl"),
    folderPath: valueFromCredentialOrEnv(credentials.sharePoint, "folderPath"),
  };

  const values = Object.values(config);
  if (values.every((value) => !value)) return null;

  const missing = Object.entries(config)
    .filter(([, value]) => !value)
    .map(([key]) => ENV_KEYS[key as keyof SharePointConfig]);
  if (missing.length) {
    throw new Error(`SharePoint upload is configured but missing: ${missing.join(", ")}. Add them to the credential Excel or backend environment.`);
  }

  return config;
}

function todayYmd(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function encodeGraphPath(value: string): string {
  return trimSlashes(value)
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

function normalizeFolderParts(folderPath: string): string[] {
  return folderPath
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitDriveAndFolderPath(folderPath: string): { driveHint?: string; folderPath: string } {
  const parts = normalizeFolderParts(folderPath);
  const first = parts[0]?.toLowerCase();
  if (first === "documents" || first === "shared documents") {
    return { driveHint: parts[0], folderPath: parts.slice(1).join("/") };
  }
  return { folderPath: parts.join("/") };
}

function itemPath(folderPath: string): string {
  const encoded = encodeGraphPath(folderPath);
  return encoded ? `/root:/${encoded}` : "/root";
}

async function getAccessToken(config: SharePointConfig): Promise<string> {
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default",
    }),
  });

  if (!response.ok) {
    throw new Error(`Microsoft Graph token request failed (${response.status}): ${await response.text()}`);
  }

  const data = await response.json() as { access_token?: string };
  if (!data.access_token) throw new Error("Microsoft Graph token response did not include an access token.");
  return data.access_token;
}

function createGraphClient(accessToken: string): GraphClient {
  async function request<T>(method: string, graphPath: string, body?: unknown, contentType = "application/json"): Promise<T | null> {
    const response = await fetch(`https://graph.microsoft.com/v1.0${graphPath}`, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body == null ? {} : { "content-type": contentType }),
      },
      body: body == null
        ? undefined
        : contentType === "application/json"
          ? JSON.stringify(body)
          : body as BodyInit,
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Microsoft Graph ${method} ${graphPath} failed (${response.status}): ${await response.text()}`);
    }
    if (response.status === 204) return null;
    return await response.json() as T;
  }

  return {
    get: (graphPath) => request("GET", graphPath),
    post: async (graphPath, body) => {
      const result = await request("POST", graphPath, body);
      return result as never;
    },
    putContent: async (graphPath, content, contentType) => {
      const result = await request("PUT", graphPath, content, contentType);
      return result as never;
    },
  };
}

function siteLookupPath(siteUrl: string): string {
  const url = new URL(siteUrl);
  return `/sites/${url.hostname}:${trimSlashes(url.pathname) ? `/${trimSlashes(url.pathname)}` : ""}`;
}

async function resolveDriveId(graph: GraphClient, siteUrl: string, folderPath: string): Promise<{ driveId: string; relativeFolderPath: string }> {
  const site = await graph.get<{ id: string }>(siteLookupPath(siteUrl));
  if (!site?.id) throw new Error(`SharePoint site was not found for ${siteUrl}.`);

  const { driveHint, folderPath: relativeFolderPath } = splitDriveAndFolderPath(folderPath);
  if (!driveHint) {
    const drive = await graph.get<GraphDrive>(`/sites/${site.id}/drive`);
    if (!drive?.id) throw new Error(`Default SharePoint document library was not found for ${siteUrl}.`);
    return { driveId: drive.id, relativeFolderPath };
  }

  const drives = await graph.get<{ value: GraphDrive[] }>(`/sites/${site.id}/drives`);
  const normalizedHint = driveHint.toLowerCase();
  const drive = drives?.value.find((candidate) => candidate.name?.toLowerCase() === normalizedHint)
    ?? drives?.value.find((candidate) => ["documents", "shared documents"].includes(candidate.name?.toLowerCase() ?? ""));
  if (!drive?.id) throw new Error(`SharePoint document library "${driveHint}" was not found for ${siteUrl}.`);
  return { driveId: drive.id, relativeFolderPath };
}

async function ensureFolderPath(graph: GraphClient, driveId: string, folderPath: string): Promise<string> {
  let current = "";
  for (const part of normalizeFolderParts(folderPath)) {
    const next = current ? `${current}/${part}` : part;
    const existing = await graph.get<{ id: string }>(`/drives/${driveId}${itemPath(next)}`);
    if (!existing) {
      const parentChildrenPath = current
        ? `/drives/${driveId}${itemPath(current)}:/children`
        : `/drives/${driveId}/root/children`;
      await graph.post(parentChildrenPath, {
        name: part,
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      });
    }
    current = next;
  }
  return current;
}

async function createNextRunFolder(graph: GraphClient, driveId: string, dateFolderPath: string): Promise<string> {
  for (let index = 1; index <= 999; index += 1) {
    const runName = `run-${String(index).padStart(2, "0")}`;
    const runPath = `${dateFolderPath}/${runName}`;
    const existing = await graph.get<{ id: string }>(`/drives/${driveId}${itemPath(runPath)}`);
    if (existing) continue;
    await graph.post(`/drives/${driveId}${itemPath(dateFolderPath)}:/children`, {
      name: runName,
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail",
    });
    return runPath;
  }
  throw new Error(`Could not create a new run folder under ${dateFolderPath}.`);
}

async function listFilesRecursive(root: string, current = ""): Promise<Array<{ localPath: string; relativePath: string }>> {
  const absolute = path.join(root, current);
  const entries = await fs.readdir(absolute, { withFileTypes: true });
  const files: Array<{ localPath: string; relativePath: string }> = [];

  for (const entry of entries) {
    const relativePath = current ? `${current}/${entry.name}` : entry.name;
    const localPath = path.join(root, relativePath);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(root, relativePath));
    } else if (entry.isFile()) {
      files.push({ localPath, relativePath: relativePath.replace(/\\/g, "/") });
    }
  }

  return files;
}

function contentTypeFor(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".csv") return "text/csv";
  if (extension === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (extension === ".html") return "text/html";
  if (extension === ".png") return "image/png";
  return "application/octet-stream";
}

export async function uploadPaymentEobOutputToSharePoint(
  credentials: PaymentEobCredentials,
  outputRoot: string,
  context: AutomationContext,
): Promise<void> {
  const config = resolvePaymentEobSharePointConfig(credentials);
  if (!config) {
    await context.log({ level: "info", message: "SharePoint upload not configured; keeping Payment EOB outputs in the local job output folder.", eventName: "payment_eob_sharepoint_skip" });
    return;
  }

  await context.log({ level: "info", message: "Uploading Payment EOB output files to SharePoint.", eventName: "payment_eob_sharepoint_start" });
  const graph = createGraphClient(await getAccessToken(config));
  const { driveId, relativeFolderPath } = await resolveDriveId(graph, config.siteUrl, config.folderPath);
  const dateFolderPath = await ensureFolderPath(graph, driveId, `${relativeFolderPath}/${todayYmd()}`);
  const runFolderPath = await createNextRunFolder(graph, driveId, dateFolderPath);
  const files = await listFilesRecursive(outputRoot);

  for (const file of files) {
    const targetPath = `${runFolderPath}/${file.relativePath}`;
    const targetFolderPath = targetPath.split("/").slice(0, -1).join("/");
    await ensureFolderPath(graph, driveId, targetFolderPath);
    const content = await fs.readFile(file.localPath);
    await graph.putContent<GraphUploadResult>(
      `/drives/${driveId}/root:/${encodeGraphPath(targetPath)}:/content`,
      content,
      contentTypeFor(file.relativePath),
    );
  }

  await context.log({
    level: "info",
    message: `Uploaded ${files.length} Payment EOB file(s) to SharePoint folder ${config.folderPath}/${todayYmd()}/${path.basename(runFolderPath)}.`,
    eventName: "payment_eob_sharepoint_complete",
  });
}
