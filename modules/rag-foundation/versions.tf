# Pin the AWS provider used by this project's Terraform modules.
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.73.0"
    }
  }
}