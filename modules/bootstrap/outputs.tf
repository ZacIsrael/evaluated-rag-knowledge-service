# Return the name of the bucket used for the tf state
output "tf_state_bucket_name" {
  description = "Name of the private S3 bucket used for tf state."
  value       = aws_s3_bucket.tf_state_bucket.id
}

# Return the bucket ARN for IAM policies and other resources that 
# need to reference the bucket that is used for the document tf state
output "tf_state_bucket_arn" {
  description = "ARN of the private S3 bucket for tf state."
  value       = aws_s3_bucket.tf_state_bucket.arn
}