# Claim Status RDS connection

The shared DB pool used by Lambda and Fargate supports either the existing
`DATABASE_URL` or runtime Secrets Manager credentials. Set these in the deployment
shell or private `.env.local` to enable RDS:

```dotenv
DATABASE_SECRET_ARN=arn:aws:secretsmanager:us-west-2:ACCOUNT:secret:NAME
RDS_PROXY_ENDPOINT=YOUR_PROXY.proxy-XXXXX.us-west-2.rds.amazonaws.com
DATABASE_NAME=claim_status
DATABASE_PORT=5432
DATABASE_PRIVATE_SUBNET_IDS=subnet-PRIVATE_APPLICATION_A,subnet-PRIVATE_APPLICATION_B
```

Use the proxy's real endpoint and port 5432, not the workstation's SSM tunnel
address/port. The secret must contain JSON `username` and `password`; its region
is read from the ARN, independently of the compute region. Secret configuration
takes priority over `DATABASE_URL` outside local development, and SST does not
place that old URL/password into secret-mode functions or workers. Next.js
development (`npm run dev`) prefers an existing `DATABASE_URL`, so sharing the
deployment secret settings in `.env.local` does not require AWS credentials for
local login. With no URL configured, explicit secret-based access still applies.

The secret's `AWSCURRENT` credentials are cached in process memory for five
minutes, with concurrent fetches combined. New connection failures `28P01` or
`28000` invalidate that cache and retry connection establishment once. Queries
and transactions are never replayed by this mechanism. Existing pool connections
are reused; newly created connections use the refreshed credentials. Pools use
at most five connections per process and recycle connections after ten minutes.
TLS validates the proxy hostname and its publicly trusted ACM certificate.

SST grants `secretsmanager:GetSecretValue` on this secret to HTTP/WebSocket
Lambdas, ECS workers, ECS-stop handling, and the watchdog. If the secret uses a
customer-managed KMS key, set `DATABASE_SECRET_KMS_KEY_ARN`; its key policy must
also allow the relevant roles. Cross-account secrets additionally require the
secret resource policy/key policy to permit these roles.

## Network prerequisites and cutover

The new `dev-west` stage deploys Lambda and Fargate in **us-west-2**, inside
AR's existing VPC. It leaves the original `dev` deployment untouched. Do not
change the region of the existing stage in place.

Add the following non-password settings to private `.env.local`. Use AR's
**NAT-connected private application subnets**, not its isolated database subnets:

```dotenv
CLAIM_STATUS_VPC_ID=vpc-AR_WORKFLOW
DATABASE_PRIVATE_SUBNET_IDS=subnet-AR_PRIVATE_APPLICATION_A,subnet-AR_PRIVATE_APPLICATION_B
RDS_PROXY_SECURITY_GROUP_ID=sg-EXISTING_RDS_PROXY
WORKFLOW_INPUTS_BUCKET=EXISTING_CLAIM_STATUS_EAST_INPUT_BUCKET
WORKFLOW_OUTPUTS_BUCKET=EXISTING_CLAIM_STATUS_EAST_OUTPUT_BUCKET
WORKFLOW_S3_REGION=us-east-1
COGNITO_USER_POOL_ID=us-east-1_EXISTING_POOL
COGNITO_CLIENT_ID=EXISTING_CLIENT
COGNITO_DOMAIN=https://EXISTING_DOMAIN.auth.us-east-1.amazoncognito.com
```

Retain the four RDS settings above (`DATABASE_SECRET_ARN`, `RDS_PROXY_ENDPOINT`,
`DATABASE_NAME`, `DATABASE_PORT`). The configured secret should identify a DB
user limited to `claim_status`; network restrictions do not replace SQL grants.
No database users, grants, passwords, or tables are changed by this deployment.

SST creates a dedicated Claim Status security group shared by Lambda and workers,
with no inbound access. Outbound HTTP/HTTPS supports portals and AWS APIs; database
egress is limited to the proxy security group on the configured database port.
One matching inbound rule is added to the proxy. Existing AR rules are preserved.
Workers have no public IP and use AR's existing NAT. No new VPC, NAT, peering,
database, proxy, application S3 buckets, or Cognito pool/client/domain is created.
The AWS deployment profile must have access to that VPC and permission to add
the proxy ingress rule. `DATABASE_SECURITY_GROUP_IDS` is only used by old stages;
`dev-west` always uses its new, dedicated group.

Run from PowerShell with the existing AWS profile configured:

```powershell
npm.cmd run deploy:aws:dev-west
```

This deploys the new stack first (including its ECR repository and a fresh
frontend built with the new API/WebSocket URLs), then builds and pushes the
worker image to `claim-status-dev-west-worker` in us-west-2. Nothing submits a
job during deployment. If the image push fails, rerun the command before using
the new API. `WORKER_IMAGE_URI` from the old deployment and
`SST_SKIP_FRONTEND_BUILD` are intentionally ignored for `dev-west`.

The original east Cognito pool, client, user IDs, passwords and MFA remain in
use; both HTTP and WebSocket authorization use its issuer. Login/sign-up/password
recovery call the east Cognito endpoint. All S3 clients, including workers,
snapshots, downloads and URL signing, use `WORKFLOW_S3_REGION` for the retained
east buckets. Before testing hosted login/logout on the new frontend, append its
URL (with trailing `/`) to **both** callback URLs and sign-out URLs on the existing
Cognito app client in us-east-1. Keep the old URLs during testing.

Test existing-user login, website upload/run/download, AR submission/results,
OTP, and cancellation. Then point AR to the new HTTP API URL and users to the
new frontend. Retire the old API/workers/watchdog only after the new deployment
is verified and old runs are finished. Do **not** run `sst remove --stage dev`:
that stage still owns the reused Cognito and S3 resources. Disable the old
watchdog/EventBridge stop handler when retiring its compute, keeping those
shared resources and their owning stack intact.

The original `dev` stage is pinned to us-east-1 and retains its existing
`DATABASE_URL`/`DB_SSL` connection (Supabase). It ignores `DATABASE_SECRET_ARN`
and the west network settings, so both deployments can use the same private
`.env.local`. Its worker push is also pinned to us-east-1. Keep the original
Supabase `DATABASE_URL` configured when deploying `dev`.
Other stages opting into secret mode still require their own region's private
subnets/security groups and a route to RDS. No inter-region peering is needed
for the `dev-west` same-VPC deployment.

Keep writers paused until both the worker image and backend/SST have been
deployed with the same secret configuration. Verify a DB connection from Lambda
and Fargate, then one small job, before resuming normal submissions. No database
schema migration is required for this connection change. Setting these variables
does not itself migrate data or change the RDS password/rotation schedule.

Local development can keep using `DATABASE_URL`. The private transfer tooling is
separate from the deployed application's database configuration.
