#!/usr/bin/env bash
# Agent Smith launcher
# Run this from WSL to start the Agent Smith application.

set -e
cd "$(dirname "$0")"

# Initialize fnm (Node version manager) — lives in .zshrc, not .bashrc,
# so it won't be available when launched from a Windows desktop shortcut.
FNM_PATH="/home/rulu/.local/share/fnm"
if [ -d "$FNM_PATH" ]; then
  export PATH="$FNM_PATH:$PATH"
  eval "$(fnm env --shell bash)"
fi

# Ensure native modules are built for the current Electron version
ELECTRON_VER=$(cat node_modules/electron/dist/version 2>/dev/null || echo "")
ELECTRON_GYP_DIR="$HOME/.electron-gyp/${ELECTRON_VER}"

if [ -n "$ELECTRON_VER" ] && [ ! -d "$ELECTRON_GYP_DIR" ]; then
  echo "Downloading Electron headers for v${ELECTRON_VER}..."
  mkdir -p "$ELECTRON_GYP_DIR"
  curl --proxy "${https_proxy:-}" -sL \
    "https://electronjs.org/headers/v${ELECTRON_VER}/node-v${ELECTRON_VER}-headers.tar.gz" \
    | tar -xz -C "$ELECTRON_GYP_DIR/" --strip-components=1
  echo "${ELECTRON_VER}" > "$ELECTRON_GYP_DIR/installVersion"
fi

exec npx electron-forge start
