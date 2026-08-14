import { AvailityNetworkError } from "./errors";
import { normalizeClaimDetail, normalizeSummaryItems } from "./normalizers";
import type {
  AvailityDetailSearchRequest,
  AvailityNetworkClientOptions,
  AvailityNormalizedClaimDetail,
  AvailityNormalizedSummaryRow,
  AvailitySummarySearchRequest,
} from "./types";
import { AvailityNetworkClient } from "./client";

export type AvailitySummarySearchResult = {
  searchId: string;
  parentTransactionId: string;
  rows: AvailityNormalizedSummaryRow[];
  raw: unknown;
};

export type AvailityClaimDetailResult = {
  searchId: string;
  detail: AvailityNormalizedClaimDetail;
  raw: unknown;
};

export class AvailityClaimSearchService {
  private client: AvailityNetworkClient;

  constructor(options: AvailityNetworkClientOptions) {
    this.client = new AvailityNetworkClient(options);
  }

  async searchSummary(input: AvailitySummarySearchRequest): Promise<AvailitySummarySearchResult> {
    const accepted = await this.client.startSummarySearch(input);
    const response = await this.getSummarySearchResultWithPolling(accepted.id);
    const parentTransactionId = response.traceIds?.AVAILITY_TRACE_ID || accepted.id;

    return {
      searchId: accepted.id,
      parentTransactionId,
      rows: normalizeSummaryItems(response.items || []),
      raw: response,
    };
  }

  private async getSummarySearchResultWithPolling(id: string) {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        const response = await this.client.getAllSummarySearchResults(id);
        return response;
      } catch (error) {
        lastError = error;
        const retryable = error instanceof AvailityNetworkError && error.retryable && !error.authFailure;
        if (!retryable) {
          throw error;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw lastError instanceof Error
      ? lastError
      : new AvailityNetworkError("Availity summary result was not available after polling.");
  }

  async searchDetail(input: AvailityDetailSearchRequest): Promise<AvailityClaimDetailResult> {
    const accepted = await this.client.startDetailSearch(input);
    const response = await this.getDetailSearchResultWithPolling(accepted.id);

    if (!response.claim) {
      throw new AvailityNetworkError("Availity detail result did not include a claim object.", {
        completeCode: response.completeCode,
        traceId: response.traceIds?.AVAILITY_TRACE_ID,
      });
    }

    return {
      searchId: accepted.id,
      detail: normalizeClaimDetail(response.claim),
      raw: response,
    };
  }

  private async getDetailSearchResultWithPolling(id: string) {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        const response = await this.client.getDetailSearchResult(id);
        if (response?.claim) {
          return response;
        }
        lastError = new AvailityNetworkError(`Availity detail result did not include a claim object on attempt ${attempt}.`, {
          completeCode: response?.completeCode,
          traceId: response?.traceIds?.AVAILITY_TRACE_ID,
          retryable: true,
        });
      } catch (error) {
        lastError = error;
        const retryable = error instanceof AvailityNetworkError && error.retryable && !error.authFailure;
        if (!retryable) {
          throw error;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw lastError instanceof Error
      ? lastError
      : new AvailityNetworkError("Availity detail result was not available after polling.");
  }

  async searchSummaryThenDetail(input: {
    summary: AvailitySummarySearchRequest;
    selectRow?: (rows: AvailityNormalizedSummaryRow[]) => AvailityNormalizedSummaryRow | null;
  }): Promise<{
    summary: AvailitySummarySearchResult;
    selectedRow: AvailityNormalizedSummaryRow;
    detail: AvailityClaimDetailResult;
  }> {
    const summary = await this.searchSummary(input.summary);
    const selectedRow = input.selectRow
      ? input.selectRow(summary.rows)
      : summary.rows[0] || null;

    if (!selectedRow) {
      throw new AvailityNetworkError("Availity summary search returned no selectable claim rows.");
    }

    const detail = await this.searchDetail({
      parentTransactionId: summary.parentTransactionId,
      payerId: input.summary.payerId,
      requestType: "CLAIM_NUMBER",
      claimNumber: selectedRow.claimNumber,
      claimIndex: selectedRow.claimIndex,
      providerNpi: input.summary.providerNpi,
    });

    return {
      summary,
      selectedRow,
      detail,
    };
  }
}
