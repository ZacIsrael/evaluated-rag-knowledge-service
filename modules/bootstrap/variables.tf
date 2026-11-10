# Distinguish the state bucket for this deployment environment.
variable "environment" {
  description = "Deployment environment, such as dev."
  type        = string
}


# Keep the project identifier short because S3 bucket names have a length limit.
variable "project" {
  description = "Short project identifier used in resource names and tags."
  type        = string
  default     = "rag"
}
