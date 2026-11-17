/// <reference path="./.sst/platform/config.d.ts" />
 
 export default $config({
  app(input) {
    const tags = {
      Project: "claim-status",
      Environment: input.stage,
    };

    return {
      name: "claim-status",
      home: "aws",
      removal: input.stage === "production" ? "retain" : "remove",
      providers: {
        aws: {
          profile: "claim-status",
          region: process.env.AWS_REGION || "us-east-1",
          defaultTags: {
            tags,
          },
        },
      },
    };
  },
  async run() {
    const aws = await import("@pulumi/aws");
    const fs = await import("node:fs");

    function loadDeployEnv() {
      const values: Record<string, string> = {};
      for (const file of [".env.local", ".env"]) {
        if (!fs.existsSync(file)) continue;
        const content = fs.readFileSync(file, "utf8");
        for (const rawLine of content.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line || line.startsWith("#")) continue;
          const separator = line.indexOf("=");
          if (separator <= 0) continue;
          const key = line.slice(0, separator).trim();
          const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
          values[key] = value;
        }
      }
      return values;
    }

    const deployEnv = loadDeployEnv();
    const databaseUrl = process.env.DATABASE_URL || deployEnv.DATABASE_URL || "";
    const dbSsl = process.env.DB_SSL || deployEnv.DB_SSL || "true";
    const setting = (name: string) => process.env[name] || deployEnv[name] || "";
    const databaseSecretArn = setting("DATABASE_SECRET_ARN");
    const proxyEndpoint = setting("RDS_PROXY_ENDPOINT");
    const dbSubnetIds = setting("DATABASE_PRIVATE_SUBNET_IDS").split(",").map(value => value.trim()).filter(Boolean);
    const dbSecurityGroupIds = setting("DATABASE_SECURITY_GROUP_IDS").split(",").map(value => value.trim()).filter(Boolean);
    if (databaseSecretArn && (!proxyEndpoint || !dbSubnetIds.length || !dbSecurityGroupIds.length)) {
      throw new Error("Secret-based RDS requires RDS_PROXY_ENDPOINT, DATABASE_PRIVATE_SUBNET_IDS and DATABASE_SECURITY_GROUP_IDS. Use Claim Status-region private subnets with a route to the RDS Proxy.");
    }
    const databaseVpc = databaseSecretArn ? { privateSubnets: dbSubnetIds, securityGroups: dbSecurityGroupIds } : undefined;
    const databaseEnvironment: Record<string, string> = databaseSecretArn ? {
      DATABASE_SECRET_ARN: databaseSecretArn, RDS_PROXY_ENDPOINT: proxyEndpoint,
      DATABASE_NAME: setting("DATABASE_NAME") || "claim_status", DATABASE_PORT: setting("DATABASE_PORT") || "5432",
    } : { DATABASE_URL: databaseUrl, DB_SSL: dbSsl };
    const databasePermissions = databaseSecretArn ? [
      { actions: ["secretsmanager:GetSecretValue"], resources: [databaseSecretArn] },
      ...(setting("DATABASE_SECRET_KMS_KEY_ARN") ? [{ actions: ["kms:Decrypt"], resources: [setting("DATABASE_SECRET_KMS_KEY_ARN")] }] : []),
    ] : [];
    const workerImageUriOverride = process.env.WORKER_IMAGE_URI || deployEnv.WORKER_IMAGE_URI || "";
    const serviceTokensJson = process.env.CLAIM_STATUS_SERVICE_TOKENS_JSON || deployEnv.CLAIM_STATUS_SERVICE_TOKENS_JSON || "";
    const skipFrontendBuild = (process.env.SST_SKIP_FRONTEND_BUILD || deployEnv.SST_SKIP_FRONTEND_BUILD || "").toLowerCase() === "true";
    if (!databaseUrl && !databaseSecretArn) {
      throw new Error("DATABASE_URL or DATABASE_SECRET_ARN must be set in the shell or .env.local before deploying AWS workflow APIs.");
    }

    const inputsBucket = new sst.aws.Bucket("WorkflowInputs", {
      cors: {
        allowOrigins: ["*"],
        allowMethods: ["PUT", "GET", "HEAD"],
        allowHeaders: ["*"],
      },
    });

    const outputsBucket = new sst.aws.Bucket("WorkflowOutputs", {
      cors: {
        allowOrigins: ["*"],
        allowMethods: ["GET", "HEAD"],
        allowHeaders: ["*"],
      },
    });

    const userPool = new aws.cognito.UserPool("InternalUsers", {
      usernameAttributes: ["email"],
      autoVerifiedAttributes: ["email"],
      passwordPolicy: {
        minimumLength: 12,
        requireLowercase: true,
        requireNumbers: true,
        requireSymbols: false,
        requireUppercase: true,
        temporaryPasswordValidityDays: 7,
      },
      mfaConfiguration: "OPTIONAL",
      softwareTokenMfaConfiguration: {
        enabled: true,
      },
    });

    const userPoolClient = new aws.cognito.UserPoolClient("WebClient", {
      userPoolId: userPool.id,
      generateSecret: false,
      explicitAuthFlows: [
        "ALLOW_USER_SRP_AUTH",
        "ALLOW_REFRESH_TOKEN_AUTH",
        "ALLOW_USER_PASSWORD_AUTH",
      ],
      allowedOauthFlowsUserPoolClient: true,
      allowedOauthFlows: ["code", "implicit"],
      allowedOauthScopes: ["email", "openid", "profile"],
      callbackUrls: [
        "http://localhost:3000/",
        "https://d2rdco8saesh4t.cloudfront.net/",
      ],
      logoutUrls: [
        "http://localhost:3000/",
        "https://d2rdco8saesh4t.cloudfront.net/",
      ],
      supportedIdentityProviders: ["COGNITO"],
    });

    const userPoolDomain = new aws.cognito.UserPoolDomain("InternalUsersDomain", {
      userPoolId: userPool.id,
      domain: $interpolate`claim-status-${$app.stage}-${aws.getCallerIdentityOutput({}).accountId}`,
    });

    const vpc = new sst.aws.Vpc("Vpc", {
      nat: undefined,
    });

    const cluster = new sst.aws.Cluster("Cluster", {
      vpc,
    });

    const workerRepository = new aws.ecr.Repository("WorkerRepository", {
      name: `claim-status-${$app.stage}-worker`,
      imageTagMutability: "MUTABLE",
      forceDelete: $app.stage !== "production",
    });

    const workerImageUri = workerImageUriOverride || $interpolate`${workerRepository.repositoryUrl}:dev`;

    const webSocketApi = new sst.aws.ApiGatewayWebSocket("WorkflowWebSocketApi", {
      transform: {
        route: {
          handler: (args) => {
            args.environment = $output(args.environment ?? {}).apply(environment => ({
              ...environment, ...databaseEnvironment,
              COGNITO_ISSUER: $interpolate`https://cognito-idp.${aws.getRegionOutput({}).name}.amazonaws.com/${userPool.id}`,
              COGNITO_CLIENT_ID: userPoolClient.id,
            }));
            args.vpc = databaseVpc;
            args.permissions = $output(args.permissions ?? []).apply(permissions => [...permissions, ...databasePermissions]);
          },
        },
      },
    });

    const workerTask = new sst.aws.Task("WorkerTask", {
      cluster,
      cpu: "2 vCPU",
      memory: "4 GB",
      storage: "50 GB",
      public: true,
      containers: [
        {
          name: "worker",
          image: workerImageUri,
          environment: {
            NODE_ENV: "production",
            NEXT_TELEMETRY_DISABLED: "1",
            ...databaseEnvironment,
            BROWSER_HEADLESS: "true",
            OPTUM_PRO_CUSTOM_USER_AGENT: "true",
            BROWSER_KEEP_OPEN: "false",
            EXIT_AFTER_WORKFLOW_DONE: "true",
            EXIT_AFTER_WORKFLOW_DELAY_MS: "15000",
            WORKFLOW_INPUTS_BUCKET: inputsBucket.name,
            WORKFLOW_OUTPUTS_BUCKET: outputsBucket.name,
            WEBSOCKET_MANAGEMENT_ENDPOINT: webSocketApi.managementEndpoint,
          },
          logging: {
            name: $interpolate`/claim-status/${$app.stage}/worker`,
            retention: "1 week",
          },
        },
      ],
      permissions: [
        ...databasePermissions,
        {
          actions: ["s3:ListBucket"],
          resources: [inputsBucket.arn, outputsBucket.arn],
        },
        {
          actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
          resources: [
            $interpolate`${inputsBucket.arn}/*`,
            $interpolate`${outputsBucket.arn}/*`,
          ],
        },
        {
          actions: ["execute-api:ManageConnections"],
          resources: ["*"],
        },
      ],
    });

    const httpApi = new sst.aws.ApiGatewayV2("WorkflowHttpApi", {
      cors: {
        allowOrigins: ["*"],
        allowHeaders: ["authorization", "content-type"],
        allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      },
      transform: {
        route: {
          handler: (args) => {
            args.environment = $output(args.environment ?? {}).apply(environment => ({
              ...environment, ...databaseEnvironment,
              WORKFLOW_INPUTS_BUCKET: inputsBucket.name,
              WORKFLOW_OUTPUTS_BUCKET: outputsBucket.name,
              CLAIM_STATUS_SERVICE_TOKENS_JSON: serviceTokensJson,
              WORKER_CLUSTER_ARN: cluster.id,
              WORKER_TASK_DEFINITION_ARN: workerTask.nodes.taskDefinition.arn,
              WORKER_CONTAINER_NAME: "worker",
              WORKER_LOG_GROUP: $interpolate`/claim-status/${$app.stage}/worker`,
              COGNITO_CLIENT_ID: userPoolClient.id,
              COGNITO_USER_POOL_ID: userPool.id,
              WORKER_SUBNET_IDS: $jsonStringify(workerTask.subnets),
              WORKER_SECURITY_GROUP_IDS: $jsonStringify(workerTask.securityGroups),
            }));
            args.vpc = databaseVpc;
            args.permissions = $output(args.permissions ?? []).apply(permissions => [
              ...permissions,
              ...databasePermissions,
              {
                actions: ["ecs:RunTask", "ecs:StopTask", "ecs:DescribeTasks", "ecs:ListTasks", "ecs:TagResource"],
                resources: ["*"],
              },
              {
                actions: ["iam:PassRole"],
                resources: ["*"],
              },
              {
                actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
                resources: [
                  $interpolate`${inputsBucket.arn}/*`,
                  $interpolate`${outputsBucket.arn}/*`,
                ],
              },
              {
                actions: ["s3:ListBucket"],
                resources: [inputsBucket.arn, outputsBucket.arn],
              },
              {
                actions: ["logs:FilterLogEvents", "logs:GetLogEvents"],
                resources: [$interpolate`arn:aws:logs:${aws.getRegionOutput({}).name}:${aws.getCallerIdentityOutput({}).accountId}:log-group:/claim-status/${$app.stage}/worker:*`],
              },
            ]);
          },
        },
      },
    });

    const httpAuthorizer = httpApi.addAuthorizer({
      name: "Cognito",
      jwt: {
        issuer: $interpolate`https://cognito-idp.${aws.getRegionOutput({}).name}.amazonaws.com/${userPool.id}`,
        audiences: [userPoolClient.id],
      },
    });
    const httpAuth = { jwt: { authorizer: httpAuthorizer.id } };

    httpApi.route("POST /auth/login", "backend/src/aws/http/auth-login.handler");
    httpApi.route("POST /auth/signup/start", "backend/src/aws/http/auth-signup-start.handler");
    httpApi.route("POST /auth/signup/confirm", "backend/src/aws/http/auth-signup-confirm.handler");
    httpApi.route("POST /auth/forgot-password/start", "backend/src/aws/http/auth-forgot-password-start.handler");
    httpApi.route("POST /auth/forgot-password/confirm", "backend/src/aws/http/auth-forgot-password-confirm.handler");
    httpApi.route("POST /auth/complete-new-password", "backend/src/aws/http/auth-complete-new-password.handler");
    httpApi.route("POST /jobs", "backend/src/aws/http/create-job.handler", { auth: httpAuth });
    httpApi.route("GET /jobs", "backend/src/aws/http/list-jobs.handler", { auth: httpAuth });
    httpApi.route("POST /jobs/{jobId}/confirm", "backend/src/aws/http/confirm-job.handler", { auth: httpAuth });
    httpApi.route("GET /jobs/{jobId}", "backend/src/aws/http/get-job.handler", { auth: httpAuth });
    httpApi.route("POST /jobs/{jobId}/otp", "backend/src/aws/http/submit-otp.handler", { auth: httpAuth });
    httpApi.route("POST /jobs/{jobId}/cancel", "backend/src/aws/http/cancel-job.handler", { auth: httpAuth });
    httpApi.route("POST /jobs/{jobId}/force-stop", "backend/src/aws/http/force-stop-job.handler", { auth: httpAuth });
    httpApi.route("GET /jobs/{jobId}/download", "backend/src/aws/http/download-job.handler", { auth: httpAuth });
    httpApi.route("POST /service/jobs", "backend/src/aws/http/service-create-job.handler");
    httpApi.route("GET /service/jobs/lookup", "backend/src/aws/http/service-lookup-job.handler");
    httpApi.route("GET /service/jobs/{jobId}/result", "backend/src/aws/http/service-get-result.handler");
    httpApi.route("GET /service/jobs/{jobId}/results", "backend/src/aws/http/service-get-result.handler");
    httpApi.route("POST /service/jobs/{jobId}/cancel", "backend/src/aws/http/service-cancel-job.handler");
    httpApi.route("POST /service/jobs/{jobId}/input", "backend/src/aws/http/service-submit-input.handler");
    httpApi.route("GET /service/jobs/{jobId}/download", "backend/src/aws/http/service-download-job.handler");

    sst.aws.Bus.get("EcsEvents", "default").subscribe("WorkerTaskStopped", {
      handler: "backend/src/aws/events/ecs-task-stopped.handler",
      memory: "1024 MB",
      timeout: "2 minutes",
      vpc: databaseVpc,
      environment: {
        ...databaseEnvironment,
        WORKER_CLUSTER_ARN: cluster.nodes.cluster.arn,
        WORKER_TASK_DEFINITION_ARN: workerTask.nodes.taskDefinition.arn,
        WORKER_CONTAINER_NAME: "worker",
      },
      permissions: [
        ...databasePermissions,
        { actions: ["ecs:DescribeTasks"], resources: ["*"] },
        { actions: ["s3:GetObject"], resources: [$interpolate`${inputsBucket.arn}/*`, $interpolate`${outputsBucket.arn}/*`] },
        { actions: ["s3:ListBucket"], resources: [outputsBucket.arn] },
      ],
    }, {
      pattern: {
        source: ["aws.ecs"],
        detailType: ["ECS Task State Change"],
        detail: {
          lastStatus: ["STOPPED"],
          clusterArn: [cluster.nodes.cluster.arn],
          taskDefinitionArn: [{ prefix: workerTask.nodes.taskDefinition.arn.apply(arn => arn.slice(0, arn.lastIndexOf(":") + 1)) }],
        },
      },
    });

    new sst.aws.Cron("StalledJobWatchdog", {
      schedule: "rate(1 minute)",
      function: {
        handler: "backend/src/aws/cron/stalled-job-watchdog.handler",
        memory: "512 MB",
        timeout: "60 seconds",
        vpc: databaseVpc,
        environment: {
          ...databaseEnvironment,
          WORKER_CLUSTER_ARN: cluster.id,
          WORKER_TASK_DEFINITION_ARN: workerTask.nodes.taskDefinition.arn,
          WORKER_CONTAINER_NAME: "worker",
          WORKFLOW_STALL_TIMEOUT_MS: "1200000",
          WORKFLOW_STALL_CANCEL_RETRY_DELAY_MS: "60000",
          WORKFLOW_STALL_CANCEL_ATTEMPTS: "3",
        },
        permissions: [
          ...databasePermissions,
          {
            actions: ["ecs:StopTask", "ecs:DescribeTasks", "ecs:ListTasks"],
            resources: ["*"],
          },
          {
            actions: ["s3:GetObject"],
            resources: [
              $interpolate`${inputsBucket.arn}/*`,
              $interpolate`${outputsBucket.arn}/*`,
            ],
          },
          {
            actions: ["s3:ListBucket"],
            resources: [outputsBucket.arn],
          },
        ],
      },
    });

    webSocketApi.route("$connect", "backend/src/aws/ws/connect.handler");
    webSocketApi.route("$disconnect", "backend/src/aws/ws/disconnect.handler");
    webSocketApi.route("$default", "backend/src/aws/ws/default.handler");

    const frontend = new sst.aws.StaticSite("Frontend", {
      path: ".",
      environment: {
        STATIC_EXPORT: "true",
        NEXT_PUBLIC_WORKFLOW_API_URL: httpApi.url,
        NEXT_PUBLIC_WORKFLOW_WS_URL: webSocketApi.url,
        NEXT_PUBLIC_COGNITO_USER_POOL_ID: userPool.id,
        NEXT_PUBLIC_COGNITO_CLIENT_ID: userPoolClient.id,
        NEXT_PUBLIC_COGNITO_DOMAIN: $interpolate`https://${userPoolDomain.domain}.auth.${aws.getRegionOutput({}).name}.amazoncognito.com`,
      },
      build: {
        command: skipFrontendBuild ? "npm run build:static:verify" : "npm run build:static",
        output: "out",
      },
    });

    return {
      frontendUrl: frontend.url,
      httpApiUrl: httpApi.url,
      webSocketApiUrl: webSocketApi.url,
      cognitoUserPoolId: userPool.id,
      cognitoClientId: userPoolClient.id,
      cognitoDomain: $interpolate`https://${userPoolDomain.domain}.auth.${aws.getRegionOutput({}).name}.amazoncognito.com`,
      inputBucketName: inputsBucket.name,
      outputBucketName: outputsBucket.name,
      workerRepositoryUrl: workerRepository.repositoryUrl,
      workerImageUri,
      cluster: cluster.id,
      workerTaskDefinition: workerTask.nodes.taskDefinition.arn,
      workerTaskLogGroup: $interpolate`/claim-status/${$app.stage}/worker`,
    };
  },
});
