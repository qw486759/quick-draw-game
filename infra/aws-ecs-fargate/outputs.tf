output "ecr_repository_url" {
  description = "ECR repository URL used for Docker tag and push."
  value       = aws_ecr_repository.app.repository_url
}

output "alb_dns_name" {
  description = "Public DNS name of the Application Load Balancer."
  value       = aws_lb.app.dns_name
}

output "service_url" {
  description = "Public HTTP URL for the ECS service."
  value       = "http://${aws_lb.app.dns_name}"
}
