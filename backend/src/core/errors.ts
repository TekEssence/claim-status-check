export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class UnknownPortalError extends AppError {
  constructor(portalId: string) {
    super(`Unknown portal: ${portalId}`, "UNKNOWN_PORTAL", { portalId });
    this.name = "UnknownPortalError";
  }
}
