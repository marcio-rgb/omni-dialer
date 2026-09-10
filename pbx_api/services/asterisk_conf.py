import os
import shutil
from typing import List, Dict, Any, Optional
from config import settings

class AsteriskConfService:
    def __init__(self, conf_dir: Optional[str] = None):
        self.conf_dir = conf_dir or settings.ASTERISK_CONF_DIR

    def _get_trunks_file_path(self) -> str:
        return os.path.join(self.conf_dir, "pjsip_trunks_vivo.conf")

    def _get_livekit_file_path(self) -> str:
        return os.path.join(self.conf_dir, "pjsip_livekit.conf")

    def _get_amd_file_path(self) -> str:
        return os.path.join(self.conf_dir, "amd.conf")

    def _backup_file(self, file_path: str):
        if os.path.exists(file_path):
            backup_path = f"{file_path}.bak"
            try:
                shutil.copy2(file_path, backup_path)
            except Exception as e:
                print(f"[AsteriskConfService] Erro ao criar backup de {file_path}: {e}")

    def compile_livekit_conf(self, return_trunk: Optional[Dict[str, Any]] = None) -> str:
        """
        Compila a configuração do tronco de retorno LiveKit SIP (pjsip_livekit.conf).
        """
        host = "192.168.0.13"
        port = 5060
        codecs = "opus,ulaw,alaw"
        context = "cos-all"
        name = "livekit-sip"

        if return_trunk:
            host = return_trunk.get("host") or host
            port = int(return_trunk.get("port") or port)
            codecs = return_trunk.get("codecs") or codecs
            context = return_trunk.get("context") or context
            name = return_trunk.get("trunk_name") or name

        lines = [
            "; ====================================================================",
            "; TRONCO DE RETORNO LIVEKIT SIP GATEWAY",
            "; Gerado automaticamente pela OmniChat PBX API",
            "; ====================================================================",
            "",
            f"[{name}]",
            "type = endpoint",
            f"context = {context}",
            "disallow = all",
            f"allow = {codecs}",
            f"aors = {name}-aor",
            "direct_media = no",
            "rtp_symmetric = yes",
            "force_rport = yes",
            "rewrite_contact = yes",
            "",
            f"[{name}-aor]",
            "type = aor",
            f"contact = sip:{host}:{port}",
            "",
            f"[{name}-identify]",
            "type = identify",
            f"endpoint = {name}",
            f"match = {host}",
            ""
        ]

        file_path = self._get_livekit_file_path()
        os.makedirs(os.path.dirname(file_path), exist_ok=True)
        self._backup_file(file_path)
        with open(file_path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))

        return file_path

    def compile_main_pjsip_conf(self) -> str:
        """
        Gera o pjsip.conf principal com o transporte UDP e configurações globais.
        """
        lines = [
            "; ====================================================================",
            "; CONFIGURACAO GLOBAL E TRANSPORTE PJSIP ASTERISK",
            "; Gerado automaticamente pela OmniChat PBX API",
            "; ====================================================================",
            "[global]",
            "type = global",
            "user_agent = Grandstream GRP2602W 1.0.5.55",
            "",
            "[transport-udp]",
            "type = transport",
            "protocol = udp",
            "bind = 0.0.0.0:5060",
            "",
            "#include /etc/asterisk/pjsip_trunks_vivo.conf",
            "#include /etc/asterisk/pjsip_livekit.conf",
            ""
        ]
        file_path = os.path.join(self.conf_dir, "pjsip.conf")
        self._backup_file(file_path)
        with open(file_path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
        return file_path

    def compile_pjsip_conf(self, trunks: List[Dict[str, Any]]) -> str:
        """
        Compila todos os troncos ativos para o formato nativo Asterisk PJSIP (RFC 3261).
        Apenas troncos com enabled = True e is_return_trunk = False são adicionados.
        O tronco com is_return_trunk = True é compilado no pjsip_livekit.conf.
        """
        self.compile_main_pjsip_conf()

        # Identifica tronco de retorno LiveKit
        return_trunks = [t for t in trunks if t.get("is_return_trunk")]
        if return_trunks:
            self.compile_livekit_conf(return_trunks[0])
        else:
            self.compile_livekit_conf(None)

        # Filtra apenas troncos de operadora que estejam habilitados
        active_trunks = [t for t in trunks if t.get("enabled", True) and not t.get("is_return_trunk")]

        lines = [
            "; ====================================================================",
            "; ARQUIVO DE TRONCOS PJSIP GERADO AUTOMATICAMENTE PELA OMNICHAT PBX API",
            f"; Total de Troncos Habilitados no Asterisk: {len(active_trunks)}",
            "; ====================================================================\n"
        ]

        for t in active_trunks:
            name = str(t.get("trunk_name") or t.get("id"))
            trunk_type = t.get("trunk_type", "registration")
            host = t.get("host", "127.0.0.1")
            port = t.get("port", 5060)
            server_uri = f"sip:{host}:{port}" if port != 5060 else f"sip:{host}"
            realm = t.get("realm") or host
            username = str(t.get("username") or name)
            password = str(t.get("password") or "")
            auth_user = str(t.get("auth_user") or username)
            from_user = str(t.get("from_user") or username)
            from_domain = str(t.get("from_domain") or realm)
            context = t.get("context", "cos-all")
            codecs = t.get("codecs", "alaw,ulaw,g729")
            dtmf_mode = t.get("dtmf_mode", "rfc4733")
            expiration = t.get("expiration", 3600)
            qualify_freq = t.get("qualify_frequency", 60)
            outbound_proxy = t.get("outbound_proxy")
            proxy_str = f"sip:{outbound_proxy}\\;lr" if outbound_proxy else ""
            match_ips = t.get("match_ips") or (outbound_proxy.split(":")[0] if outbound_proxy else host.split(":")[0])
            use_line = "yes" if t.get("line", True) else "no"

            lines.append(f"; ------------------ Tronco: {name} ({str(t.get('provider', 'SIP')).upper()}) ------------------")

            # 1. Registration Block
            if trunk_type == "registration" and password:
                lines.append(f"[{name}-reg]")
                lines.append("type = registration")
                lines.append(f"server_uri = sip:{realm}")
                lines.append(f"client_uri = sip:{username}@{realm}")
                if proxy_str:
                    lines.append(f"outbound_proxy = {proxy_str}")
                lines.append(f"outbound_auth = {name}-auth")
                lines.append(f"contact_user = {username}")
                lines.append(f"endpoint = {name}")
                lines.append(f"line = {use_line}")
                lines.append(f"expiration = {expiration}")
                lines.append("auth_rejection_permanent = no")
                lines.append("retry_interval = 30")
                lines.append("forbidden_retry_interval = 60\n")

            # 2. Auth Block
            if password:
                lines.append(f"[{name}-auth]")
                lines.append("type = auth")
                lines.append("auth_type = userpass")
                lines.append(f"username = {auth_user}")
                lines.append(f"password = {password}")
                lines.append(f"realm = {realm}\n")

            # 3. AoR Block
            lines.append(f"[{name}-aor]")
            lines.append("type = aor")
            if outbound_proxy:
                lines.append(f"contact = sip:{username}@{outbound_proxy}")
            else:
                lines.append(f"contact = {server_uri}")
            lines.append(f"qualify_frequency = {qualify_freq}")
            lines.append("max_contacts = 10\n")

            # 4. Endpoint Block
            max_ch = t.get("max_channels", 1)
            lines.append(f"[{name}]")
            lines.append("type = endpoint")
            lines.append(f"context = {context}")
            lines.append("disallow = all")
            lines.append(f"allow = {codecs}")
            lines.append(f"aors = {name}-aor")
            if password:
                lines.append(f"outbound_auth = {name}-auth")
            if proxy_str:
                lines.append(f"outbound_proxy = {proxy_str}")
            lines.append(f"from_user = {from_user}")
            lines.append(f"from_domain = {from_domain}")
            if t.get("user_agent"):
                lines.append(f"user_agent = {t.get('user_agent')}")
            lines.append(f"dtmf_mode = {dtmf_mode}")
            lines.append(f"direct_media = {'yes' if t.get('direct_media') else 'no'}")
            lines.append(f"rewrite_contact = {'yes' if t.get('rewrite_contact', True) else 'no'}")
            lines.append(f"rtp_symmetric = {'yes' if t.get('rtp_symmetric', True) else 'no'}")
            lines.append(f"force_rport = {'yes' if t.get('force_rport', True) else 'no'}")
            lines.append(f"callerid = {from_user} <{from_user}>")
            lines.append("send_pai = yes")
            lines.append("send_rpid = yes")
            lines.append("trust_id_outbound = yes")
            lines.append("trust_id_inbound = yes")
            lines.append(f"set_var = CALLERID(all)={from_user} <{from_user}>")
            lines.append("")

            # 5. Identify Block
            if match_ips:
                lines.append(f"[{name}-identify]")
                lines.append("type = identify")
                lines.append(f"endpoint = {name}")
                lines.append(f"match = {match_ips}\n")

        content = "\n".join(lines)
        file_path = self._get_trunks_file_path()
        os.makedirs(os.path.dirname(file_path), exist_ok=True)
        self._backup_file(file_path)
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content)

        return file_path

    def compile_amd_conf(self, params: Dict[str, Any]) -> str:
        """
        Compila o arquivo amd.conf com os parâmetros de análise acústica do Asterisk.
        """
        file_path = self._get_amd_file_path()
        self._backup_file(file_path)
        lines = [
            "; ====================================================================",
            "; CONFIGURACAO AMD INTERNO DO ASTERISK (app_amd.so)",
            "; Gerado via OmniChat PBX API (FastAPI)",
            "; ====================================================================",
            "[general]",
            f"initial_silence = {params.get('amd_initial_silence', 2500)}",
            f"greeting = {params.get('amd_greeting', 1500)}",
            f"after_greeting_silence = {params.get('amd_after_greeting_silence', 800)}",
            f"total_analysis_time = {params.get('amd_total_analysis_time', 3000)}",
            f"min_word_length = {params.get('amd_min_word_length', 100)}",
            f"between_words_silence = {params.get('amd_between_words_silence', 50)}",
            f"maximum_number_of_words = {params.get('amd_maximum_number_of_words', 3)}",
            f"silence_threshold = {params.get('amd_silence_threshold', 256)}",
            ""
        ]
        with open(file_path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
        return file_path

asterisk_conf_service = AsteriskConfService()
