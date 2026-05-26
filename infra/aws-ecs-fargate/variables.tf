variable "aws_region" {
  description = "AWS region used for ECR, ECS, and ALB."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Project name used for AWS resource naming."
  type        = string
  default     = "quick-draw-game"
}

variable "service_name" {
  description = "ECS service name."
  type        = string
  default     = "quick-draw-backend"
}

variable "image_tag" {
  description = "Docker image tag deployed by ECS."
  type        = string
  default     = "latest"
}

variable "container_port" {
  description = "Port exposed by the Node.js container."
  type        = number
  default     = 3000
}

variable "task_cpu" {
  description = "Fargate task CPU units. 256 = 0.25 vCPU."
  type        = number
  default     = 256
}

variable "task_memory" {
  description = "Fargate task memory in MiB."
  type        = number
  default     = 512
}

variable "desired_count" {
  description = "Number of ECS tasks to run."
  type        = number
  default     = 1
}