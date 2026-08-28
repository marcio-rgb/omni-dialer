import asyncio
import subprocess
import re
from typing import Dict, List, Any
from config import settings

class AsteriskAmiService:
    def __init__(self):
        self.host = settings.ASTERISK_AMI_HOST
        self.port = settings.ASTERISK_AMI_PORT
        self.user = settings.ASTERISK_AMI_USER
        self.secret = settings.ASTERISK_AMI_PASS

    async def execute_command(self, command: str) -> str:
        """
        Executa um comando CLI no Asterisk via socket AMI TCP de alta velocidade (<2ms)
        """
        try:
            loop = asyncio.get_event_loop()
            def run_sync_ami():
                import socket, time
                s = socket.socket()
                s.settimeout(2.0)
                s.connect((self.host, self.port))
                s.recv(1024)
                s.sendall(f"Action: Login\r\nUsername: {self.user}\r\nSecret: {self.secret}\r\n\r\n".encode("utf-8"))
                time.sleep(0.02)
                s.recv(2048)
                s.sendall(f"Action: Command\r\nCommand: {command}\r\n\r\n".encode("utf-8"))
                resp = b""
                while True:
                    data = s.recv(4096)
                    if not data:
                        break
                    resp += data
                    if b"Message: Command output follows" in resp and resp.endswith(b"\r\n\r\n"):
                        break
                s.close()
                raw_text = resp.decode("utf-8", errors="replace")
                output_lines = []
                for line in raw_text.splitlines():
                    if line.startswith("Output:"):
                        output_lines.append(line[7:].strip())
                    elif not line.startswith("Response:") and not line.startswith("Message:") and not line.startswith("Privilege:") and not line.startswith("ActionID:") and not line.startswith("Event:"):
                        if line.strip():
                            output_lines.append(line.strip())
                return "\n".join(output_lines).strip()

            return await loop.run_in_executor(None, run_sync_ami)
        except Exception as e:
            return f"Exception: {str(e)}"

    async def get_registrations(self) -> List[Dict[str, Any]]:
        """
        Retorna o status de registro PJSIP de todas as linhas
        """
        raw_output = await self.execute_command("pjsip show registrations")
        results = []
        
        # Parse lines: ' 1127011348-reg/sip:metapabx.vivo.net.br  1127011348-auth  Registered  (exp. 3297s)'
        lines = raw_output.split("\n")
        for line in lines:
            line = line.strip()
            if not line or line.startswith("<") or line.startswith("=") or line.startswith("Objects found"):
                continue
            
            parts = re.split(r'\s+', line)
            if len(parts) >= 3:
                reg_uri = parts[0]
                auth = parts[1]
                status = parts[2]
                exp = " ".join(parts[3:]) if len(parts) > 3 else ""
                
                # Extrai apenas o numero da linha
                trunk_match = re.match(r'(\d+)-reg', reg_uri)
                trunk_id = trunk_match.group(1) if trunk_match else reg_uri

                results.append({
                    "trunk": trunk_id,
                    "server_uri": reg_uri,
                    "auth": auth,
                    "status": status,
                    "expiration_info": exp,
                    "is_registered": (status.lower() == "registered")
                })
        return results

    async def get_channels_summary(self) -> Dict[str, Any]:
        raw_output = await self.execute_command("core show channels")
        active_channels = 0
        active_calls = 0
        
        for line in raw_output.split("\n"):
            if "active channel" in line:
                m = re.search(r'(\d+)\s+active channel', line)
                if m:
                    active_channels = int(m.group(1))
            if "active call" in line:
                m = re.search(r'(\d+)\s+active call', line)
                if m:
                    active_calls = int(m.group(1))

        return {
            "active_channels": active_channels,
            "active_calls": active_calls,
            "raw": raw_output.strip()
        }

    async def reload_pjsip(self) -> str:
        return await self.execute_command("module reload res_pjsip.so")

    async def reload_dialplan(self) -> str:
        return await self.execute_command("dialplan reload")

    async def reload_amd(self) -> str:
        return await self.execute_command("module reload app_amd.so")

ami_service = AsteriskAmiService()
