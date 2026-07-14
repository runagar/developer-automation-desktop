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

exec npm start
