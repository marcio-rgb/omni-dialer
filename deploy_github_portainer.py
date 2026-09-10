#!/usr/bin/env python3
"""
Deploy Automatizado do Dialer para Produção via GitHub Actions e Portainer API.
"""

import sys
import os
import re
import time
import json
import ssl
import subprocess
from pathlib import Path
from typing import Dict, Any, Optional

# Desativa validação estrita de SSL para o Portainer caso use certificado autoassinado
SSL_CONTEXT = ssl.create_default_context()
SSL_CONTEXT.check_hostname = False
SSL_CONTEXT.verify_mode = ssl.CERT_NONE

BASE_DIR = Path(__file__).resolve().parent

def get_git_config() -> Dict[str, str]:
    """Extrai token e dados do repositório a partir do git remote ou env."""
    try:
        remote_url = subprocess.check_output(
            ["git", "remote", "get-url", "origin"],
            stderr=subprocess.DEVNULL,
            text=True
        ).strip()
        match = re.search(r"https://([^@]+)@github\.com/([^/]+)/([^.]+)", remote_url)
        if match:
            return {
                "token": match.group(1),
                "owner": match.group(2),
                "repo": match.group(3)
            }
    except Exception as err:
        print(f"⚠️ Não foi possível extrair config do git remote: {err}")

    # Fallback / Variáveis de Ambiente
    token = os.getenv("GIT_PROD_TOKEN") or os.getenv("GITHUB_TOKEN") or "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"
    return {
        "token": token,
        "owner": os.getenv("GIT_OWNER", "marcio-rgb"),
        "repo": os.getenv("GIT_REPO", "omni-dialer")
    }

def get_portainer_config() -> Dict[str, str]:
    """Busca as configurações do Portainer nos arquivos .env disponíveis."""
    paths_to_check = [
        BASE_DIR.parent / "ecosystem" / ".env",
        BASE_DIR.parent / "ecosystem" / ".ENV",
        BASE_DIR / ".env",
        BASE_DIR.parent / "chat" / ".env"
    ]

    for p in paths_to_check:
        if p.exists():
            content = p.read_text(encoding="utf-8")
            key_match = re.search(r'PORTAINER_KEY_PROD\s*=\s*["\']?([^"\'\r\n]+)', content)
            url_match = re.search(r'PORTAINER_URL_PROD\s*=\s*["\']?([^"\'\r\n]+)', content)
            if key_match and url_match:
                url = url_match.group(1).strip()
                if not url.endswith("/api"):
                    url = f"{url}/api"
                return {
                    "key": key_match.group(1).strip(),
                    "url": url
                }

    # Fallback
    return {
        "key": "ptr_ubSfIbjJaga7zSenoBqm8mTPzWvccL/jIuWo3t9k6bQ=",
        "url": "https://portainer.creditobr.org/api"
    }

def run_command(cmd: str) -> str:
    """Executa um comando de terminal e retorna a saída."""
    return subprocess.check_output(cmd, shell=True, text=True).strip()

