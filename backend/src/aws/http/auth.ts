import { jsonResponse, parseJsonBody, type ApiEvent } from "../runtime/http";
import { passwordPolicyErrorMessage } from "../../../../lib/auth/password-policy";

type CognitoError = {
  __type?: string;
  code?: string;
  message?: string;
};

type AuthResult = {
  AccessToken?: string;
  IdToken?: string;
  RefreshToken?: string;
  ExpiresIn?: number;
  TokenType?: string;
};

type CognitoAuthResponse = {
  AuthenticationResult?: AuthResult;
  ChallengeName?: string;
  Session?: string;
};

type CognitoSignUpResponse = {
  UserConfirmed?: boolean;
  UserSub?: string;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured.`);
  return value;
}

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePassword(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeDisplayUsername(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cognitoEndpoint(): string {
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
  return `https://cognito-idp.${region}.amazonaws.com/`;
}

function cognitoMessage(status: number, body: CognitoError): string {
  const type = String(body.__type || body.code || "").split("#").pop() || "";
  if (type === "UserNotFoundException" || type === "NotAuthorizedException") {
    return "Invalid email or password.";
  }
  if (type === "CodeMismatchException") return "Invalid verification code.";
  if (type === "ExpiredCodeException") return "Verification code expired. Request a new code.";
  if (type === "InvalidPasswordException") {
    return body.message || "Password does not meet the required policy.";
  }
  if (type === "LimitExceededException" || type === "TooManyRequestsException") {
    return "Too many attempts. Please wait and try again.";
  }
  return body.message || `Cognito request failed with status ${status}.`;
}

async function callCognito<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(cognitoEndpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSCognitoIdentityProviderService.${action}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(cognitoMessage(response.status, data as CognitoError));
  }
  return data as T;
}

function tokenResponse(result: AuthResult | undefined) {
  if (!result?.AccessToken || !result.IdToken) {
    throw new Error("Cognito did not return login tokens.");
  }
  return {
    accessToken: result.AccessToken,
    idToken: result.IdToken,
    refreshToken: result.RefreshToken || "",
    expiresIn: result.ExpiresIn || 0,
    tokenType: result.TokenType || "Bearer",
  };
}

export async function login(event: ApiEvent) {
  try {
    const body = parseJsonBody<{ email?: unknown; password?: unknown }>(event);
    const email = normalizeEmail(body.email);
    const password = normalizePassword(body.password);
    if (!email || !email.includes("@") || !password) {
      return jsonResponse(400, { error: "Email and password are required." });
    }

    const clientId = required("COGNITO_CLIENT_ID");
    const response = await callCognito<CognitoAuthResponse>("InitiateAuth", {
      ClientId: clientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: {
        USERNAME: email,
        PASSWORD: password,
      },
    });

    if (response.ChallengeName) {
      return jsonResponse(200, {
        challenge: {
          name: response.ChallengeName,
          session: response.Session || "",
          email,
        },
      });
    }

    return jsonResponse(200, { tokens: tokenResponse(response.AuthenticationResult) });
  } catch (error) {
    return jsonResponse(400, { error: error instanceof Error ? error.message : "Login failed." });
  }
}

export async function startForgotPassword(event: ApiEvent) {
  try {
    const body = parseJsonBody<{ email?: unknown }>(event);
    const email = normalizeEmail(body.email);
    if (!email || !email.includes("@")) {
      return jsonResponse(400, { error: "A valid email is required." });
    }

    await callCognito("ForgotPassword", {
      ClientId: required("COGNITO_CLIENT_ID"),
      Username: email,
    });
    return jsonResponse(200, { ok: true });
  } catch (error) {
    return jsonResponse(400, { error: error instanceof Error ? error.message : "Unable to send verification code." });
  }
}

