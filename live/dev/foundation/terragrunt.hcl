include "root" {
  path = find_in_parent_folders("root.hcl")
}

locals {
  aws_region = "us-east-1"
}

terraform {
  source = "../../../modules/rag-foundation"
}

inputs = {
  environment = "dev"
  region      = local.aws_region
  # Trust the IAM principal configured for the local application.
  runtime_principal_arns = [get_env("RUNTIME_PRINCIPAL_ARN")]

  tags = {
    Project     = "evaluated-rag-knowledge-service"
    Environment = "dev"
  }

  # Match the GitHub Actions OIDC subject chosen for the CI workflow.
  repository_subject = get_env("REPOSITORY_SUBJECT")

  # Allow only the generation and embedding models used by this project.
  model_ids = [
    "amazon.nova-micro-v1:0",
    "amazon.titan-embed-text-v2:0",
  ]
}

generate "provider" {
  path      = "provider.tf"
  if_exists = "overwrite_terragrunt"

  contents = <<EOF
provider "aws" {
  region = "${local.aws_region}"
}
EOF
}