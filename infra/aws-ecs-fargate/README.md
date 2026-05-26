# Quick Draw — AWS ECS Fargate Deployment

This directory contains the Terraform configuration for deploying Quick Draw as a containerized AWS ECS Fargate application.

The deployment turns the original browser-based TensorFlow.js drawing game into a reproducible cloud-deployable application while preserving the original application architecture:

- TensorFlow.js inference runs in the browser.
- Node.js / Express serves the frontend and REST APIs.
- Socket.io handles real-time multiplayer synchronization.
- Multiplayer room state remains in memory.
- AWS ECS Fargate runs the application container.
- Application Load Balancer provides the public HTTP/WebSocket entry point.

---

## Architecture

```text
Internet
  ↓
Application Load Balancer
  ↓
Target Group
  ↓
ECS Service
  ↓
Fargate Task
  ↓
Node.js / Express / Socket.io container
  ↓
Static frontend + TensorFlow.js model
```

AWS resources provisioned by Terraform:

```text
Amazon ECR                Docker image registry
Amazon ECS Cluster        Container orchestration control plane
AWS Fargate               Serverless container runtime
Application Load Balancer Public HTTP/WebSocket entry point
Target Group              Health checks and task routing
Security Groups           ALB and ECS network boundaries
IAM Execution Role        Allows ECS to pull ECR images and write logs
CloudWatch Logs           Container runtime logs
```

---

## Design Decisions

### Browser-side ML inference

The TensorFlow.js model is loaded by the frontend and executed directly in the browser.

The backend does not perform model inference, GPU computation, or Python model serving. ECS is used to host the web application and multiplayer backend, not to serve ML inference.

This keeps the backend lightweight and avoids unnecessary backend GPU infrastructure cost.

---

### Single ECS task

The ECS service intentionally uses:

```hcl
desired_count = 1
```

The multiplayer room manager stores active rooms, players, scores, and round state in process memory. Running multiple ECS tasks without an external state layer could split players across different containers.

A horizontally scalable production version would require one or more of the following:

- Redis-backed room state
- Socket.io Redis adapter
- External session persistence
- Sticky sessions
- Pub/sub event propagation

For this project, a single Fargate task is an intentional trade-off that preserves application correctness while demonstrating managed container deployment.

---

### ALB as the public entry point

The ECS task is not exposed directly to the internet.

Traffic flows through the Application Load Balancer:

```text
Browser → ALB port 80 → ECS task port 3000
```

The ALB security group allows public HTTP traffic on port 80.

The ECS service security group only allows inbound traffic from the ALB security group on the container port.

This keeps the public entry point separate from the container runtime.

---

### Same-origin frontend configuration

The frontend uses runtime same-origin configuration:

```js
const origin = window.location.origin;

window.APP_CONFIG = {
  SOCKET_URL: origin,
  API_BASE_URL: origin,
};
```

This allows the same frontend code to work across local development and AWS ALB deployment without hardcoded backend URLs.

Examples:

```text
Local:
http://localhost:3000/api/rooms

AWS ECS:
http://<alb-dns-name>/api/rooms
```

This avoids CORS issues and makes the frontend portable across deployment environments.

---

### Default VPC and public subnets

This deployment uses the AWS default VPC and public subnets.

That choice is intentional for a portfolio/demo deployment:

- no NAT Gateway cost
- simpler Terraform configuration
- faster reproducibility
- easier validation and teardown

The ECS task is assigned a public IP so it can pull images from ECR and write logs to CloudWatch without requiring NAT Gateway or VPC endpoints.

Inbound access is still restricted by security groups. The task only accepts traffic from the ALB security group.

A production version would normally use private subnets, NAT Gateway or VPC endpoints, custom VPC boundaries, HTTPS, and more restrictive networking.

---

## Prerequisites

Install and configure:

- AWS CLI
- Terraform
- Docker
- An AWS account with permissions for ECR, ECS, IAM, ALB, EC2 networking, and CloudWatch Logs

Authenticate AWS CLI:

```powershell
aws sts get-caller-identity
```

---

## Terraform Variables

Copy the example variables file:

```powershell
Copy-Item terraform.tfvars.example terraform.tfvars
```

Example values:

```hcl
aws_region     = "us-east-1"
project_name   = "quick-draw-game"
service_name   = "quick-draw-backend"
image_tag      = "latest"
container_port = 3000
task_cpu       = 256
task_memory    = 512
desired_count  = 1
```

Do not commit `terraform.tfvars`.

---

## Deployment Workflow

Run Terraform from this directory:

```powershell
cd infra/aws-ecs-fargate
```

Initialize Terraform:

```powershell
terraform init
```

Review the plan:

```powershell
terraform plan
```

Create the infrastructure:

```powershell
terraform apply
```

Expected resource categories:

