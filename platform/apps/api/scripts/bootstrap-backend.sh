#!/usr/bin/env bash
# bootstrap-backend.sh
# Creates (or verifies) the S3 bucket and DynamoDB table used by
# Terraform's S3 backend.  Idempotent — safe to run repeatedly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_CONFIG="${BACKEND_CONFIG:-${SCRIPT_DIR}/../env/dev/backend.hcl}"

read_backend_value() {
  local key="$1"
  awk -F'"' -v key="$key" '$1 ~ "^[[:space:]]*" key "[[:space:]]*=" { print $2; exit }' "$BACKEND_CONFIG"
}

BUCKET="${BUCKET:-$(read_backend_value bucket)}"
TABLE="${TABLE:-$(read_backend_value dynamodb_table)}"
REGION="${REGION:-$(read_backend_value region)}"

if [[ -z "${BUCKET}" || -z "${TABLE}" || -z "${REGION}" ]]; then
  echo "Failed to read bucket/table/region from ${BACKEND_CONFIG}" >&2
  exit 1
fi

echo "==> Bootstrapping Terraform backend in ${REGION}"
echo "    Backend config: ${BACKEND_CONFIG}"
echo "    Bucket: ${BUCKET}"
echo "    Lock table: ${TABLE}"

# ── S3 bucket ────────────────────────────────────────────────
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "    Bucket ${BUCKET} already exists"
else
  echo "    Creating bucket ${BUCKET}..."
  aws s3api create-bucket \
    --bucket "$BUCKET" \
    --region "$REGION"
fi

echo "    Enabling versioning..."
aws s3api put-bucket-versioning \
  --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled

echo "    Enabling default encryption (AES-256)..."
aws s3api put-bucket-encryption \
  --bucket "$BUCKET" \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      },
      "BucketKeyEnabled": true
    }]
  }'

echo "    Blocking public access..."
aws s3api put-public-access-block \
  --bucket "$BUCKET" \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# ── DynamoDB lock table ──────────────────────────────────────
if aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" >/dev/null 2>&1; then
  echo "    Lock table ${TABLE} already exists"
else
  echo "    Creating lock table ${TABLE}..."
  aws dynamodb create-table \
    --table-name "$TABLE" \
    --attribute-definitions AttributeName=LockID,AttributeType=S \
    --key-schema AttributeName=LockID,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --region "$REGION"

  echo "    Waiting for table to become active..."
  aws dynamodb wait table-exists --table-name "$TABLE" --region "$REGION"
fi

# ── GitHub OIDC provider ─────────────────────────────────────
# CI assumes SymphonyTerraformRole via OIDC, so the provider and role
# must exist BEFORE the first Terraform run.

GITHUB_ORG="${GITHUB_ORG:-kmgrassi}"
GITHUB_REPO="${GITHUB_REPO:-parallel-agent-platform}"
ROLE_NAME="SymphonyTerraformRole"
OIDC_URL="https://token.actions.githubusercontent.com"
OIDC_THUMBPRINT="6938fd4d98bab03faadb97b34396831e3780aea1"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Create OIDC provider if it doesn't exist
if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com" >/dev/null 2>&1; then
  echo "    GitHub OIDC provider already exists"
else
  echo "    Creating GitHub OIDC provider..."
  aws iam create-open-id-connect-provider \
    --url "$OIDC_URL" \
    --client-id-list sts.amazonaws.com \
    --thumbprint-list "$OIDC_THUMBPRINT"
fi

# Create SymphonyTerraformRole if it doesn't exist
if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "    IAM role ${ROLE_NAME} already exists"
else
  echo "    Creating IAM role ${ROLE_NAME}..."
  TRUST_POLICY=$(cat <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringLike": {
        "token.actions.githubusercontent.com:sub": "repo:${GITHUB_ORG}/${GITHUB_REPO}:*"
      },
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
      }
    }
  }]
}
POLICY
)
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$TRUST_POLICY"

  # Attach broad permissions needed for Terraform to manage the stack
  ROLE_POLICY=$(cat <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TerraformStateAccess",
      "Effect": "Allow",
      "Action": ["s3:GetObject","s3:PutObject","s3:ListBucket","s3:DeleteObject"],
      "Resource": [
        "arn:aws:s3:::${BUCKET}",
        "arn:aws:s3:::${BUCKET}/*"
      ]
    },
    {
      "Sid": "TerraformLockAccess",
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem","dynamodb:PutItem","dynamodb:DeleteItem"],
      "Resource": "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${TABLE}"
    },
    {
      "Sid": "ECSManagement",
      "Effect": "Allow",
      "Action": ["ecs:*","ecr:*","logs:*","elasticloadbalancing:*",
        "ec2:Describe*","ec2:CreateSecurityGroup","ec2:DeleteSecurityGroup",
        "ec2:AuthorizeSecurityGroup*","ec2:RevokeSecurityGroup*",
        "ec2:CreateTags","ec2:DeleteTags"],
      "Resource": "*"
    },
    {
      "Sid": "IAMPassRole",
      "Effect": "Allow",
      "Action": ["iam:GetRole","iam:PassRole","iam:CreateRole","iam:DeleteRole",
        "iam:AttachRolePolicy","iam:DetachRolePolicy","iam:PutRolePolicy",
        "iam:DeleteRolePolicy","iam:GetRolePolicy","iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies","iam:ListInstanceProfilesForRole",
        "iam:TagRole","iam:UntagRole"],
      "Resource": [
        "arn:aws:iam::${ACCOUNT_ID}:role/symphony-*",
        "arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
      ]
    },
    {
      "Sid": "DNSAndCertManagement",
      "Effect": "Allow",
      "Action": ["route53:*","acm:*"],
      "Resource": "*"
    },
    {
      "Sid": "SecretsAndSSM",
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue","secretsmanager:DescribeSecret",
        "secretsmanager:ListSecrets","ssm:GetParameter","ssm:GetParameters",
        "ssm:PutParameter"],
      "Resource": "*"
    },
    {
      "Sid": "OIDCProviderRead",
      "Effect": "Allow",
      "Action": ["iam:GetOpenIDConnectProvider"],
      "Resource": "*"
    }
  ]
}
POLICY
)
  aws iam put-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-name "SymphonyTerraformPolicy" \
    --policy-document "$ROLE_POLICY"
fi

echo "==> Bootstrap complete"
