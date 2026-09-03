import { spawnSync } from "node:child_process";

const env = {
  ...process.env,
  NEXT_PUBLIC_WORKFLOW_API_URL: process.env.NEXT_PUBLIC_WORKFLOW_API_URL || "/api",
  NEXT_PUBLIC_WORKFLOW_WS_URL: process.env.NEXT_PUBLIC_WORKFLOW_WS_URL || "wss://4pm4ynxb9a.execute-api.us-east-1.amazonaws.com/$default",
  NEXT_PUBLIC_COGNITO_USER_POOL_ID: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID || "us-east-1_ZlCXMIGOA",
  NEXT_PUBLIC_COGNITO_CLIENT_ID: process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID || "4t8bi0o88rjq6epg8mvdqe47mv",
  NEXT_PUBLIC_COGNITO_DOMAIN: process.env.NEXT_PUBLIC_COGNITO_DOMAIN || "https://claim-status-dev-033995042643.auth.us-east-1.amazoncognito.com",
};

const result = spawnSync("node", ["scripts/build-static-frontend.mjs"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env,
});

if (result.error) {
  console.error(result.error);
}

process.exit(result.status ?? 1);
