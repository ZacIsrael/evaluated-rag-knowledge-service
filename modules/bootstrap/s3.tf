# Read the account ID associated with the AWS credentials used by Terraform.
data "aws_caller_identity" "current" {}

# Keep Terraform state separate from the corpus and evidence bucket.
resource "aws_s3_bucket" "tf_state_bucket" {
  bucket = "${var.project}-${var.environment}-tf-state-bucket-${data.aws_caller_identity.current.account_id}"
}

# Prevent public access through bucket policies and ACLs.
resource "aws_s3_bucket_public_access_block" "tf_state_bucket" {
  bucket = aws_s3_bucket.tf_state_bucket.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Enable versioning 
resource "aws_s3_bucket_versioning" "tf_state_bucket" {
  bucket = aws_s3_bucket.tf_state_bucket.id

  versioning_configuration {
    status = "Enabled"
  }
}


# Encrypt new objects with the AWS-managed S3 KMS key.
# The dev backend must also request KMS encryption when uploading state and locks.
resource "aws_s3_bucket_server_side_encryption_configuration" "tf_state_bucket" {
  bucket = aws_s3_bucket.tf_state_bucket.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
  }
}

# Deny non-HTTPS requests to both the bucket and its objects.
data "aws_iam_policy_document" "enforce_https" {
  statement {
    sid    = "EnforceHTTPSRequestsOnly"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.tf_state_bucket.arn,
      "${aws_s3_bucket.tf_state_bucket.arn}/*"
    ]

    # Deny the request when AWS reports that secure transport is false.
    # This applies regardless of any separate Allow permission.
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

# Apply the transport restriction to this state bucket.
resource "aws_s3_bucket_policy" "attach_enforce_https" {
  bucket = aws_s3_bucket.tf_state_bucket.id
  policy = data.aws_iam_policy_document.enforce_https.json
}
