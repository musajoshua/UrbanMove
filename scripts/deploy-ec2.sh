#!/usr/bin/env bash
#
# deploy-ec2.sh — Deploy the UrbanMove platform to an EC2 instance.
#
# Usage:
#   ./scripts/deploy-ec2.sh <EC2_PUBLIC_IP> <SSH_KEY_PATH>
#
set -euo pipefail

# ── Arguments ─────────────────────────────────────────────────────────────
EC2_IP="${1:-}"
SSH_KEY="${2:-}"

if [[ -z "$EC2_IP" || -z "$SSH_KEY" ]]; then
  echo "Usage: $0 <EC2_PUBLIC_IP> <SSH_KEY_PATH>"
  echo "Example: $0 13.38.42.100 ~/.ssh/urbanmove-deploy-key.pem"
  exit 1
fi

if [[ ! -f "$SSH_KEY" ]]; then
  echo "Error: SSH key not found at $SSH_KEY"
  exit 1
fi

SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"
SSH_CMD="ssh $SSH_OPTS -i $SSH_KEY ubuntu@$EC2_IP"
SCP_CMD="scp $SSH_OPTS -i $SSH_KEY"

REMOTE_DIR="/opt/urbanmove"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "========================================"
echo " UrbanMove — EC2 Deployment"
echo "========================================"
echo " Target:  ubuntu@$EC2_IP"
echo " Key:     $SSH_KEY"
echo " Source:  $PROJECT_ROOT"
echo "========================================"
echo ""

# ── 1. Test SSH connectivity ─────────────────────────────────────────────
echo "[1/7] Testing SSH connectivity..."
if ! $SSH_CMD "echo 'SSH OK'" 2>/dev/null; then
  echo "Error: Cannot SSH into $EC2_IP. Check that:"
  echo "  - The instance is running"
  echo "  - Security group allows SSH from your IP"
  echo "  - The key file is correct"
  exit 1
fi
echo "  Connected successfully."

# ── 2. Run setup script if Docker is missing ─────────────────────────────
echo "[2/7] Checking if Docker is installed..."
if ! $SSH_CMD "command -v docker" &>/dev/null; then
  echo "  Docker not found — running setup script..."
  $SCP_CMD "$PROJECT_ROOT/scripts/setup-ec2.sh" "ubuntu@$EC2_IP:/tmp/setup-ec2.sh"
  $SSH_CMD "chmod +x /tmp/setup-ec2.sh && /tmp/setup-ec2.sh"
  echo "  Setup complete. Reconnecting with docker group..."
else
  echo "  Docker is already installed."
fi

# Ensure project directory exists
$SSH_CMD "sudo mkdir -p $REMOTE_DIR && sudo chown ubuntu:ubuntu $REMOTE_DIR"

# ── 3. Copy project files ────────────────────────────────────────────────
echo "[3/7] Syncing project files to $EC2_IP:$REMOTE_DIR ..."
rsync -az --progress \
  -e "ssh $SSH_OPTS -i $SSH_KEY" \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='dist' \
  --exclude='.terraform' \
  --exclude='*.tfstate' \
  --exclude='*.tfstate.*' \
  --exclude='simulator/node_modules' \
  --exclude='.env' \
  "$PROJECT_ROOT/" "ubuntu@$EC2_IP:$REMOTE_DIR/"
echo "  Sync complete."

# ── 4. Update Kafka advertised listener to use the EC2 public IP ─────────
echo "[4/7] Patching Kafka EXTERNAL advertised listener for EC2 IP..."
$SSH_CMD "cd $REMOTE_DIR && \
  if grep -q 'EXTERNAL://localhost:9094' docker-compose.yml; then
    sed -i 's|EXTERNAL://localhost:9094|EXTERNAL://${EC2_IP}:9094|g' docker-compose.yml
    echo '  Patched KAFKA_ADVERTISED_LISTENERS → EXTERNAL://${EC2_IP}:9094'
  else
    echo '  Already patched or not using localhost.'
  fi"

# ── 5. Build and start services ──────────────────────────────────────────
echo "[5/7] Building and starting services (this may take several minutes)..."
$SSH_CMD "cd $REMOTE_DIR && docker compose up -d --build" 2>&1 | tail -30
echo "  Containers launched."

# ── 6. Wait for services to be healthy ───────────────────────────────────
echo "[6/7] Waiting for services to become healthy..."

HEALTH_PORTS=(4001 4002 4003 4004 4005)
HEALTH_NAMES=("auth-service" "ingestion-service" "analytics-service" "fleet-service" "user-api")
MAX_WAIT=180
INTERVAL=10
ELAPSED=0

all_healthy() {
  for port in "${HEALTH_PORTS[@]}"; do
    if ! $SSH_CMD "curl -sf http://localhost:${port}/health" &>/dev/null; then
      return 1
    fi
  done
  return 0
}

while ! all_healthy; do
  if [[ $ELAPSED -ge $MAX_WAIT ]]; then
    echo ""
    echo "  Warning: Not all services healthy after ${MAX_WAIT}s."
    echo "  Checking individual service status..."
    for i in "${!HEALTH_PORTS[@]}"; do
      port="${HEALTH_PORTS[$i]}"
      name="${HEALTH_NAMES[$i]}"
      if $SSH_CMD "curl -sf http://localhost:${port}/health" &>/dev/null; then
        echo "    ✓ $name (:$port) — healthy"
      else
        echo "    ✗ $name (:$port) — NOT healthy"
      fi
    done
    echo ""
    echo "  Check logs with: ssh -i $SSH_KEY ubuntu@$EC2_IP 'cd $REMOTE_DIR && docker compose logs --tail=50'"
    break
  fi
  echo "  Waiting... (${ELAPSED}s / ${MAX_WAIT}s)"
  sleep "$INTERVAL"
  ELAPSED=$((ELAPSED + INTERVAL))
done

if all_healthy; then
  echo "  All services are healthy!"
fi

# ── 7. Print service URLs ────────────────────────────────────────────────
echo ""
echo "========================================"
echo " UrbanMove — Deployment Complete"
echo "========================================"
echo ""
echo " Dashboard:          http://${EC2_IP}:3000"
echo " Grafana:            http://${EC2_IP}:3001  (admin / admin)"
echo " Prometheus:         http://${EC2_IP}:9090"
echo ""
echo " API Endpoints:"
echo "   Auth Service:     http://${EC2_IP}:4001"
echo "   Ingestion:        http://${EC2_IP}:4002"
echo "   Analytics:        http://${EC2_IP}:4003"
echo "   Fleet:            http://${EC2_IP}:4004"
echo "   User API:         http://${EC2_IP}:4005"
echo ""
echo " Kafka External:     ${EC2_IP}:9094"
echo ""
echo " SSH into instance:  ssh -i $SSH_KEY ubuntu@$EC2_IP"
echo " View logs:          ssh -i $SSH_KEY ubuntu@$EC2_IP 'cd $REMOTE_DIR && docker compose logs -f'"
echo ""
echo " Run the simulator locally with:"
echo "   TARGET_URL=http://${EC2_IP}:4002 npm start"
echo ""
echo "========================================"
