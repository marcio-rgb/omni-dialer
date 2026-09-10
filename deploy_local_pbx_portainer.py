#!/usr/bin/env python3
"""
Deploy Nativo do PBX Edge no Portainer Local configurado em ecosystem/.ENV_local.
"""

import sys
import os
import re
import json
import ssl
import base64
from pathlib import Path
from typing import Dict, Any, List, Optional

# Desativa validação estrita de SSL para o Portainer caso use certificado autoassinado
SSL_CONTEXT = ssl.create_default_context()
SSL_CONTEXT.check_hostname = False
SSL_CONTEXT.verify_mode = ssl.CERT_NONE

BASE_DIR = Path(__file__).resolve().parent

def get_local_portainer_config() -> Dict[str, Any]:
    """Busca as configurações do Portainer Local priorizando ecosystem/.ENV_local."""
    paths_to_check = [
        BASE_DIR.parent / "ecosystem" / ".ENV_local",
        BASE_DIR.parent / "ecosystem" / ".env",
        BASE_DIR.parent / "ecosystem" / ".ENV",
        BASE_DIR / ".env"
    ]

    key = "ptr_GTLcaXGkFMqnNIxtboTZ3yLruOpqRJdgO/1gJQCq4ts="
    url = "http://localhost:9000/api"
    endpoint_id: int = 3
    github_token = "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"

    for p in paths_to_check:
        if p.exists():
            content = p.read_text(encoding="utf-8")
            key_match = re.search(r'(?:PORTAINER_LOCAL_KEY|PORTAINER_KEY)\s*=\s*["\']?([^"\'\r\n]+)', content)
            url_match = re.search(r'(?:PORTAINER_LOCAL_URL|PORTAINER_URL)\s*=\s*["\']?([^"\'\r\n]+)', content)
            ep_match = re.search(r'PORTAINER_LOCAL_ENDPOINT_ID\s*=\s*["\']?(\d+)', content)
            git_match = re.search(r'(?:GITHUB_TOKEN|GIT_PROD_TOKEN)\s*=\s*["\']?([^"\'\r\n]+)', content)

            if key_match:
                key = key_match.group(1).strip()
            if url_match:
                u = url_match.group(1).strip()
                url = u if u.endswith("/api") else f"{u}/api"
            if ep_match:
                endpoint_id = int(ep_match.group(1).strip())
            if git_match:
                github_token = git_match.group(1).strip()
            
            # Se encontrou no .ENV_local prioritário, encerra a busca
            if p.name == ".ENV_local" and (key_match or url_match):
                break

    return {
        "key": key,
        "url": url,
        "endpoint_id": endpoint_id,
        "github_token": github_token
    }

def http_request(
    url: str,
    method: str = "GET",
    headers: Optional[Dict[str, str]] = None,
    data: Optional[Dict[str, Any]] = None
) -> Any:
    """Executa requisição HTTP usando urllib da biblioteca padrão do Python."""
    import urllib.request
    import urllib.error

    req_headers = headers or {}
    encoded_data = json.dumps(data).encode("utf-8") if data is not None else None

    req = urllib.request.Request(url, data=encoded_data, headers=req_headers, method=method)
    
    try:
        with urllib.request.urlopen(req, context=SSL_CONTEXT, timeout=60) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8")
        raise RuntimeError(f"HTTP {e.code} ({e.reason}): {err_body}")

def ensure_github_registry(config: Dict[str, Any]) -> None:
    """Garante que o registry ghcr.io está cadastrado no Portainer."""
    try:
        registries = http_request(
            f"{config['url']}/registries",
            headers={"X-API-Key": config["key"]}
        )
        has_ghcr = any(r.get("URL") == "ghcr.io" for r in registries) if isinstance(registries, list) else False
        if not has_ghcr:
            print("   - Cadastrando registry ghcr.io no Portainer...")
            payload = {
                "Name": "GitHub Packages (ghcr.io)",
                "Type": 3,
                "URL": "ghcr.io",
                "Authentication": True,
                "Username": "marcio-rgb",
                "Password": config["github_token"]
            }
            http_request(
                f"{config['url']}/registries",
                method="POST",
                headers={
                    "X-API-Key": config["key"],
                    "Content-Type": "application/json"
                },
                data=payload
            )
            print("   ✓ Registry ghcr.io cadastrado com sucesso no Portainer.")
    except Exception as e:
        print(f"   ⚠️ Aviso ao verificar registry ghcr.io: {e}")

