/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    const tags = {
      Project: "claim-status",
      Environment: "dev",
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
    const outputsBucket = new sst.aws.Bucket("WorkflowOutputs", {
      cors: false,
    });

    const vpc = new sst.aws.Vpc("Vpc", {
      nat: undefined,
    });

    const cluster = new sst.aws.Cluster("Cluster", {
      vpc,
    });

    const task = new sst.aws.Task("AppTask", {
      cluster,
      cpu: "2 vCPU",
      memory: "4 GB",
      storage: "50 GB",
      public: true,
      containers: [
        {
          name: "app",
          image: {
            context: ".",
            dockerfile: "Dockerfile",
          },
          command: ["npm", "run", "start", "--", "-H", "0.0.0.0", "-p", "3000"],
          environment: {
            NODE_ENV: "production",
            NEXT_TELEMETRY_DISABLED: "1",
            PORT: "3000",
            HOSTNAME: "0.0.0.0",
            BROWSER_HEADLESS: "true",
            BROWSER_KEEP_OPEN: "false",
            EXIT_AFTER_WORKFLOW_DONE: "true",
            EXIT_AFTER_WORKFLOW_DELAY_MS: "15000",
            WORKFLOW_OUTPUTS_BUCKET: outputsBucket.name,
          },
          logging: {
            name: "/claim-status/dev/app",
            retention: "1 week",
          },
        },
      ],
      permissions: [
        {
          actions: ["s3:ListBucket"],
          resources: [outputsBucket.arn],
        },
        {
          actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
          resources: [$interpolate`${outputsBucket.arn}/*`],
        },
      ],
    });

    return {
      bucketName: outputsBucket.name,
      cluster: cluster.id,
      publicSubnets: vpc.publicSubnets,
      task: task.nodes.taskDefinition.arn,
      taskLogGroup: "/claim-status/dev/app",
    };
  },
});
