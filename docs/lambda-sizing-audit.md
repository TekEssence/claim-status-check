# Claim Status dev Lambda sizing audit

Inspected on 12 November 2026, `us-east-1`. This is a read-only assessment;
no Lambda memory, timeout, application code or deployment was changed.

## Scope and observations

API Gateway integration/route mappings identify **25 deployed functions**:
21 HTTP handlers, 3 WebSocket handlers and 1 watchdog. The two aliases
`GET /service/jobs/{jobId}/result` and `/results` each have their own Lambda,
although both execute `getServiceJobResult`.

All HTTP/WebSocket functions currently allocate 1024 MB with a 20-second
timeout. The watchdog allocates 512 MB with a 60-second timeout. These HTTP
and WebSocket sizes come from SST defaults rather than per-handler decisions.

A CloudWatch Logs Insights query scanned the mapped log groups for the
preceding seven days and returned only aggregate Lambda REPORT measurements.
There were 29,641 REPORT records across 16 active functions; 9 functions had
no REPORT records in this window. No request bodies, credentials or patient
data were returned. Log-group configuration was obtained from Lambda's
`LoggingConfig`, rather than assuming log groups match current function names.

Observed maxima below use the MB values represented by REPORT measurements
(CloudWatch's parsed byte field divided by 1,000,000). These are execution
environment high-water marks, not precise independent per-request samples.
The window can span multiple deployed code versions and does not establish
the worst case for 10,000 claims or many detail rows.

| Route/handler | REPORT records | Maximum reported memory | p95 execution duration |
|---|---:|---:|---:|
| `GET /service/jobs/{jobId}/results` | 1,839 | 238 MB | 3,561 ms |
| `GET /jobs` | 8,614 | 210 MB | 4,446 ms |
| `POST /service/jobs` | 32 | 209 MB | 7,132 ms |
| `GET /jobs/{jobId}` | 8,566 | 206 MB | 1,775 ms |
| `GET /jobs/{jobId}/download` | 22 | 148 MB | 2,296 ms |
| `POST /jobs/{jobId}/confirm` | 25 | 143 MB | 3,889 ms |
| `POST /jobs/{jobId}/force-stop` | 16 | 143 MB | 3,453 ms |
| Watchdog | 10,080 | 142 MB | 1,948 ms |
| `POST /jobs` | 25 | 140 MB | 2,026 ms |
| `POST /service/jobs/{jobId}/input` | 3 | 140 MB | 2,526 ms |
| `POST /jobs/{jobId}/cancel` | 1 | 140 MB | 2,239 ms |
| `POST /jobs/{jobId}/otp` | 3 | 138 MB | 2,146 ms |
| `GET /service/jobs/lookup` | 5 | 138 MB | 1,712 ms |
| `POST /auth/login` | 29 | 112 MB | 816 ms |
| WebSocket `$connect` | 344 | 97 MB | 2,318 ms |
| WebSocket `$disconnect` | 37 | 86 MB | 1,688 ms |

The inactive handlers are the five other authentication routes, WebSocket
`$default`, service cancellation, service download and the singular `/result`
alias. Recommendations for these rely on code inspection, not measured traffic.

## Categories and initial sizes to test

These are candidate settings for a controlled load test. No handler was
benchmarked at a lower allocation by this audit.

| Category | Count | Initial candidate | Reason |
|---|---:|---:|---|
| Cognito authentication | 6 | 256 MB | Small JSON validation and outbound Cognito requests. |
| WebSocket lifecycle | 3 | 256 MB | JWT verification and connection registration/removal; default is a small acknowledgement. |
| Simple job operations | 4 | 256 MB | Metadata/presigned upload URLs, ECS launch, OTP insert and idempotency lookup. |
| Single-job status/control and service download | 6 | 512 MB | Mostly DB/AWS calls, but stopped-worker reconciliation can parse a workbook. |
| Manual download / IEHP ZIP | 1 | 512 MB | Signed URL normally; IEHP ZIP uses streamed S3 reads and 8 MB multipart buffers. |
| Watchdog | 1 | 512 MB, unchanged | Sequential job checks; service reconciliation can parse a workbook. |
| AR workbook submission/results | 3 | 1024 MB initially | ExcelJS creation/parsing and full submitted/result collections; benchmark worst-case batches before reducing. |
| Job listing | 1 | 1024 MB initially | Can reconcile multiple stopped jobs and parse their workbooks concurrently via `Promise.all`. |
| **Total** | **25** | **13 at 256 MB; 8 at 512 MB; 4 at 1024 MB** | **Starting candidates only.** |

The exact route membership is:

- Authentication (6): login, signup/start, signup/confirm,
  forgot-password/start, forgot-password/confirm, complete-new-password.
- WebSocket (3): `$connect`, `$disconnect`, `$default`.
- Simple operations (4): `POST /jobs`, `POST /jobs/{jobId}/confirm`,
  `POST /jobs/{jobId}/otp`, `GET /service/jobs/lookup`.
- Single-job/control/service download (6): `GET /jobs/{jobId}`,
  `POST /jobs/{jobId}/cancel`, `POST /jobs/{jobId}/force-stop`,
  `POST /service/jobs/{jobId}/cancel`, `POST /service/jobs/{jobId}/input`,
  `GET /service/jobs/{jobId}/download`.
- Manual download (1): `GET /jobs/{jobId}/download`.
- Watchdog (1): `StalledJobWatchdog`.
- AR workbook operations (3): `POST /service/jobs`,
  `GET /service/jobs/{jobId}/result`, `GET /service/jobs/{jobId}/results`.
- Job listing (1): `GET /jobs`.

## What the upload/download names hide

`createJob` accepts file **metadata** and signs S3 upload URLs. Browser file
bytes go directly to S3. File size does not make that handler's memory scale
with the upload size. `confirmJob` launches ECS using saved metadata.

AR's `submitServiceJob` receives claim JSON, constructs workbook buffers
using ExcelJS and uploads those buffers itself. That is a different workload
from manual file uploading and warrants more headroom initially.

`getServiceJobDownload` signs an S3 URL after an object HEAD check; the actual
download is between the caller and S3. However, its `ownedJob` call first
reconciles job state, which can load a stopped worker's complete workbook.
This is why its initial candidate is 512 MB rather than treating it as a
pure signing handler.

`downloadJob` signs an S3 URL for most portals. For IEHP it calls
`createIehpBundle`. That implementation streams input objects through
archiver into 8 MB multipart uploads; it does not buffer the complete ZIP.
Large bundles can still require significant elapsed time despite bounded
buffers. Memory and timeout should be evaluated separately.

`getServiceJobResult` downloads a complete workbook from S3 and normalizes it
before publishing/reading its ledger page. A page limit of 100 does not limit
workbook parsing to 100 claims. `reconcileAwsJobRuntime` also invokes the
snapshot parser when reconciling stopped integrated workers. Its callers
include list/status, cancellation, service input/download and the watchdog.

## Validation before applying changes

Test cold and warm starts at the candidate allocation, measuring errors,
duration, billed duration and maximum memory. Include 10,000 submitted claims,
multi-detail results, simultaneous stopped-job reconciliation, cancellations,
and large IEHP ZIP bundles. Lower Lambda memory also reduces CPU allocation,
so a lower memory setting is not automatically faster or cheaper.

The first architectural improvement would be separating workbook parsing/
normalization and bulk reconciliation from frequently polled metadata APIs.
Worker-side publication or cached normalized snapshots could let result
polling page the existing RDS ledger without reparsing Excel on every request.
This requires a separate change; it is not implemented by the audit.

Code inspected: `sst.config.ts`, `backend/src/aws/http/auth.ts`, `jobs.ts`,
`service-jobs.ts`, `iehp-bundle.ts`, `backend/src/aws/ws/connections.ts`,
`backend/src/aws/runtime/s3.ts`, `job-watchdog.ts`, and service snapshot/input
modules including `claim-workbook.ts` and `availity-snapshot.ts`.

References: [AWS Lambda memory/CPU configuration](https://docs.aws.amazon.com/lambda/latest/dg/configuration-memory.html),
[Lambda REPORT memory semantics](https://docs.aws.amazon.com/lambda/latest/dg/nodejs-logging.html).