def main() -> None:
    print("🚀 === DEPLOY DO PBX EDGE NO PORTAINER LOCAL (.ENV_local) ===")

    config = get_local_portainer_config()
    print(f"📌 Servidor Portainer Local: {config['url']}")
    print(f"🔑 Chave Portainer: {config['key'][:12]}...")

    compose_path = BASE_DIR / "docker-compose.pbx.yml"
    if not compose_path.exists():
        print("❌ Arquivo docker-compose.pbx.yml não encontrado!")
        sys.exit(1)

    compose_content = compose_path.read_text(encoding="utf-8")
    stack_name = "omnichat-pbx"

    try:
        # 1. Garantir registro do ghcr.io no Portainer
        ensure_github_registry(config)

        # 2. Consultar Endpoints
        print(f"\n🔍 1. Consultando Endpoints no Portainer ({config['url']})...")
        endpoint_id = config.get("endpoint_id")
        
        try:
            endpoints_data = http_request(
                f"{config['url']}/endpoints",
                headers={"X-API-Key": config["key"]}
            )
            if isinstance(endpoints_data, list) and endpoints_data:
                matching_ep = next((e for e in endpoints_data if e.get("Id") == endpoint_id), None)
                if matching_ep:
                    print(f"   ✓ Endpoint configurado confirmado: {matching_ep.get('Name')} (ID: {endpoint_id})")
                else:
                    local_endpoint = next(
                        (e for e in endpoints_data if e.get("Name") == "local" or e.get("Type") == 1),
                        endpoints_data[0]
                    )
                    endpoint_id = local_endpoint.get("Id")
                    print(f"   ✓ Endpoint selecionado dinamicamente: {local_endpoint.get('Name')} (ID: {endpoint_id})")
        except Exception as ep_err:
            print(f"   ⚠️ Aviso ao listar endpoints ({ep_err}). Utilizando Endpoint ID fixo: {endpoint_id}")

        # 3. Verificar se Stack existe
        print(f'\n📦 2. Verificando Stack "{stack_name}"...')
        stacks_data = http_request(
            f"{config['url']}/stacks",
            headers={"X-API-Key": config["key"]}
        )
        existing_stack = next(
            (s for s in stacks_data if s.get("Name") == stack_name),
            None
        )

        auth_obj = {
            "username": "marcio-rgb",
            "password": config["github_token"],
            "serveraddress": "ghcr.io"
        }
        auth_header = base64.b64encode(json.dumps(auth_obj).encode("utf-8")).decode("utf-8")

        if existing_stack:
            stack_id = existing_stack.get("Id")
            print(f"   - Atualizando Stack existente ID {stack_id} (Endpoint {endpoint_id})...")
            update_url = f"{config['url']}/stacks/{stack_id}?endpointId={endpoint_id}"
            headers = {
                "X-API-Key": config["key"],
                "Content-Type": "application/json",
                "X-Registry-Auth": auth_header
            }
            payload = {
                "stackFileContent": compose_content,
                "env": [],
                "prune": True,
                "pullImage": True
            }
            http_request(update_url, method="PUT", headers=headers, data=payload)
            print("✅ STACK DO PBX ATUALIZADA COM SUCESSO NO PORTAINER!")
        else:
            print(f'   - Criando nova Stack gerenciada "{stack_name}" (Endpoint {endpoint_id})...')
            create_url = f"{config['url']}/stacks/create/standalone/string?endpointId={endpoint_id}"
            headers = {
                "X-API-Key": config["key"],
                "Content-Type": "application/json",
                "X-Registry-Auth": auth_header
            }
            payload = {
                "name": stack_name,
                "stackFileContent": compose_content,
                "env": []
            }
            created = http_request(create_url, method="POST", headers=headers, data=payload)
            print(f"✅ STACK DO PBX CRIADA COM SUCESSO! (ID: {created.get('Id')})")

        print("\n🎉 Deploy concluído! A stack agora é 100% gerenciada pelo Portainer Local.")
    except Exception as err:
        print(f"❌ Erro durante o deploy no Portainer: {err}")
        sys.exit(1)

if __name__ == "__main__":
    main()
