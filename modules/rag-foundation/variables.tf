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
