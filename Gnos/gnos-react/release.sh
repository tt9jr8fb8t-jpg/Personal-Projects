#!/bin/bash
set -e

# Ask for version
read -p "Version (e.g. 0.1.3): " VERSION

# Ask for changelog
echo "Changelog (press Enter twice when done):"
NOTES=""
while IFS= read -r line; do
  [[ -z "$line" ]] && break
  NOTES="$NOTES$line\n"
done
NOTES="${NOTES%\\n}"

# Bump version in tauri.conf.json
node -e "
  const fs = require('fs');
  const conf = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  conf.version = '$VERSION';
  fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(conf, null, 2) + '\n');
"

echo "✓ Bumped tauri.conf.json to $VERSION"

# Commit and push
git add src-tauri/tauri.conf.json
git commit -m "Bump version to $VERSION"
git push origin main

# Create annotated tag with changelog as message
git tag -a "v$VERSION" -m "$NOTES"
git push origin "v$VERSION"

echo ""
echo "✓ Released v$VERSION — check GitHub Actions for build progress"
