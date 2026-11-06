# Outputs: bucket names, state key, role ARNs and log group—not credentials.

# Return the name of the bucket used for the document corpus,
# index releases, and sanitized evaluation evidence.
output "sanitized_evidence_bucket_name" {
  description = "Name of the private S3 bucket used for the corpus, index releases, and sanitized evaluation evidence."
  value       = aws_s3_bucket.corpus_index_sanitized_evidence.id
}

# Return the bucket ARN for IAM policies and other resources
# that need to reference the bucket that is used for the document 
# corpus, index releases, and sanitized evaluation evidence.
output "sanitized_evidence_bucket_arn" {
  description = "ARN of the private S3 bucket."
  value       = aws_s3_bucket.corpus_index_sanitized_evidence.arn
}

# Return the IAM role ARN used by the RAG application at runtime.
# The role controls access to Bedrock, S3 evidence, and CloudWatch Logs.
output "rag_runtime_role_arn" {
  description = "ARN of the RAG application's IAM runtime role."
  value       = aws_iam_role.bedrock.arn
}

# Return the CloudWatch log group name so the application
# and troubleshooting tools can locate its logs.
output "log_group_name" {
  description = "Name of the CloudWatch log group used by the RAG application."
  value       = aws_cloudwatch_log_group.rag.name
}
