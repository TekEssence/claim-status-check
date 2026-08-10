import { ECSClient, RunTaskCommand, StopTaskCommand } from "@aws-sdk/client-ecs";

let client: ECSClient | null = null;

function ecs(): ECSClient {
  if (!client) client = new ECSClient({});
  return client;
}

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured.`);
  return value;
}

function parseAwsIdList(value: string | undefined, name: string): string[] {
  const raw = value?.trim();
  if (!raw) return [];

  let values: unknown = raw;
  if (raw.startsWith("[") && raw.endsWith("]")) {
    try {
      values = JSON.parse(raw);
    } catch {
      values = raw;
    }
  }

  const items = Array.isArray(values) ? values : String(values).split(",");
  return items
    .map((item) => String(item).trim().replace(/^['"]|['"]$/g, ""))
    .map((item) => item.replace(/^\[|\]$/g, "").trim())
    .filter(Boolean)
    .map((item) => {
      if (!/^(subnet|sg)-[0-9a-f]+$/i.test(item)) {
        throw new Error(`${name} contains an invalid AWS id: ${item}`);
      }
      return item;
    });
}

export async function runWorkerTask(params: {
  jobId: string;
  userId: string;
  portalId: string;
  inputBucket: string;
  outputBucket: string;
  inputKeys: Record<string, string>;
  formFields?: Record<string, unknown>;
}) {
  const subnetIds = parseAwsIdList(env("WORKER_SUBNET_IDS"), "WORKER_SUBNET_IDS");
  const securityGroupIds = parseAwsIdList(process.env.WORKER_SECURITY_GROUP_IDS, "WORKER_SECURITY_GROUP_IDS");
  const overrides = [
    { name: "JOB_ID", value: params.jobId },
    { name: "USER_ID", value: params.userId },
    { name: "PORTAL_ID", value: params.portalId },
    { name: "WORKFLOW_INPUTS_BUCKET", value: params.inputBucket },
    { name: "WORKFLOW_OUTPUTS_BUCKET", value: params.outputBucket },
    { name: "CLAIM_EXCEL_S3_KEY", value: params.inputKeys.claimExcel ?? "" },
    { name: "LOGIN_EXCEL_S3_KEY", value: params.inputKeys.loginExcel ?? "" },
    { name: "INPUT_EXCEL_S3_KEY", value: params.inputKeys.inputExcel ?? "" },
    { name: "CREDENTIAL_EXCEL_S3_KEY", value: params.inputKeys.credentialExcel ?? "" },
    { name: "CLAIM_ROWS_S3_KEY", value: params.inputKeys.claimRows ?? "" },
    { name: "FORM_FIELDS_JSON", value: JSON.stringify(params.formFields ?? {}) },
  ];

  const result = await ecs().send(new RunTaskCommand({
    cluster: env("WORKER_CLUSTER_ARN"),
    taskDefinition: env("WORKER_TASK_DEFINITION_ARN"),
    launchType: "FARGATE",
    count: 1,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: subnetIds,
        securityGroups: securityGroupIds.length ? securityGroupIds : undefined,
        assignPublicIp: "ENABLED",
      },
    },
    overrides: {
      containerOverrides: [
        {
          name: process.env.WORKER_CONTAINER_NAME || "worker",
          environment: overrides,
        },
      ],
    },
  }));

  const failure = result.failures?.[0];
  if (failure) {
    throw new Error(`ECS RunTask failed: ${failure.reason || failure.detail || "unknown failure"}`);
  }

  const taskArn = result.tasks?.[0]?.taskArn;
  if (!taskArn) throw new Error("ECS RunTask succeeded but did not return a task ARN.");
  return taskArn;
}

export async function stopWorkerTask(taskArn: string, reason: string) {
  await ecs().send(new StopTaskCommand({
    cluster: env("WORKER_CLUSTER_ARN"),
    task: taskArn,
    reason,
  }));
}
