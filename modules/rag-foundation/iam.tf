# Get the AWS partition so the Bedrock ARNs work across AWS partitions.
data "aws_partition" "current" {}

# Define who can assume the RAG application's IAM role.
# Specific IAM identities or an AWS service can be trusted depending on where the app runs.
data "aws_iam_policy_document" "bedrock_trust" {
  # Include this trust statement only when IAM principals are supplied.
  dynamic "statement" {
    # An empty list means this block won't be generated.
    for_each = length(var.runtime_principal_arns) > 0 ? [1] : []

    content {
      # Give this statement a name that's easy to identify in IAM.
      sid = "AllowExplicitRuntimePrincipals"

      # Allow the named principals to assume the role.
      effect = "Allow"

      # Role assumption happens through AWS STS.
      actions = ["sts:AssumeRole"]

      principals {
        # These are IAM roles or users, not AWS service principals.
        type = "AWS"

        # Only trust the ARNs passed into the module.
        identifiers = var.runtime_principal_arns
      }
    }
  }

  # Include this statement when the runtime uses an AWS service role.
  dynamic "statement" {
    # Skip this block if no service principals were configured.
    for_each = length(var.runtime_service_principals) > 0 ? [1] : []

    content {
      # Use a separate SID so the two trust options are easy to distinguish.
      sid = "AllowExplicitRuntimeServices"

      # Let the configured service assume this role.
      effect = "Allow"

      # AWS services also assume roles through STS.
      actions = ["sts:AssumeRole"]

      principals {
        # This trust option is for AWS services such as Lambda or ECS tasks.
        type = "Service"

        # Use the service principal names provided in the inputs.
        identifiers = var.runtime_service_principals
      }

      # Add service-specific SourceArn or SourceAccount conditions where needed
      # once we've chosen the deployment service.
    }
  }
}

# Create the role the RAG application will use at runtime.
resource "aws_iam_role" "bedrock" {
  # Include the environment so dev and other deployments get distinct names.
  name = "${var.environment}-rag"

  # Apply the trust policy defined above.
  assume_role_policy = data.aws_iam_policy_document.bedrock_trust.json

  lifecycle {
    # Use one trust option at a time; don't mix IAM and service principals.
    precondition {
      # Require one nonempty list and one empty list.
      condition = (
        (length(var.runtime_principal_arns) > 0 && length(var.runtime_service_principals) == 0) ||
        (length(var.runtime_service_principals) > 0 && length(var.runtime_principal_arns) == 0)
      )

      # Fail early if the trust inputs haven't been set correctly.
      error_message = "Configure exactly one trust mode: runtime_principal_arns OR runtime_service_principals."
    }
  }

  # Keep the shared tags and add labels for this project and environment.
  tags = merge(var.tags, {
    # Identify the project that owns this role.
    Project = var.project

    # Identify which environment this role belongs to.
    Environment = var.environment
  })
}

# Permissions the application needs to call Bedrock, save evidence, and log results.
# Data ingestion and retrieval will need their own permissions if they use this role.
data "aws_iam_policy_document" "runtime" {
  # Allow inference only against the foundation models configured for this project.
  statement {
    # Make the permission easy to recognize in the policy.
    sid = "InvokeSelectedFoundationModels"

    # Grant the action listed below.
    effect = "Allow"

    # Non-streaming Bedrock Converse calls use InvokeModel permission.
    actions = ["bedrock:InvokeModel"]

    # Build one foundation-model ARN for each configured model ID.
    # Inference profiles and streaming calls would need a separate review.
    resources = [
      for model_id in var.model_ids :
      "arn:${data.aws_partition.current.partition}:bedrock:${var.region}::foundation-model/${model_id}"
    ]
  }

  # Let the application save sanitized evaluation output to S3.
  statement {
    # Name the evidence-writing permission.
    sid = "WriteSanitizedEvaluationEvidence"

    # Grant the S3 action below.
    effect = "Allow"

    # The app can upload objects, not read or delete them with this permission.
    actions = ["s3:PutObject"]

    # Restrict uploads to the configured evidence prefix in this bucket.
    # The object keys written by the app need to start with that prefix.
    resources = [
      "${aws_s3_bucket.corpus_index_sanitized_evidence.arn}/${var.evidence_prefix}*"
    ]
  }

  # Let the application send log events to its existing CloudWatch stream.
  statement {
    # Name the logging permission.
    sid = "WriteExistingLogStream"

    # Grant the CloudWatch Logs action below.
    effect = "Allow"

    # The stream is created by Terraform, so the app only needs to write events.
    actions = ["logs:PutLogEvents"]

    # Keep writes limited to the stream defined for this RAG service.
    resources = [aws_cloudwatch_log_stream.rag.arn]
  }
}

# Attach the runtime permissions directly to the RAG role.
resource "aws_iam_role_policy" "runtime" {
  # Give the inline policy an environment-specific name.
  name = "${var.environment}-runtime"

  # Attach it to the role created above.
  role = aws_iam_role.bedrock.id

  # Use the policy document containing the three permission statements.
  policy = data.aws_iam_policy_document.runtime.json
}
