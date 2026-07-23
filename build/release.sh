#!/usr/bin/env bash
set -euo pipefail

# Release workflow:
#   1. Strip -dev suffix from current version → release version
#   2. Update package.json, commit, tag vX.Y.Z
#   3. Bump to next patch -dev version, commit
#   4. Push commits + tag to origin

cd "$(git rev-parse --show-toplevel)"

CURRENT=$(node -p "require('./package.json').version")

if [[ ! "$CURRENT" =~ ^[0-9]+\.[0-9]+\.[0-9]+-dev$ ]]; then
  echo "Error: current version ($CURRENT) does not end with -dev"
  echo "Expected format: X.Y.Z-dev"
  exit 1
fi

RELEASE="${CURRENT%-dev}"
IFS='.' read -r MAJOR MINOR PATCH <<< "$RELEASE"
NEXT_DEV="$MAJOR.$MINOR.$((PATCH + 1))-dev"

echo "Current:  $CURRENT"
echo "Release:  $RELEASE"
echo "Next dev: $NEXT_DEV"
echo ""

# Step 1: Set release version, commit, tag
npm version "$RELEASE" --no-git-tag-version --allow-same-version > /dev/null
git add package.json package-lock.json
git commit -m "release: v$RELEASE"
git tag "v$RELEASE"
echo "✓ Tagged v$RELEASE"

# Step 2: Bump to next dev version, commit
npm version "$NEXT_DEV" --no-git-tag-version > /dev/null
git add package.json package-lock.json
git commit -m "chore: bump version to $NEXT_DEV"
echo "✓ Bumped to $NEXT_DEV"

# Step 3: Push
git push origin HEAD --follow-tags
echo "✓ Pushed to origin"

echo ""
echo "Done! Released v$RELEASE, now on $NEXT_DEV"
