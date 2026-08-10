import {
  ApiGatewayManagementApiClient,
  DeleteConnectionCommand,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { listConnectionsForJob, removeConnection } from "./workflow-db";

let client: ApiGatewayManagementApiClient | null = null;

function managementClient(): ApiGatewayManagementApiClient | null {
  const endpoint = process.env.WEBSOCKET_MANAGEMENT_ENDPOINT?.trim();
  if (!endpoint) return null;
  if (!client) client = new ApiGatewayManagementApiClient({ endpoint });
  return client;
}

function shouldPublish(event: Record<string, unknown>): boolean {
  const type = String(event.type ?? "");
  return [
    "job_started",
    "task_starting",
    "progress",
    "log",
    "otp_required",
    "mfa_required",
    "input_required",
    "cancellation_acknowledged",
    "cancelled",
    "completed",
    "failed",
    "output_ready",
    "done",
    "heartbeat",
  ].includes(type);
}

async function dropConnection(connectionId: string): Promise<void> {
  await removeConnection(connectionId).catch(() => {});
  const api = managementClient();
  if (!api) return;
  await api.send(new DeleteConnectionCommand({ ConnectionId: connectionId })).catch(() => {});
}

export async function publishWorkflowEvent(jobId: string, event: Record<string, unknown>, id?: number | null): Promise<void> {
  if (!shouldPublish(event)) return;
  const api = managementClient();
  if (!api) return;

  const connections = await listConnectionsForJob(jobId).catch(() => []);
  if (connections.length === 0) return;

  const body = Buffer.from(JSON.stringify({ id: id ?? undefined, payload: event }));
  await Promise.all(connections.map(async (connection) => {
    try {
      await api.send(new PostToConnectionCommand({
        ConnectionId: connection.connectionId,
        Data: body,
      }));
    } catch (error) {
      const statusCode = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (statusCode === 410 || (error as Error).name === "GoneException") {
        await dropConnection(connection.connectionId);
      } else {
        console.warn("WebSocket event publish failed", {
          jobId,
          connectionId: connection.connectionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }));
}
