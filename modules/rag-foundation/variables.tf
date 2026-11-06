# Inputs: Region, project, environment, allowed model IDs, 
# repository/environment subject, retention and tags.

# Select the AWS Region for this development deployment.
# Bedrock model invocation for this project uses us-east-1.
variable "region" {
  description = "AWS Region for regional project resources and Bedrock invocation."
  type        = string
  default     = "us-east-1"
}

# Identify the deployment environment used in resource names and tags.
# Pass a value such as "dev" from the Terragrunt development unit.
variable "environment" {
  description = "Deployment environment, such as dev."
  type        = string
}

# Add the embedding model ID when configuring permissions for ingestion.
variable "model_ids" {
  description = "Bedrock model IDs the application is allowed to invoke."
  type        = list(string)
  default     = ["amazon.nova-micro-v1:0"]
}

# Keep this identifier short because it forms part of the S3 bucket name.
variable "project" {
  description = "Short project identifier used in resource names and tags."
  type        = string
  default     = "rag"
}

# Pass the exact sub claim issued to the authorized GitHub Actions workflow.
variable "repository_subject" {
  description = "Exact GitHub Actions OIDC sub claim allowed to assume the CI role."
  type        = string
}

# Supply common tags for resources created by this module.
# Include the project and environment when passing this value.
variable "tags" {
  description = "Common tags applied to module resources."
  type        = map(string)
  default     = {}
}

# Set how long CloudWatch retains log events.
# Keep the default at seven days for the development deployment.
variable "log_retention_days" {
  description = "Number of days to retain logs in CloudWatch."
  type        = number
  default     = 7
}

# Explicit IAM identities authorized to assume the application's runtime role.
# This keeps role access independent of the application's hosting environment
# and avoids automatically trusting the identity executing Terraform.
variable "runtime_principal_arns" {
  description = "Specific IAM principal ARNs permitted to assume the application role using STS; independent of where the runtime is hosted."
  type        = list(string)
  default     = []

  # Accept only specific IAM role or user ARNs.
  # Reject wildcard principals and temporary STS assumed-role session ARNs
  # to prevent overly broad or unpredictable trust relationships.
  validation {
    condition = alltrue([
      for arn in var.runtime_principal_arns :
      can(regex("^arn:[^:]+:iam::[0-9]{12}:(role|user)/[^*]+$", arn))
    ])
    error_message = "Each runtime_principal_arns entry must be a specific IAM role or user ARN (not a wildcard or STS session ARN)."
  }
}

# AWS services authorized to assume the application's runtime role.
# This only gets configured when the application uses a service-managed 
# execution role; 
# For example, a Lambda execution role or an ECS task execution role.
# Service-specific trust conditions may also be required.
variable "runtime_service_principals" {
  description = "Specific AWS service principals permitted to assume the application role, only when using a service-managed execution role."
  type        = list(string)
  default     = []

  # Require explicitly named AWS service principals, such as
  # lambda.amazonaws.com, rather than wildcard trust relationships.
  # The pattern also accommodates AWS China service principal suffixes.
  validation {
    condition = alltrue([
      for principal in var.runtime_service_principals :
      can(regex("^[a-z0-9.-]+\\.amazonaws\\.com(\\.cn)?$", principal))
    ])
    error_message = "Use explicit AWS service principal names; wildcards are not allowed."
  }
}

# S3 object-key prefix reserved for sanitized RAG evaluation evidence.
# Restricting uploads to this prefix prevents the application from writing
# arbitrary objects elsewhere in the evidence bucket.
variable "evidence_prefix" {
  description = "S3 object-key prefix reserved for sanitized evaluation evidence, including the trailing slash."
  type        = string
  default     = "evaluations/"

  # Require a relative prefix ending in "/" so IAM object ARNs can target
  # a predictable path. Reject leading slashes, wildcard characters, and
  # ".." to reduce the risk of unintended object-key patterns.
  validation {
    condition = (
      length(var.evidence_prefix) > 1 &&
      endswith(var.evidence_prefix, "/") &&
      !startswith(var.evidence_prefix, "/") &&
      !strcontains(var.evidence_prefix, "*") &&
      !strcontains(var.evidence_prefix, "?") &&
      !strcontains(var.evidence_prefix, "..")
    )
    error_message = "evidence_prefix must be a nonempty relative S3 prefix ending in / and containing no wildcards or '..'."
  }
}
