#!/usr/bin/env bash
# Agent Smith launcher
# Run this from WSL to start the Agent Smith application.

set -e
cd "$(dirname "$0")"

# Initialize Node version manager (fnm or nvm) so that `node` and `npm` are
# available even when launched from a Windows desktop shortcut or bare shell.
if command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env --shell bash)"
elif [ -d "$HOME/.local/share/fnm" ]; then
  export PATH="$HOME/.local/share/fnm:$PATH"
  eval "$(fnm env --shell bash)"
elif [ -s "$HOME/.nvm/nvm.sh" ]; then
  source "$HOME/.nvm/nvm.sh"
fi

# Verify node is available
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js not found. Run ./setup.sh first." >&2
  exit 1
fi

exec npm start
