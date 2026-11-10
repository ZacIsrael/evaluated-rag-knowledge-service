# Use Terraform as the infrastructure engine.
terraform_binary = "terraform"

# Require the project's selected CLI versions.
terraform_version_constraint  = "= 1.16.7"
terragrunt_version_constraint = "= 1.2.1"

# Store Terraform state in the project's dedicated S3 state bucket.
remote_state {
  backend = "s3"

  # Generate the backend configuration for each Terragrunt unit.
  generate = {
    path      = "backend.tf"
    if_exists = "overwrite_terragrunt"
  }

  config = {
    # Use a dedicated state bucket, separate from the RAG data bucket.
    bucket = get_env("TF_STATE_BUCKET")

    # Give each environment its own state file.
    key = "${path_relative_to_include()}/terraform.tfstate"

    # Keep the state in the selected AWS Region.
    region = "us-east-1"

    # Enable server-side encryption for state objects.
    encrypt = true

    # Use S3-native state locking.
    use_lockfile = true
  }
}