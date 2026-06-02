#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const env = process.argv[2] ?? process.env.CONTAINER_SMOKE_ENV ?? "dev";
const roots = [
  {
    name: "foundation",
    tfDir: "apps/api/infra/container-execution/foundation",
    backendConfig: `../../../env/container-execution/${env}/backend.hcl`,
    tfvars: `../../../env/container-execution/${env}/terraform.tfvars`,
  },
  {
    name: "runtime",
    tfDir: "apps/api/infra/container-execution/runtime",
    backendConfig: `../../../env/container-execution/${env}/runtime.backend.hcl`,
    tfvars: `../../../env/container-execution/${env}/runtime.tfvars`,
  },
];

function run(root, label, args) {
  process.stdout.write(`\n==> ${root.name}: ${label}\n`);
  const result = spawnSync("terraform", args, {
    cwd: root.tfDir,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

for (const root of roots) {
  run(root, "Terraform init", ["init", `-backend-config=${root.backendConfig}`]);
  run(root, "Terraform validate", ["validate"]);
  run(root, "Terraform plan (smoke)", [
    "plan",
    `-var-file=${root.tfvars}`,
    "-lock=false",
    "-input=false",
  ]);
}

process.stdout.write("\nContainer execution smoke checks passed.\n");
