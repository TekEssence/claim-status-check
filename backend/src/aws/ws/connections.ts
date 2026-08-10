import { jsonResponse, type ApiEvent } from "../runtime/http";
import { getUserIdFromVerifiedJwt, verifyCognitoJwt } from "../runtime/cognito-jwt";
import { getWorkflowJobForUser, registerConnection, removeConnection } from "../runtime/workflow-db";

async function userIdFromWebSocket(event: ApiEvent): Promise<string> {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  if (claims?.sub || claims?.username || claims?.["cognito:username"]) {
    return claims.sub || claims.username || claims["cognito:username"] || "";
  }

  const token = event.queryStringParameters?.token?.trim();
  if (!token) throw new Error("Missing WebSocket token.");
  return getUserIdFromVerifiedJwt(await verifyCognitoJwt(token));
}

export async function connect(event: ApiEvent) {
  const connectionId = event.requestContext?.connectionId;
  if (!connectionId) return jsonResponse(400, { error: "Missing connection id." });

  let userId = "";
  try {
    userId = await userIdFromWebSocket(event);
    const jobId = event.queryStringParameters?.jobId?.trim() || undefined;
    if (jobId) {
      const job = await getWorkflowJobForUser(jobId, userId);
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
