#!/usr/bin/env bash
# ===========================================================================
# DAD — Development Setup Script
# ===========================================================================
# FOR DEVELOPMENT ONLY — end users should install the .deb package from
# GitHub Releases (see README.md).
#
# Installs all prerequisites for building and running DAD from source on an
# Ubuntu/Debian WSL distro. Safe to re-run (idempotent).
#
# Prerequisites installed:
#   - tmux          (session persistence)
#   - build-essential, python3  (native Node module compilation)
#   - fnm           (Fast Node Manager)
#   - Node.js LTS   (via fnm)
#   - npm packages  (project dependencies + native module rebuild)
#   - @github/copilot (GitHub Copilot CLI, globally)
#
# Usage:
#   cd /path/to/agent-smith
#   ./setup.sh
# ===========================================================================

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
err()   { echo -e "${RED}[✗]${NC} $1"; }

cd "$(dirname "$0")"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║              DAD — DEVELOPMENT SETUP                ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ---------------------------------------------------------------------------
# 1. System packages (tmux, build tools)
# ---------------------------------------------------------------------------
echo "── System packages ──────────────────────────────────────"

PKGS_TO_INSTALL=()

if command -v tmux >/dev/null 2>&1; then
  info "tmux already installed ($(tmux -V))"
else
  PKGS_TO_INSTALL+=(tmux)
fi

if dpkg -s build-essential >/dev/null 2>&1; then
  info "build-essential already installed"
else
  PKGS_TO_INSTALL+=(build-essential)
fi

if command -v python3 >/dev/null 2>&1; then
  info "python3 already installed ($(python3 --version 2>&1))"
else
  PKGS_TO_INSTALL+=(python3)
fi

if [ ${#PKGS_TO_INSTALL[@]} -gt 0 ]; then
  warn "Installing: ${PKGS_TO_INSTALL[*]}"
  sudo apt-get update -qq
  sudo apt-get install -y -qq "${PKGS_TO_INSTALL[@]}"
  info "System packages installed"
else
  info "All system packages present"
fi

echo ""

# ---------------------------------------------------------------------------
# 2. fnm (Fast Node Manager)
# ---------------------------------------------------------------------------
echo "── Node version manager (fnm) ──────────────────────────"

FNM_DIR="$HOME/.local/share/fnm"

if command -v fnm >/dev/null 2>&1; then
  info "fnm already installed ($(fnm --version))"
elif [ -d "$FNM_DIR" ]; then
  export PATH="$FNM_DIR:$PATH"
  info "fnm found at $FNM_DIR"
else
  warn "Installing fnm..."
  curl -fsSL https://fnm.vercel.app/install | bash -s -- --install-dir "$FNM_DIR" --skip-shell
  export PATH="$FNM_DIR:$PATH"
  info "fnm installed to $FNM_DIR"
fi

# Activate fnm for the rest of this script
eval "$(fnm env --shell bash)"

echo ""

# ---------------------------------------------------------------------------
# 3. Node.js (LTS)
# ---------------------------------------------------------------------------
echo "── Node.js ──────────────────────────────────────────────"

# Use .node-version or .nvmrc if present, otherwise LTS
if [ -f ".node-version" ]; then
  NODE_TARGET=$(cat .node-version)
elif [ -f ".nvmrc" ]; then
  NODE_TARGET=$(cat .nvmrc)
else
  NODE_TARGET="--lts"
fi

if command -v node >/dev/null 2>&1; then
  info "Node.js already available ($(node --version))"
else
  warn "Installing Node.js ($NODE_TARGET)..."
  fnm install "$NODE_TARGET"
  fnm use "$NODE_TARGET"
  info "Node.js installed ($(node --version))"
fi

# Ensure the installed version is active
fnm use "$NODE_TARGET" 2>/dev/null || true

echo ""

# ---------------------------------------------------------------------------
# 4. Project npm dependencies
# ---------------------------------------------------------------------------
echo "── Project dependencies ──────────────────────────────────"

if [ -d "node_modules" ] && [ -f "node_modules/.package-lock.json" ]; then
  info "node_modules exists — running npm install to sync"
fi
npm install --no-fund --no-audit
info "npm dependencies installed (includes native module rebuild via postinstall)"

echo ""

# ---------------------------------------------------------------------------
# 5. GitHub Copilot CLI
# ---------------------------------------------------------------------------
echo "── GitHub Copilot CLI ────────────────────────────────────"

if command -v copilot >/dev/null 2>&1; then
  info "copilot CLI already installed ($(copilot --version 2>&1 | head -1))"
else
  warn "Installing @github/copilot globally..."
  npm install -g @github/copilot
  info "copilot CLI installed"
fi

echo ""

# ---------------------------------------------------------------------------
# 6. Shell integration hint
# ---------------------------------------------------------------------------
echo "── Shell integration ─────────────────────────────────────"
echo ""

SHELL_NAME=$(basename "$SHELL")
RC_FILE="$HOME/.${SHELL_NAME}rc"

if grep -q "fnm env" "$RC_FILE" 2>/dev/null; then
  info "fnm already configured in $RC_FILE"
else
  warn "Add the following to $RC_FILE so fnm loads in new terminals:"
  echo ""
  echo "    # fnm (Node version manager)"
  echo "    export PATH=\"\$HOME/.local/share/fnm:\$PATH\""
  echo "    eval \"\$(fnm env --shell $SHELL_NAME)\""
  echo ""
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo "╔══════════════════════════════════════════════════════╗"
echo "║                  SETUP COMPLETE                     ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  Run the app:   ./launch.sh                        ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
