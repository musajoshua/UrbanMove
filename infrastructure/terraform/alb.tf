# --- ALB Security Group ---

resource "aws_security_group" "alb" {
  name_prefix = "${local.name_prefix}-alb-"
  description = "ALB security group - public HTTP/HTTPS"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-alb-sg"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group_rule" "alb_ingress_http" {
  type              = "ingress"
  from_port         = 80
  to_port           = 80
  protocol          = "tcp"
  security_group_id = aws_security_group.alb.id
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "Allow HTTP from anywhere (redirects to HTTPS)"
}

resource "aws_security_group_rule" "alb_ingress_https" {
  type              = "ingress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  security_group_id = aws_security_group.alb.id
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "Allow HTTPS from anywhere"
}

resource "aws_security_group_rule" "alb_egress_workers" {
  type                     = "egress"
  from_port                = 0
  to_port                  = 65535
  protocol                 = "tcp"
  security_group_id        = aws_security_group.alb.id
  source_security_group_id = aws_security_group.eks_workers.id
  description              = "Allow ALB to forward traffic to EKS workers"
}

resource "aws_security_group_rule" "workers_ingress_alb" {
  type                     = "ingress"
  from_port                = 30000
  to_port                  = 32767
  protocol                 = "tcp"
  security_group_id        = aws_security_group.eks_workers.id
  source_security_group_id = aws_security_group.alb.id
  description              = "Allow ALB to reach NodePort services on workers"
}

# --- Application Load Balancer ---

resource "aws_lb" "main" {
  name               = "${local.name_prefix}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  enable_deletion_protection = false
  drop_invalid_header_fields = true

  tags = {
    Name = "${local.name_prefix}-alb"
  }
}

# --- Target Group ---

resource "aws_lb_target_group" "eks" {
  name     = "${local.name_prefix}-eks-tg"
  port     = 30080
  protocol = "HTTP"
  vpc_id   = aws_vpc.main.id

  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    path                = "/health"
    protocol            = "HTTP"
    matcher             = "200"
  }

  tags = {
    Name = "${local.name_prefix}-eks-tg"
  }
}

# --- HTTP Listener (upgrade to HTTPS when a real domain + validated ACM cert is available) ---

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.eks.arn
  }

  tags = {
    Name = "${local.name_prefix}-http-listener"
  }
}
