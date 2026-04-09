#!/bin/bash
set -e

echo "🚀 Running Pre-Release Smoke Test..."
npm run test:smoke

if [ $? -ne 0 ]; then
  echo "❌ Smoke Test Failed. Build Aborted."
  exit 1
fi

echo "🚀 Building Production Release Artifact..."

BUILD_DIR="dist"
TAR_NAME="adhan-api-production.tar.gz"

# 1. Clean previous build
rm -rf "$BUILD_DIR"
rm -f "$TAR_NAME"
mkdir -p "$BUILD_DIR"

# 2. Copy source files (excluding tests, coverage, .git, and dev configs)
echo "📦 Copying files to build directory..."
rsync -a --exclude='.git' \
         --exclude='node_modules' \
         --exclude='coverage' \
         --exclude='*.test.js' \
         --exclude='__tests__' \
         --exclude='tests' \
         --exclude='jest.config.js' \
         --exclude='.prettierrc' \
         --exclude='.prettierignore' \
         --exclude='eslint.config.js' \
         --exclude='archive' \
         ./ "$BUILD_DIR/"

echo "🧹 Stripping development tests and assets verified."

# 3. Zip into artifact
echo "🗜️ Compressing production build into $TAR_NAME..."
cd "$BUILD_DIR"
tar -czf "../$TAR_NAME" .
cd ..

# 4. Cleanup temp directory
rm -rf "$BUILD_DIR"

echo "✅ Build Complete! Ready for Raspberry Pi deployment:"
echo "   --> Artifact: $TAR_NAME"
echo ""
echo "To deploy to Pi, run:"
echo "   scp $TAR_NAME <pi-user>@<pi-ip>:~/"
echo "   ssh <pi-user>@<pi-ip> 'mkdir -p ~/adhan-api && tar -xzf ~/adhan-api-production.tar.gz -C ~/adhan-api && cd ~/adhan-api/audio-caster && npm install --omit=dev'"
