import os
import shutil
import re
from typing import List, Dict, Any, Optional
from config import settings

class AsteriskConfService:
    def __init__(self, conf_dir: Optional[str] = None):
        self.conf_dir = conf_dir or settings.ASTERISK_CONF_DIR

    def _get_trunks_file_path(self) -> str:
        # Check vitalpbx subfolder or standard /etc/asterisk
        vitalpbx_path = os.path.join(self.conf_dir, "vitalpbx", "pjsip__50-99-vivo.conf")
        if os.path.exists(os.path.dirname(vitalpbx_path)):
            return vitalpbx_path
        return os.path.join(self.conf_dir, "pjsip_trunks_vivo.conf")

    def _get_amd_file_path(self) -> str:
        return os.path.join(self.conf_dir, "amd.conf")

    def _backup_file(self, file_path: str):
        if os.path.exists(file_path):
            backup_path = f"{file_path}.bak"
            shutil.copy2(file_path, backup_path)

    def generate_pjsip_trunks_conf(
        self,
        start_line: int,
        end_line: int,
        password: str = "1020304050",
        proxy: str = "187.50.251.58:5060",
        realm: str = "metapabx.vivo.net.br",
        expiration: int = 3600,
        codecs: str = "alaw,ulaw",
        context: str = "cos-all"
    ) -> str:
        """
        Gera a configuracao PJSIP dos troncos Vivo com padrao oficial RFC 3261
        """
        proxy_ip = proxy.split(":")[0]
        lines = []
        lines.append("; ====================================================================")
        lines.append("; ARQUIVO GERADO AUTOMATICAMENTE PELA OMNICHAT PBX API (FASTAPI)")
        lines.append(f"; Faixa de Troncos: {start_line} a {end_line} (Total: {end_line - start_line + 1} linhas)")
        lines.append("; ====================================================================\n")

        for line_num in range(start_line, end_line + 1):
            line_str = str(line_num)
            lines.append(f"; ------------------ Linha {line_str} ------------------")
            lines.append(f"[{line_str}-reg]")
            lines.append("type = registration")
            lines.append(f"server_uri = sip:{realm}")
            lines.append(f"client_uri = sip:{line_str}@{realm}")
            lines.append(f"outbound_proxy = sip:{proxy}\\;lr")
            lines.append(f"outbound_auth = {line_str}-auth")
            lines.append(f"contact_user = {line_str}")
            lines.append(f"endpoint = {line_str}")
            lines.append("line = yes")
            lines.append(f"expiration = {expiration}")
            lines.append("auth_rejection_permanent = no")
            lines.append("retry_interval = 30")
            lines.append("forbidden_retry_interval = 60\n")

            lines.append(f"[{line_str}-auth]")
            lines.append("type = auth")
            lines.append("auth_type = userpass")
            lines.append(f"username = {line_str}")
            lines.append(f"password = {password}")
            lines.append(f"realm = {realm}\n")

            lines.append(f"[{line_str}-aor]")
            lines.append("type = aor")
            lines.append(f"contact = sip:{line_str}@{proxy}\n")

            lines.append(f"[{line_str}]")
            lines.append("type = endpoint")
            lines.append(f"context = {context}")
            lines.append("disallow = all")
            lines.append(f"allow = {codecs}")
            lines.append(f"aors = {line_str}-aor")
            lines.append(f"outbound_auth = {line_str}-auth")
            lines.append(f"outbound_proxy = sip:{proxy}\\;lr")
            lines.append(f"from_user = {line_str}")
            lines.append(f"from_domain = {realm}")
            lines.append("direct_media = no")
            lines.append("rewrite_contact = yes")
            lines.append("rtp_symmetric = yes")
            lines.append("force_rport = yes\n")

            lines.append(f"[{line_str}-identify]")
            lines.append("type = identify")
            lines.append(f"endpoint = {line_str}")
            lines.append(f"match = {proxy_ip}\n")

        content = "\n".join(lines)
        file_path = self._get_trunks_file_path()
        os.makedirs(os.path.dirname(file_path), exist_ok=True)
        self._backup_file(file_path)
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content)

        return file_path

    def get_configured_trunks(self) -> List[str]:
        file_path = self._get_trunks_file_path()
        if not os.path.exists(file_path):
            return []
        
        trunks = []
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
            matches = re.findall(r'\[(\d+)-reg\]', content)
            trunks = sorted(list(set(matches)))
        return trunks

    def read_amd_config(self) -> Dict[str, Any]:
        file_path = self._get_amd_file_path()
        defaults = {
            "initial_silence": 2500,
            "greeting": 1500,
            "after_greeting_silence": 800,
            "total_analysis_time": 3000,
            "min_word_length": 100,
            "between_words_silence": 50,
            "maximum_number_of_words": 3,
            "silence_threshold": 256
        }
        if not os.path.exists(file_path):
            return defaults

        config = defaults.copy()
        with open(file_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith(";") or line.startswith("#") or not line:
                    continue
                if "=" in line:
                    k, v = line.split("=", 1)
                    k = k.strip()
                    v = v.split(";")[0].strip()
                    if k in config and v.isdigit():
                        config[k] = int(v)
        return config

    def write_amd_config(self, params: Dict[str, Any]) -> str:
        file_path = self._get_amd_file_path()
        self._backup_file(file_path)
        
        lines = [
            "; ====================================================================",
            "; CONFIGURACAO AMD INTERNO DO ASTERISK (app_amd.so)",
            "; Gerado via OmniChat PBX API (FastAPI)",
            "; ====================================================================",
            "[general]",
            f"initial_silence = {params.get('initial_silence', 2500)}",
            f"greeting = {params.get('greeting', 1500)}",
            f"after_greeting_silence = {params.get('after_greeting_silence', 800)}",
            f"total_analysis_time = {params.get('total_analysis_time', 3000)}",
            f"min_word_length = {params.get('min_word_length', 100)}",
            f"between_words_silence = {params.get('between_words_silence', 50)}",
            f"maximum_number_of_words = {params.get('maximum_number_of_words', 3)}",
            f"silence_threshold = {params.get('silence_threshold', 256)}",
            ""
        ]
        with open(file_path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
        return file_path

    def generate_livekit_sip_conf(self, livekit_sip_host: str = "livekit-sip:5060") -> str:
        """
        Gera a configuracao PJSIP para comunicacao com o LiveKit SIP Gateway
        """
        host_ip = livekit_sip_host.split(":")[0]
        file_path = os.path.join(self.conf_dir, "pjsip_livekit.conf")
        lines = [
            "; ====================================================================",
            "; TRONCO PJSIP LIVEKIT SIP GATEWAY",
            "; ====================================================================",
            "[livekit-sip]",
            "type = endpoint",
            "context = cos-all",
            "disallow = all",
            "allow = opus,ulaw,alaw",
            "aors = livekit-sip-aor",
            "direct_media = no",
            "rtp_symmetric = yes",
            "force_rport = yes",
            "rewrite_contact = yes\n",
            "[livekit-sip-aor]",
            "type = aor",
            f"contact = sip:{livekit_sip_host}\n",
            "[livekit-sip-identify]",
            "type = identify",
            "endpoint = livekit-sip",
            f"match = {host_ip}\n"
        ]
        os.makedirs(os.path.dirname(file_path), exist_ok=True)
        self._backup_file(file_path)
        with open(file_path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
        return file_path

asterisk_conf_service = AsteriskConfService()

