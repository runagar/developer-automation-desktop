# Developer Automation Desktop (DAD)

An atompunk-themed Electron desktop environment for AI-assisted development. Manage multiple GitHub Copilot sessions, Jira integration, and markdown notes all in a single tiled workspace.

## Prerequisites

- **Linux** (Ubuntu/Debian-based, x86_64)
- **tmux** — session persistence
- **GitHub Copilot CLI** — AI coding assistant (requires Node.js)

## Install

### 1. Install NVM

It's recommended to use nvm for the install process, to avoid permission issues later.

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
```

Then reload your shell
```bash
exec $SHELL
command -v nvm   # should print "nvm"
nvm --version
```

### 1. Install prerequisites

```bash
sudo apt-get install tmux
nvm install 22 && nvm use 22
npm install -g @github/copilot
copilot --version
```

### 2. Download & install DAD

Download the latest `.deb` from [Releases](https://github.com/runagar/developer-automation-desktop/releases/latest):

```bash
# Replace <version> with the actual version number (e.g. 1.0.0)
wget https://github.com/runagar/developer-automation-desktop/releases/latest/download/dad_<version>_amd64.deb
sudo dpkg -i dad_<version>_amd64.deb
```

### 3. Launch

From the system app menu, or from a terminal:

```bash
dad
```

## Updates

DAD checks for updates automatically on each launch. When a new version is available, a notification appears in the title bar. Click **Restart** to apply. Updates can also be dismissed and will reappear on the next launch.

If you prefer to update manually, download the new `.deb` from Releases and install it with `dpkg -i`.

## Uninstall

```bash
sudo apt remove dad
```

## Configuration

On first launch, DAD will prompt you to configure:

- **Default working directory** — where new sessions start
- **Jira** — base URL + personal access token (optional)
- **Notes root** — filesystem path for markdown notes storage

Settings are stored in `~/.config/dad/dad/`.

## Development

To build and run from source:

```bash
git clone https://github.com/runagar/developer-automation-desktop.git
cd developer-automation-desktop
./setup.sh          # installs all prerequisites (tmux, fnm, Node, copilot)
./launch.sh         # starts the app in dev mode
```

### Automated Release
To publish a new release, first verify the build

```bash
npm run package
```

Then build the release

```bash
npm run release
```

`npm run release` updates `package.json` version to release version (e.g. `1.0.1-dev` -> `1.0.1`), creates a commit and tags it (e.g. `v1.0.1`).
Finally it bumps and updates `package.json` version to dev (`1.0.1` -> `1.0.2-dev`)
Push to remote

```bash
git push --follow-tags
```

This push triggers the GitHub Actions workflow which builds the `.deb` and publishes it as a GitHub Release. Existing installs will detect the new version on their next launch.
