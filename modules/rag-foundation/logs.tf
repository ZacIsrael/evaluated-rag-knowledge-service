# Retain application logs for the configured period (seven days in dev).
resource "aws_cloudwatch_log_group" "rag" {
  name = "/evaluated-rag-knowledge-service/${var.project}/${var.environment}"

  # Delete log events after the configured retention period.
  retention_in_days = var.log_retention_days

  # Apply shared project tags
  tags = merge(
    var.tags,
    {
      Name        = "${var.environment}-evaluated-rag-knowledge-service"
      Environment = var.environment
    }
  )
}

# Create the log stream that the application will write to.
resource "aws_cloudwatch_log_stream" "rag" {
  name           = "rag"
  log_group_name = aws_cloudwatch_log_group.rag.name
}
