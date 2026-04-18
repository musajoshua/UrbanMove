#!/usr/bin/env bash
#
# setup-ec2.sh — Bootstrap an Ubuntu 24.04 EC2 instance for running
# UrbanMove via Docker Compose. Run this ON the instance itself.
#
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

echo "========================================"
echo " UrbanMove — EC2 Instance Setup"
echo "========================================"

# ── 1. System update ─────────────────────────────────────────────────────
echo "[1/7] Updating apt packages..."
sudo apt-get update -qq
sudo apt-get upgrade -y -qq

# ── 2. Install prerequisites ─────────────────────────────────────────────
echo "[2/7] Installing prerequisite packages..."
sudo apt-get install -y -qq \
  ca-certificates \
  curl \
  gnupg \
  lsb-release \
  htop \
  jq \
  unzip

# ── 3. Install Docker CE ─────────────────────────────────────────────────
echo "[3/7] Installing Docker CE..."
if ! command -v docker &>/dev/null; then
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg

  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

  sudo apt-get update -qq
  sudo apt-get install -y -qq \
    docker-ce \
    docker-ce-cli \
    containerd.io \
    docker-buildx-plugin \
    docker-compose-plugin
else
  echo "  Docker already installed: $(docker --version)"
fi

# ── 4. Post-install Docker config ────────────────────────────────────────
echo "[4/7] Configuring Docker..."

sudo usermod -aG docker ubuntu

sudo systemctl enable docker
sudo systemctl enable containerd

sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json > /dev/null <<'DAEMON_JSON'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  },
  "default-address-pools": [
    { "base": "172.17.0.0/12", "size": 24 }
  ]
}
DAEMON_JSON

sudo systemctl restart docker

# ── 5. Verify installations ──────────────────────────────────────────────
echo "[5/7] Verifying installations..."
echo "  Docker:         $(docker --version)"
echo "  Compose plugin: $(docker compose version)"
echo "  htop:           $(htop --version | head -1)"
echo "  curl:           $(curl --version | head -1)"
echo "  jq:             $(jq --version)"

# ── 6. Create swap file (critical for t4g.micro with 1GB RAM) ─────────────
echo "[6/7] Creating 4GB swap file..."
if [[ ! -f /swapfile ]]; then
  sudo fallocate -l 4G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab > /dev/null
  sudo sysctl vm.swappiness=60
  echo 'vm.swappiness=60' | sudo tee -a /etc/sysctl.conf > /dev/null
  echo "  Swap enabled: $(swapon --show)"
else
  echo "  Swap already configured."
fi

# ── 7. Prepare project directory ─────────────────────────────────────────
echo "[7/7] Preparing project directory..."
sudo mkdir -p /opt/urbanmove
sudo chown ubuntu:ubuntu /opt/urbanmove

echo ""
echo "========================================"
echo " Setup complete!"
echo " RAM:               $(free -h | awk '/Mem:/{print $2}')"
echo " Swap:              $(free -h | awk '/Swap:/{print $2}')"
echo " Project directory: /opt/urbanmove"
echo " Log out and back in for docker group"
echo "========================================"
