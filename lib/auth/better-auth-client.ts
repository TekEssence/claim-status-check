"use client";

import { createAuthClient } from "better-auth/react";
import { adminClient, usernameClient } from "better-auth/client/plugins";

export const betterAuthClient = createAuthClient({
  basePath: "/api/better-auth",
  plugins: [usernameClient(), adminClient()],
});