export async function confirmForgotPassword(event: ApiEvent) {
  try {
    const body = parseJsonBody<{ email?: unknown; code?: unknown; password?: unknown; confirmPassword?: unknown }>(event);
    const email = normalizeEmail(body.email);
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const password = normalizePassword(body.password);
    if (!email || !email.includes("@") || !code || !password) {
      return jsonResponse(400, { error: "Email, verification code, and new password are required." });
    }
    if (password !== body.confirmPassword) {
      return jsonResponse(400, { error: "Password and confirm password must match." });
    }
    const policyError = passwordPolicyErrorMessage(password);
    if (policyError) {
      return jsonResponse(400, { error: policyError });
    }

    await callCognito("ConfirmForgotPassword", {
      ClientId: required("COGNITO_CLIENT_ID"),
      Username: email,
      ConfirmationCode: code,
      Password: password,
    });
    return jsonResponse(200, { ok: true });
  } catch (error) {
    return jsonResponse(400, { error: error instanceof Error ? error.message : "Unable to reset password." });
  }
}

export async function completeNewPassword(event: ApiEvent) {
  try {
    const body = parseJsonBody<{ email?: unknown; session?: unknown; password?: unknown; confirmPassword?: unknown }>(event);
    const email = normalizeEmail(body.email);
    const session = typeof body.session === "string" ? body.session : "";
    const password = normalizePassword(body.password);
    if (!email || !email.includes("@") || !session || !password) {
      return jsonResponse(400, { error: "Email, Cognito session, and new password are required." });
    }
    if (password !== body.confirmPassword) {
      return jsonResponse(400, { error: "Password and confirm password must match." });
    }
    const policyError = passwordPolicyErrorMessage(password);
    if (policyError) {
      return jsonResponse(400, { error: policyError });
    }

    const response = await callCognito<CognitoAuthResponse>("RespondToAuthChallenge", {
      ClientId: required("COGNITO_CLIENT_ID"),
      ChallengeName: "NEW_PASSWORD_REQUIRED",
      Session: session,
      ChallengeResponses: {
        USERNAME: email,
        NEW_PASSWORD: password,
      },
    });
    return jsonResponse(200, { tokens: tokenResponse(response.AuthenticationResult) });
  } catch (error) {
    return jsonResponse(400, { error: error instanceof Error ? error.message : "Unable to complete password setup." });
  }
}

export async function startSignUp(event: ApiEvent) {
  try {
    const body = parseJsonBody<{ email?: unknown; username?: unknown; password?: unknown; confirmPassword?: unknown }>(event);
    const email = normalizeEmail(body.email).toLowerCase();
    const username = normalizeDisplayUsername(body.username);
    const password = normalizePassword(body.password);
    if (!email || !email.includes("@") || !username || !password) {
      return jsonResponse(400, { error: "Email, username, and password are required." });
    }
    if (password !== body.confirmPassword) {
      return jsonResponse(400, { error: "Password and confirm password must match." });
    }
    const policyError = passwordPolicyErrorMessage(password);
    if (policyError) {
      return jsonResponse(400, { error: policyError });
    }

    const response = await callCognito<CognitoSignUpResponse>("SignUp", {
      ClientId: required("COGNITO_CLIENT_ID"),
      Username: email,
      Password: password,
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "name", Value: username },
        { Name: "preferred_username", Value: username },
      ],
    });
    return jsonResponse(200, { ok: true, userConfirmed: Boolean(response.UserConfirmed), userSub: response.UserSub || "" });
  } catch (error) {
    return jsonResponse(400, { error: error instanceof Error ? error.message : "Unable to create account." });
  }
}

export async function confirmSignUp(event: ApiEvent) {
  try {
    const body = parseJsonBody<{ email?: unknown; code?: unknown }>(event);
    const email = normalizeEmail(body.email).toLowerCase();
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!email || !email.includes("@") || !code) {
      return jsonResponse(400, { error: "Email and verification code are required." });
    }

    await callCognito("ConfirmSignUp", {
      ClientId: required("COGNITO_CLIENT_ID"),
      Username: email,
      ConfirmationCode: code,
    });
    return jsonResponse(200, { ok: true });
  } catch (error) {
    return jsonResponse(400, { error: error instanceof Error ? error.message : "Unable to confirm account." });
  }
}
