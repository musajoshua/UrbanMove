#!/usr/bin/env bash
#
# provision-ec2.sh — Provision an EC2 instance for UrbanMove using AWS CLI.
#
# Usage:
#   ./scripts/provision-ec2.sh
#
# Prerequisites:
#   - AWS CLI v2 installed and configured (aws configure)
#   - Credentials with EC2/VPC permissions
#
set -euo pipefail

REGION="eu-west-3"
INSTANCE_TYPE="t3.micro"
VOLUME_SIZE=30
KEY_NAME="urbanmove-deploy-key"
SG_NAME="urbanmove-sg"
PROJECT="UrbanMove"
ENV_TAG="staging"

echo "========================================"
echo " UrbanMove — EC2 Provisioning"
echo " Region: $REGION"
echo "========================================"
echo ""

# ── 1. Detect your public IP ─────────────────────────────────────────────
echo "[1/6] Detecting your public IP..."
MY_IP="$(curl -s https://checkip.amazonaws.com)/32"
echo "  Your IP: $MY_IP"

# ── 2. Find the latest Ubuntu 24.04 amd64 AMI ────────────────────────────
echo "[2/6] Finding latest Ubuntu 24.04 LTS amd64 AMI in $REGION..."
AMI_ID=$(aws ec2 describe-images \
  --region "$REGION" \
  --owners 099720109477 \
  --filters \
    "Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*" \
    "Name=architecture,Values=x86_64" \
    "Name=state,Values=available" \
  --query 'Images | sort_by(@, &CreationDate) | [-1].ImageId' \
  --output text)

if [[ -z "$AMI_ID" || "$AMI_ID" == "None" ]]; then
  echo "Error: Could not find Ubuntu 24.04 amd64 AMI in $REGION"
  exit 1
fi
echo "  AMI: $AMI_ID"

# ── 3. Create key pair (skip if it already exists) ───────────────────────
echo "[3/6] Setting up key pair '$KEY_NAME'..."
KEY_FILE="${KEY_NAME}.pem"

if aws ec2 describe-key-pairs --region "$REGION" --key-names "$KEY_NAME" &>/dev/null; then
  echo "  Key pair '$KEY_NAME' already exists in AWS."
  if [[ ! -f "$KEY_FILE" ]]; then
    echo "  Warning: Local key file '$KEY_FILE' not found."
    echo "  If you lost it, delete the key pair and re-run:"
    echo "    aws ec2 delete-key-pair --region $REGION --key-name $KEY_NAME"
    exit 1
  fi
else
  aws ec2 create-key-pair \
    --region "$REGION" \
    --key-name "$KEY_NAME" \
    --key-type ed25519 \
    --query 'KeyMaterial' \
    --output text > "$KEY_FILE"
  chmod 400 "$KEY_FILE"
  echo "  Created key pair and saved to $KEY_FILE"
fi

# ── 4. Create security group (skip if it already exists) ─────────────────
echo "[4/6] Setting up security group '$SG_NAME'..."

SG_ID=$(aws ec2 describe-security-groups \
  --region "$REGION" \
  --filters "Name=group-name,Values=$SG_NAME" \
  --query 'SecurityGroups[0].GroupId' \
  --output text 2>/dev/null || echo "None")

if [[ "$SG_ID" == "None" || -z "$SG_ID" ]]; then
  SG_ID=$(aws ec2 create-security-group \
    --region "$REGION" \
    --group-name "$SG_NAME" \
    --description "Security group for UrbanMove EC2 instance" \
    --query 'GroupId' \
    --output text)
  echo "  Created security group: $SG_ID"

  aws ec2 create-tags \
    --region "$REGION" \
    --resources "$SG_ID" \
    --tags Key=Project,Value="$PROJECT" Key=Environment,Value="$ENV_TAG"

  # SSH — from my IP only
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --ip-permissions "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=$MY_IP,Description=SSH}]"

  # HTTP — public
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --ip-permissions "IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0,Description=HTTP}]"

  # Dashboard — public
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --ip-permissions "IpProtocol=tcp,FromPort=3000,ToPort=3000,IpRanges=[{CidrIp=0.0.0.0/0,Description=Dashboard}]"

  # Grafana — public
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --ip-permissions "IpProtocol=tcp,FromPort=3001,ToPort=3001,IpRanges=[{CidrIp=0.0.0.0/0,Description=Grafana}]"

  # API services — public
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --ip-permissions "IpProtocol=tcp,FromPort=4001,ToPort=4005,IpRanges=[{CidrIp=0.0.0.0/0,Description=API-services}]"

  # Prometheus — public
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --ip-permissions "IpProtocol=tcp,FromPort=9090,ToPort=9090,IpRanges=[{CidrIp=0.0.0.0/0,Description=Prometheus}]"

  # Kafka external — from my IP only
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --ip-permissions "IpProtocol=tcp,FromPort=9094,ToPort=9094,IpRanges=[{CidrIp=$MY_IP,Description=Kafka-external}]"

  echo "  Ingress rules configured."
else
  echo "  Security group already exists: $SG_ID"
fi

# ── 5. Launch the EC2 instance ────────────────────────────────────────────
echo "[5/6] Launching $INSTANCE_TYPE instance..."

INSTANCE_ID=$(aws ec2 run-instances \
  --region "$REGION" \
  --image-id "$AMI_ID" \
  --instance-type "$INSTANCE_TYPE" \
  --key-name "$KEY_NAME" \
  --security-group-ids "$SG_ID" \
  --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=$VOLUME_SIZE,VolumeType=gp3,Encrypted=true,DeleteOnTermination=true}" \
  --metadata-options "HttpTokens=required,HttpEndpoint=enabled" \
  --tag-specifications \
    "ResourceType=instance,Tags=[{Key=Name,Value=urbanmove-server},{Key=Project,Value=$PROJECT},{Key=Environment,Value=$ENV_TAG}]" \
    "ResourceType=volume,Tags=[{Key=Name,Value=urbanmove-root},{Key=Project,Value=$PROJECT},{Key=Environment,Value=$ENV_TAG}]" \
  --query 'Instances[0].InstanceId' \
  --output text)

echo "  Instance ID: $INSTANCE_ID"

# ── 6. Wait for the instance to be running and get its public IP ──────────
echo "[6/6] Waiting for instance to be running..."
aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"

PUBLIC_IP=$(aws ec2 describe-instances \
  --region "$REGION" \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text)

PUBLIC_DNS=$(aws ec2 describe-instances \
  --region "$REGION" \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicDnsName' \
  --output text)

echo ""
echo "========================================"
echo " Instance is running!"
echo "========================================"
echo ""
echo " Instance ID:    $INSTANCE_ID"
echo " Public IP:      $PUBLIC_IP"
echo " Public DNS:     $PUBLIC_DNS"
echo " AMI:            $AMI_ID"
echo " Key file:       $KEY_FILE"
echo ""
echo " SSH command:"
echo "   ssh -i $KEY_FILE ubuntu@$PUBLIC_IP"
echo ""
echo " Wait ~60s for the instance to finish booting, then deploy:"
echo "   ./scripts/deploy-ec2.sh $PUBLIC_IP $KEY_FILE"
echo ""
echo "========================================"
