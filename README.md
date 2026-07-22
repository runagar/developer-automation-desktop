# Developer Automation Desktop (DAD)

An atompunk-themed Electron desktop environment for AI-assisted development. Manage multiple GitHub Copilot sessions, Jira integration, and markdown notes all in a single tiled workspace.

## Prerequisites

- **Linux** (Ubuntu/Debian-based, x86_64)
- **tmux** — session persistence
- **GitHub Copilot CLI** — AI coding assistant (requires Node.js)

## Install

### 1. Install prerequisites

```bash
sudo apt-get install tmux
npm install -g @github/copilot
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

To publish a new release, bump the version on a feature branch.

```bash
npm version patch         # 1.0.0 → 1.0.1 (bug fixes)
npm version minor         # 1.0.0 → 1.1.0 (new features)
npm version major         # 1.0.0 → 2.0.0 (breaking changes)
```

`npm version` updates `package.json`, creates a commit, and tags it (e.g. `v1.0.1`).
Push and merge the branch, DO NOT push the new tag to the feature branch.
Push the tag on main:

```bash
git push origin v1.0.1
```

The tag push triggers the GitHub Actions workflow which builds the `.deb` and publishes it as a GitHub Release. Existing installs will detect the new version on their next launch.

### Manual release (when GitHub Actions is unavailable)

If Actions is disabled (e.g. enterprise restrictions), release manually:

#### 1. Verify the build

```bash
npm run package
```

Confirm `dist/dad_<version>_amd64.deb` and `dist/latest-linux.yml` are produced without errors.

#### 2. Test the .deb (recommended for first release, optional after)

```bash
sudo dpkg -i dist/dad_<version>_amd64.deb
dad                                        # verify it launches and works
sudo apt remove dad                        # clean up
```

#### 3. Bump version and tag

```bash
npm version patch    # or minor / major — creates commit + tag
```

#### 4. Push commit and tag

```bash
git push
git push origin v<version>    # e.g. git push origin v1.0.1
```

#### 5. Rebuild with the new version

```bash
npm run package
```

The `.deb` now has the correct version baked in.

#### 6. Publish the GitHub Release

```bash
gh release create v<version> dist/dad_<version>_amd64.deb dist/latest-linux.yml --generate-notes
```

This creates the release on GitHub. Installed copies of DAD will detect the new version on their next launch and show the update indicator.
