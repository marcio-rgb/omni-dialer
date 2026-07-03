#!/bin/bash
# ========================================================
#       PUBLISHING OMNI-DIALER TO GITHUB (Linux)
# ========================================================

# Ensure git user identity is configured locally
if ! git config user.email > /dev/null 2>&1; then
    echo "Setting local git user.email..."
    git config user.email "marcio@fastmob.com.br"
fi
if ! git config user.name > /dev/null 2>&1; then
    echo "Setting local git user.name..."
    git config user.name "marcio-rgb"
fi

echo ""
echo "Adding all changes..."
git add .

echo ""
echo "Committing changes..."
read -p "Enter commit message (default: 'chore: update production dialer'): " commit_msg
if [ -z "$commit_msg" ]; then
    commit_msg="chore: update production dialer"
fi
git commit -m "$commit_msg"

echo ""
echo "Pushing to main branch..."
git push origin main --force

echo ""
echo "========================================================"
echo "       PUBLISH COMPLETE!"
echo "========================================================"
