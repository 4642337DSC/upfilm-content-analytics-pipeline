#!/bin/bash
# Double-click this file (macOS/Linux) to install dependencies (first run
# only) and start the downloader. It opens your browser automatically.
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run only)..."
  npm install
fi

npm start
