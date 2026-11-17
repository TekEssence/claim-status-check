# Claim Status RDS connection

The shared DB pool used by Lambda and Fargate supports either the existing
`DATABASE_URL` or runtime Secrets Manager credentials. Set these in the deployment
shell or private `.env.local` to enable RDS:

```dotenv
DATABASE_SECRET_ARN=arn:aws:secretsmanager:us-west-2:ACCOUNT:secret:NAME
RDS_PROXY_ENDPOINT=YOUR_PROXY.proxy-XXXXX.us-west-2.rds.amazonaws.com
DATABASE_NAME=claim_status
DATABASE_PORT=5432
DATABASE_PRIVATE_SUBNET_IDS=subnet-CLAIM_STATUS_PRIVATE_A,subnet-CLAIM_STATUS_PRIVATE_B
DATABASE_SECURITY_GROUP_IDS=sg-CLAIM_STATUS_LAMBDA
```

Use the proxy's real endpoint and port 5432, not the workstation's SSM tunnel
address/port. The secret must contain JSON `username` and `password`; its region
is read from the ARN, independently of the compute region. Secret configuration
takes priority over `DATABASE_URL`, and SST does not place that old URL/password
into secret-mode functions or workers.

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

Claim Status stays in us-east-1. Its private Lambda subnet/security-group IDs
must belong to us-east-1, with private routes (for example inter-region VPC
peering) to the us-west-2 RDS Proxy VPC. Both sides need return routes, compatible
CIDRs, DNS resolution, network ACLs, and TCP 5432 security-group rules. The
existing east-region Fargate VPC/subnets also need that private route. Lambda
private subnets need NAT or suitable service endpoints for Secrets Manager and
the other AWS APIs; attaching Lambda to a public subnet does not give internet
access. This code does not create peering or change the AR database/proxy stack.

Keep writers paused until both the worker image and backend/SST have been
deployed with the same secret configuration. Verify a DB connection from Lambda
and Fargate, then one small job, before resuming normal submissions. No database
schema migration is required for this connection change. Setting these variables
does not itself migrate data or change the RDS password/rotation schedule.

Local development can keep using `DATABASE_URL`. The private transfer tooling is
separate from the deployed application's database configuration.
