import type { APIRequestContext, BrowserContext } from "playwright-core";
import { AvailityNetworkError, assertSuccessfulJsonResponse } from "./errors";
import type {
  AvailityAcceptedSearch,
  AvailityDetailSearchRequest,
  AvailityDetailSearchResponse,
  AvailityNetworkClientOptions,
  AvailitySummarySearchRequest,
  AvailitySummarySearchResponse,
} from "./types";

const DEFAULT_BASE_URL = "https://essentials.availity.com";
const DEFAULT_REFERER = "https://essentials.availity.com/static/web/post/cs/enhanced-claim-status-ui/";
const SUMMARY_SEARCH_PATH = "/cloud/web/post/enhanced-claim-status/claim-status/internal/v1/status/summarySearch";
const DETAIL_SEARCH_PATH = "/cloud/web/post/enhanced-claim-status/claim-status/internal/v1/status/detailSearch";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function extractSearchId(headers: Record<string, string>): string {
  const transactionId = headers["x-global-transaction-id"] || headers["X-Global-Transaction-Id"];
  if (transactionId) return transactionId;

  const location = headers.location || headers.Location || "";
  const match = /\/([^/?#]+)$/.exec(location);
  return match?.[1] || "";
}

async function getXsrfToken(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies();
  return cookies.find((cookie) => cookie.name === "XSRF-TOKEN")?.value || "";
}

async function defaultHeaders(context: BrowserContext, options: {
  referer: string;
  baseUrl: string;
  customerId?: string;
  clientId?: string;
}): Promise<Record<string, string>> {
  const xsrfToken = await getXsrfToken(context);
  const headers: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    origin: options.baseUrl,
    referer: options.referer,
  };

  if (xsrfToken) {
    headers["x-xsrf-token"] = xsrfToken;
  }
  if (options.customerId) {
    headers["x-availity-customer-id"] = options.customerId;
  }
  if (options.clientId) {
    headers["x-client-id"] = options.clientId;
  }

  return headers;
}

async function postAcceptedSearch(
  request: APIRequestContext,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  action: string,
): Promise<AvailityAcceptedSearch> {
  const response = await request.post(url, {
    headers,
    data: body,
  });
  const responseHeaders = response.headers();

  if (response.status() !== 202) {
    await assertSuccessfulJsonResponse(response, action);
    throw new AvailityNetworkError(`${action} expected HTTP 202 but received HTTP ${response.status()}.`, {
      status: response.status(),
    });
  }

  const id = extractSearchId(responseHeaders);
  if (!id) {
    throw new AvailityNetworkError(`${action} returned HTTP 202 but no search id was found in response headers.`, {
      status: response.status(),
    });
  }

  return {
    id,
    location: responseHeaders.location || "",
    response,
  };
}

export class AvailityNetworkClient {
  private context: BrowserContext;
  private request: APIRequestContext;
  private baseUrl: string;
  private referer: string;
  private customerId: string;
  private clientId: string;

  constructor(options: AvailityNetworkClientOptions) {
    this.context = options.context;
    this.request = options.context.request;
    this.baseUrl = trimTrailingSlash(options.baseUrl || DEFAULT_BASE_URL);
    this.referer = options.referer || DEFAULT_REFERER;
    this.customerId = String(options.customerId || "").trim();
    this.clientId = String(options.clientId || "").trim();
  }

  async startSummarySearch(input: AvailitySummarySearchRequest): Promise<AvailityAcceptedSearch> {
    return postAcceptedSearch(
      this.request,
      `${this.baseUrl}${SUMMARY_SEARCH_PATH}`,
      await defaultHeaders(this.context, {
        referer: this.referer,
        baseUrl: this.baseUrl,
        customerId: this.customerId,
        clientId: this.clientId,
      }),
      {
        ...input,
        requestType: input.requestType || "SERVICE_DATE",
      },
      "Availity summary search",
    );
  }

  async getSummarySearchResult(id: string, options: { limit?: number; offset?: number } = {}): Promise<AvailitySummarySearchResponse> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const response = await this.request.get(`${this.baseUrl}${SUMMARY_SEARCH_PATH}`, {
      headers: await defaultHeaders(this.context, {
        referer: this.referer,
        baseUrl: this.baseUrl,
        customerId: this.customerId,
        clientId: this.clientId,
      }),
      params: {
        id,
        limit: String(limit),
        offset: String(offset),
      },
    });
    return assertSuccessfulJsonResponse<AvailitySummarySearchResponse>(response, "Availity summary result retrieval");
  }

  async getAllSummarySearchResults(id: string, options: { limit?: number } = {}): Promise<AvailitySummarySearchResponse> {
    const limit = options.limit ?? 50;
    let offset = 0;
    const allItems: NonNullable<AvailitySummarySearchResponse["items"]> = [];
    let merged: AvailitySummarySearchResponse | null = null;

    while (true) {
      const page = await this.getSummarySearchResult(id, { limit, offset });
      allItems.push(...(page.items || []));
      merged = {
        ...page,
        items: allItems,
        count: allItems.length,
      };

      const totalCount = page.totalCount ?? allItems.length;
      if (allItems.length >= totalCount || (page.items || []).length === 0) {
        return merged;
      }

      offset += limit;
    }
  }

  async startDetailSearch(input: AvailityDetailSearchRequest): Promise<AvailityAcceptedSearch> {
    return postAcceptedSearch(
      this.request,
      `${this.baseUrl}${DETAIL_SEARCH_PATH}`,
      await defaultHeaders(this.context, {
        referer: this.referer,
        baseUrl: this.baseUrl,
        customerId: this.customerId,
        clientId: this.clientId,
      }),
      {
        ...input,
        requestType: input.requestType || "CLAIM_NUMBER",
      },
      "Availity detail search",
    );
  }

  async getDetailSearchResult(id: string): Promise<AvailityDetailSearchResponse> {
    const response = await this.request.get(`${this.baseUrl}${DETAIL_SEARCH_PATH}`, {
      headers: await defaultHeaders(this.context, {
        referer: this.referer,
        baseUrl: this.baseUrl,
        customerId: this.customerId,
        clientId: this.clientId,
      }),
      params: { id },
    });
    return assertSuccessfulJsonResponse<AvailityDetailSearchResponse>(response, "Availity detail result retrieval");
  }
}
