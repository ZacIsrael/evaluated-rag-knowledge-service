# Read the account ID associated with the AWS credentials used by Terraform.
data "aws_caller_identity" "current" {}

# Store the corpus, index releases, and sanitized evidence in one private bucket.
# Include the account ID to reduce naming collisions across AWS accounts.
resource "aws_s3_bucket" "corpus_index_sanitized_evidence" {
  bucket = "${var.project}-${var.environment}-corpus-index-sanitized-evidence-${data.aws_caller_identity.current.account_id}"

  # Apply the project's resource tags to the bucket.
  tags = var.tags
}

# This is PRIVATE bucket
# Block public access through ACLs and bucket policies.
resource "aws_s3_bucket_public_access_block" "corpus_index_sanitized_evidence" {
  bucket = aws_s3_bucket.corpus_index_sanitized_evidence.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Enable versioning 
resource "aws_s3_bucket_versioning" "corpus_index_sanitized_evidence" {
  bucket = aws_s3_bucket.corpus_index_sanitized_evidence.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Disable ACL-based access; use policies to control object permissions.
resource "aws_s3_bucket_ownership_controls" "corpus_index_sanitized_evidence" {
  bucket = aws_s3_bucket.corpus_index_sanitized_evidence.id

  rule {
    object_ownership = "BucketOwnerEnforced"
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
      aws_s3_bucket.corpus_index_sanitized_evidence.arn,
      "${aws_s3_bucket.corpus_index_sanitized_evidence.arn}/*"
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

# Attach the HTTPS-only policy document to the bucket.
# The policy takes effect when Terraform creates this resource.
resource "aws_s3_bucket_policy" "attach_enforce_https" {
  bucket = aws_s3_bucket.corpus_index_sanitized_evidence.id
  policy = data.aws_iam_policy_document.enforce_https.json
}

# Explicitly set SSE-S3 as the default encryption for new objects.
resource "aws_s3_bucket_server_side_encryption_configuration" "corpus_index_sanitized_evidence_sse" {
  bucket = aws_s3_bucket.corpus_index_sanitized_evidence.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}