def http_request(
    url: str,
    method: str = "GET",
    headers: Optional[Dict[str, str]] = None,
    data: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """Executa requisição HTTP usando urllib da biblioteca padrão do Python."""
    import urllib.request
    import urllib.error

    req_headers = headers or {}
    encoded_data = json.dumps(data).encode("utf-8") if data is not None else None

    req = urllib.request.Request(url, data=encoded_data, headers=req_headers, method=method)
    
    try:
        with urllib.request.urlopen(req, context=SSL_CONTEXT, timeout=30) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8")
        raise RuntimeError(f"HTTP {e.code} ({e.reason}): {err_body}")

def main() -> None:
    print("🚀 === INICIANDO AUTOMATIZAÇÃO DE DEPLOY DO DIALER (PYTHON) ===")

    compose_path = BASE_DIR / "docker-compose.yml"
    if not compose_path.exists():
        print("❌ docker-compose.yml não encontrado no diretório do dialer.")
        sys.exit(1)

    epoch = int(time.time())

    # --- PASSO 1: Atualizar UPDATE_TIMESTAMP no docker-compose.yml ---
    print("\n📝 1. Atualizando UPDATE_TIMESTAMP no docker-compose.yml...")
    try:
        content = compose_path.read_text(encoding="utf-8")
        if "UPDATE_TIMESTAMP=" in content:
            new_content = re.sub(r"UPDATE_TIMESTAMP=\d+", f"UPDATE_TIMESTAMP={epoch}", content)
            compose_path.write_text(new_content, encoding="utf-8")
            print(f"✅ UPDATE_TIMESTAMP atualizado para: {epoch}")
        else:
            print("❌ Linha UPDATE_TIMESTAMP não encontrada no docker-compose.yml")
            sys.exit(1)
    except Exception as err:
        print(f"❌ Falha ao atualizar docker-compose.yml: {err}")
        sys.exit(1)

    # --- PASSO 2: Commit e Push das alterações ---
    print("\n🔄 2. Realizando commit e push para o GitHub...")
    commit_msg = sys.argv[1] if len(sys.argv) > 1 else ""
    if not commit_msg:
        try:
            diff_files = run_command("git diff --name-only").splitlines()
            valid_diffs = [f.strip() for f in diff_files if f.strip() and "docker-compose.yml" not in f]
            if valid_diffs:
                short_files = ", ".join([Path(f).name for f in valid_diffs[:5]])
                commit_msg = f"feat(prod): auto-deploy - updated {short_files}"
            else:
                commit_msg = "chore: trigger production dialer deploy"
        except Exception:
            commit_msg = "chore: trigger production dialer deploy"

    try:
        # Configura identidade se necessário
        try:
            subprocess.run("git config user.email || git config --global user.email 'marcio@fastmob.com.br'", shell=True, check=False)
            subprocess.run("git config user.name || git config --global user.name 'marcio-rgb'", shell=True, check=False)
        except Exception:
            pass

        subprocess.run("git add .", shell=True, check=True)
        status = run_command("git status --porcelain")
        if status:
            escaped_msg = commit_msg.replace('"', '\\"')
            subprocess.run(f'git commit -m "{escaped_msg}"', shell=True, check=True)
        else:
            print("Nenhuma modificação pendente para commit.")

        print("📤 Enviando alterações para o repositório GitHub (main)...")
        subprocess.run("git push origin main --force", shell=True, check=True)
    except Exception as err:
        print(f"❌ Falha ao realizar commit/push das alterações: {err}")
        sys.exit(1)

    commit_sha = run_command("git rev-parse HEAD")
    print(f"📌 Commit SHA atual: {commit_sha}")

    # --- PASSO 3: Monitorar workflow do GitHub Actions ---
    print("\n⏳ 3. Aguardando workflow do GitHub Actions compilar a imagem do dialer...")
    git_config = get_git_config()
    start_time = time.time()
    build_success = False

    while True:
        if time.time() - start_time > 15 * 60:
            print("❌ Timeout de build no GitHub atingido (15 min).")
            sys.exit(1)

        try:
            url = f"https://api.github.com/repos/{git_config['owner']}/{git_config['repo']}/actions/runs"
            headers = {
                "User-Agent": "DeployScript-Python",
                "Authorization": f"Bearer {git_config['token']}"
            }
            res_data = http_request(url, headers=headers)
            runs = res_data.get("workflow_runs", [])
            current_run = next((r for r in runs if r.get("head_sha") == commit_sha), None)

            if current_run:
                status = current_run.get("status")
                conclusion = current_run.get("conclusion") or "Em andamento..."
                print(f"   - Status: {status} | Conclusão: {conclusion}")

                if status == "completed":
                    if current_run.get("conclusion") == "success":
                        build_success = True
                        print("✅ COMPILAÇÃO CONCLUÍDA COM SUCESSO NO GITHUB ACTIONS!")
                        break
                    else:
                        print(f"❌ Falha no build do GitHub. Status final: {current_run.get('conclusion')}")
                        sys.exit(1)
            else:
                print("   - Aguardando início do workflow no GitHub...")
        except Exception as err:
            print(f"⚠️ Erro ao consultar API do GitHub: {err}")

        time.sleep(15)

    # --- PASSO 4: Deploy da Stack no Portainer de Produção ---
    if build_success:
        print("\n🐳 4. Iniciando deploy da Stack no Portainer de produção...")
        p_config = get_portainer_config()
        endpoint_id = 1
        stack_name = "omni-dialer"

        try:
            print("   - Lendo conteúdo do docker-compose.yml atualizado...")
            compose_content = compose_path.read_text(encoding="utf-8")

            # Verifica se a stack já existe no endpoint
            stacks_url = f"{p_config['url']}/stacks"
            headers = {
                "X-API-Key": p_config["key"],
                "Content-Type": "application/json"
            }
            existing_stacks = http_request(stacks_url, headers=headers)
            target_stack = next((s for s in existing_stacks if s.get("Name") == stack_name and s.get("EndpointId") == endpoint_id), None)

            if target_stack:
                stack_id = target_stack["Id"]
                print(f"   - Atualizando stack existente '{stack_name}' (ID: {stack_id})...")
                update_url = f"{p_config['url']}/stacks/{stack_id}?endpointId={endpoint_id}"
                payload = {
                    "StackFileContent": compose_content,
                    "Env": [],
                    "Prune": True,
                    "PullImage": True
                }
                http_request(update_url, method="PUT", headers=headers, data=payload)
                print(f"✅ STACK '{stack_name}' ATUALIZADA COM SUCESSO NO PORTAINER!")
            else:
                print(f"   - Stack '{stack_name}' não existe. Consultando Swarm Cluster ID...")
                info_data = http_request(f"{p_config['url']}/endpoints/{endpoint_id}/docker/info", headers=headers)
                swarm_id = info_data.get("Swarm", {}).get("Cluster", {}).get("ID")
                if not swarm_id:
                    raise RuntimeError("Não foi possível identificar o Swarm Cluster ID no endpoint.")

                print(f"   - Criando nova stack '{stack_name}' no Swarm (Cluster: {swarm_id})...")
                create_url = f"{p_config['url']}/stacks/create/swarm/string?endpointId={endpoint_id}"
                payload = {
                    "name": stack_name,
                    "swarmID": swarm_id,
                    "stackFileContent": compose_content,
                    "env": []
                }
                res = http_request(create_url, method="POST", headers=headers, data=payload)
                print(f"✅ STACK '{stack_name}' CRIADA E IMPLANTADA COM SUCESSO NO PORTAINER!")
                print(f"   Detalhes: ID {res.get('Id')}")

            print("🎉 PROCESSO DE DEPLOY COMPLETO CONCLUÍDO!")
        except Exception as err:
            print(f"❌ Falha no deploy da Stack no Portainer: {err}")
            sys.exit(1)

if __name__ == "__main__":
    main()
