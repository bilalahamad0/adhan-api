#!/bin/bash

# Security Auto-Fixer Script
# This script searches for all package.json files and attempts to run npm audit fix.

# Find all directories containing package.json
directories=$(find . -name "package.json" -not -path "*/node_modules/*" -exec dirname {} \;)

echo "Searching for vulnerabilities in: $directories"

for dir in $directories; do
    echo "-----------------------------------"
    echo "Processing directory: $dir"
    cd "$dir"
    
    # Check if npm exists
    if ! command -v npm &> /dev/null; then
        # Fallback for systems where npm is in /usr/local/bin but not in PATH
        export PATH="/usr/local/bin:$PATH"
    fi
    
    if ! command -v npm &> /dev/null; then
        echo "Error: npm command not found in $dir"
        cd - > /dev/null
        continue
    fi

    echo "Running npm audit fix..."
    npm audit fix

    # Optional: If still some alerts, try forced update (use with caution)
    # npm audit fix --force

    cd - > /dev/null
done

echo "-----------------------------------"
echo "Security fixing complete."
