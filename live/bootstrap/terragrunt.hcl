locals {
  aws_region = "us-east-1"

  # Keep bootstrap state outside Terragrunt's disposable cache.
  bootstrap_state_path = abspath("${get_terragrunt_dir()}/../.state/bootstrap/terraform.tfstate")
}

terraform {
  source = "../../modules/bootstrap"
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

generate "backend" {
  path      = "backend.tf"
  if_exists = "overwrite_terragrunt"

  contents = <<EOF
terraform {
  backend "local" {
    path = "${local.bootstrap_state_path}"
  }
}
EOF
}

inputs = {
  #   variables defined in modules/bootstrap/variables.tf
  environment = "dev"
  project     = "rag"
}