- ECR repository
- CloudWatch log group
- ECS cluster
- ALB and target group
- Security groups
- IAM execution role
- ECS task definition
- ECS service

After apply, Terraform outputs:

```text
ecr_repository_url
alb_dns_name
service_url
```

---

## Build and Push Docker Image

From the repository root:

```powershell
docker build -t quick-draw-game:latest .
```

Set the ECR repository URL from Terraform output:

```powershell
$ECR_URL = "<account-id>.dkr.ecr.us-east-1.amazonaws.com/quick-draw-game"
```

Tag the image:

```powershell
docker tag quick-draw-game:latest ${ECR_URL}:latest
```

Authenticate Docker to ECR:

```powershell
cmd /c "aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <account-id>.dkr.ecr.us-east-1.amazonaws.com"
```

Push the image:

```powershell
docker push ${ECR_URL}:latest
```

---

## Force ECS Deployment

If the ECS service was created before the image existed, or if the `latest` tag was rebuilt, force a new deployment:

```powershell
aws ecs update-service `
  --cluster quick-draw-game-cluster `
  --service quick-draw-backend `
  --force-new-deployment `
  --region us-east-1
```

This instructs ECS to start a new task using the current task definition and pull the current image from ECR.

---

## Validation

### ECS service status

```powershell
aws ecs describe-services `
  --cluster quick-draw-game-cluster `
  --services quick-draw-backend `
  --region us-east-1 `
  --query "services[0].{status:status,desired:desiredCount,running:runningCount,pending:pendingCount,events:events[0:3]}"
```

Expected:

```text
status: ACTIVE
desired: 1
running: 1
pending: 0
```

### Target group health

```powershell
$TG_ARN = aws elbv2 describe-target-groups `
  --names quick-draw-game-tg `
  --region us-east-1 `
  --query "TargetGroups[0].TargetGroupArn" `
  --output text

aws elbv2 describe-target-health `
  --target-group-arn $TG_ARN `
  --region us-east-1 `
  --query "TargetHealthDescriptions[*].{target:Target.Id,port:Target.Port,state:TargetHealth.State,reason:TargetHealth.Reason,description:TargetHealth.Description}"
```

Expected:

```text
state: healthy
```

### Public health check

```powershell
$URL = terraform output -raw service_url
(Invoke-WebRequest "$URL/api/health").StatusCode
```

Expected:

```text
200
```

### Browser validation

Open the service URL:

```powershell
Start-Process $URL
```

Validate:

- Homepage loads through the ALB.
- Free Mode works.
- Challenge Mode works.
- Multiplayer room creation works.
- Two browser sessions can join the same room.
- Socket.io multiplayer synchronization works.

---

## Runtime Logs

Container stdout and stderr are sent to CloudWatch Logs:

```powershell
aws logs tail "/ecs/quick-draw-game" `
  --region us-east-1 `
  --since 10m
```

This is useful for debugging application startup, REST requests, Socket.io events, and container runtime errors.

---

## Troubleshooting

### ECS service cannot pull image

Error:

```text
CannotPullContainerError
```

Common cause:

```text
ECR image tag does not exist yet.
```

Fix:

```powershell
docker build -t quick-draw-game:latest .
docker tag quick-draw-game:latest ${ECR_URL}:latest
docker push ${ECR_URL}:latest

aws ecs update-service `
  --cluster quick-draw-game-cluster `
  --service quick-draw-backend `
  --force-new-deployment `
  --region us-east-1
```

### ALB target is unhealthy

Check:

- container listens on port 3000
- Express app exposes `/api/health`
- target group health check path is `/api/health`
- ECS security group allows inbound traffic from the ALB security group
- task has reached running state

### Frontend calls the wrong backend

The frontend should use same-origin API and Socket.io URLs.

Correct:

```js
window.location.origin
```

Avoid hardcoded backend URLs in frontend JavaScript.

---

## Cost Control

This deployment is intended for short-lived validation and demos.

Resources that may incur cost include:

- Application Load Balancer
- Fargate task runtime
- ECR image storage
- CloudWatch Logs

After validation:

```powershell
terraform destroy
```

Expected:

```text
Destroy complete
```

The normal workflow is:

```text
terraform apply
→ build and push image
→ validate ECS / ALB / app behavior
→ terraform destroy
```

---

## Validation Evidence

The deployment was validated with:

- Terraform apply completed successfully.
- ECS service reached steady state.
- Target group reported healthy targets.
- `/api/health` returned HTTP 200 through the ALB.
- Homepage loaded through the ALB DNS name.
- Free Mode inference worked.
- Challenge Mode inference worked.
- Versus Mode room creation worked.
- Two browser sessions joined the same multiplayer room.
- Socket.io multiplayer flow worked through the ALB.

Screenshots are stored under:

```text
docs/assets/
```
