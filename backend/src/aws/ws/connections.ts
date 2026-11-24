import { getAuthUserId, hasFullWorkflowAccess, jsonResponse, type ApiEvent } from "../runtime/http";
import { verifyCognitoJwt } from "../runtime/cognito-jwt";
import { getWorkflowJobById, getWorkflowJobForUser, registerConnection, removeConnection } from "../runtime/workflow-db";

async function authenticateWebSocket(event: ApiEvent): Promise<ApiEvent> {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  if (claims?.sub || claims?.username || claims?.["cognito:username"]) {
    return event;
  }

  const token = event.queryStringParameters?.token?.trim();
  if (!token) throw new Error("Missing WebSocket token.");
  const verifiedClaims = await verifyCognitoJwt(token);
  return {
    ...event,
    requestContext: {
      ...event.requestContext,
      authorizer: { jwt: { claims: verifiedClaims as Record<string, string | undefined> } },
    },
  };
}

export async function connect(event: ApiEvent) {
  const connectionId = event.requestContext?.connectionId;
  if (!connectionId) return jsonResponse(400, { error: "Missing connection id." });

  let userId = "";
  try {
    event = await authenticateWebSocket(event);
    userId = getAuthUserId(event);
    const jobId = event.queryStringParameters?.jobId?.trim() || undefined;
    if (jobId) {
      const job = hasFullWorkflowAccess(event) ? await getWorkflowJobById(jobId) : await getWorkflowJobForUser(jobId, userId);
      if (!job) return jsonResponse(403, { error: "WebSocket job access denied." });
    }

    await registerConnection({
      connectionId,
      userId,
      jobId,
    });
  } catch (error) {
    console.error("WebSocket connection registration failed", {
      connectionId,
      jobId: event.queryStringParameters?.jobId || "",
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonResponse(401, { error: "WebSocket authentication failed." });
  }
  return { statusCode: 200, body: "connected" };
}

export async function disconnect(event: ApiEvent) {
  const connectionId = event.requestContext?.connectionId;
  if (connectionId) {
    try {
      await removeConnection(connectionId);
    } catch (error) {
      console.error("WebSocket connection cleanup failed", {
        connectionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { statusCode: 200, body: "disconnected" };
}

export async function defaultMessage() {
  return { statusCode: 200, body: "ok" };
}
