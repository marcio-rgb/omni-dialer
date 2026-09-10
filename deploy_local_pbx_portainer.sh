#!/bin/bash
# ========================================================
#       LOCAL PBX PORTAINER DEPLOY (PYTHON)
# ========================================================

set -e

# Verifica se python3 está instalado
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 não está instalado. Por favor, instale o Python 3 para executar este script."
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Executa a automação em Python
python3 "$SCRIPT_DIR/deploy_local_pbx_portainer.py" "$@"
