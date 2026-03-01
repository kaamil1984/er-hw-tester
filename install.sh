#!/bin/bash
set -e

NODE_RED_DIR="$HOME/.node-red"

if [ ! -d "$NODE_RED_DIR" ]; then
    echo "Node-RED directory not found: $NODE_RED_DIR"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing er-hw-tester into $NODE_RED_DIR ..."
cd "$NODE_RED_DIR"
npm install "$SCRIPT_DIR"

echo "Done. Restart Node-RED to load the module."
echo "Dashboard will be available at: http://localhost:1880/er-hw-tester/"
