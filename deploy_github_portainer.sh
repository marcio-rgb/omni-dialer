#!/bin/bash
# ========================================================
#       PUBLISHING OMNI-DIALER TO GITHUB & PORTAINER
# ========================================================

# Check if node is installed
if ! command -v node &> /dev/null; then
    echo "Node.js is not installed. Please install it to run this script."
    exit 1
fi

# Run the node automation script, forwarding any arguments (like custom commit messages)
node deploy_github_portainer.js "$@"
