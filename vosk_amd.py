#!/usr/bin/env python3
"""
OmniChat Vosk AMD - Asterisk EAGI Script
Lê o áudio PCM 16-bit 8kHz do File Descriptor 3 (EAGI) e transmite via WebSocket
para o servidor Vosk STT (porta 2700), detectando Atendimento Humano vs. Caixa Postal.
"""

import sys
import os
import json
import time
import asyncio
import websockets

VOSK_WS_URL = os.environ.get("VOSK_SERVER_URL", "ws://127.0.0.1:2700")
MAX_DURATION_SEC = float(os.environ.get("VOSK_MAX_DURATION_SEC", "3.5"))
VOICEMAIL_KEYWORDS = [
    "caixa", "mensagem", "recado", "sinal", "indisponivel", "ausente",
    "gravando", "bip", "secretaria", "operadora", "impossibilitado",
    "nao pode", "momento", "encaminhada", "horario de atendimento", "vivo", "claro", "tim"
]
HUMAN_KEYWORDS = ["alo", "ola", "oi", "pois nao", "quem fala", "bom dia", "boa tarde", "boa noite", "fala", "quem e"]

def agi_send(cmd: str):
    sys.stdout.write(f"{cmd}\n")
    sys.stdout.flush()

def read_agi_env():
    env = {}
    while True:
        line = sys.stdin.readline().strip()
        if not line:
            break
        if ":" in line:
            k, v = line.split(":", 1)
            env[k.strip()] = v.strip()
    return env

async def process_eagi_audio():
    # File descriptor 3 no Asterisk EAGI contém o fluxo PCM puro 16-bit 8kHz
    try:
        audio_fd = os.fdopen(3, "rb", buffering=0)
    except Exception as e:
        agi_send('VERBOSE "Erro ao abrir EAGI audio FD 3" 1')
        agi_send('SET VARIABLE VOSK_AMD_STATUS "HUMAN"')
        return

    transcribed_text = ""
    status = "HUMAN"
    start_time = time.time()

    try:
        async with websockets.connect(VOSK_WS_URL, open_timeout=2.0) as ws:
            # Envia configuração inicial para taxa de amostragem 8000 Hz
            await ws.send('{"config" : { "sample_rate" : 8000 }}')

            while time.time() - start_time < MAX_DURATION_SEC:
                # Lê chunk de 1600 bytes (100ms de áudio a 8kHz 16-bit mono)
                chunk = audio_fd.read(1600)
                if not chunk:
                    break

                await ws.send(chunk)
                
                # Tenta ler respostas parciais
                try:
                    res_msg = await asyncio.wait_for(ws.recv(), timeout=0.05)
                    data = json.loads(res_msg)
                    text = (data.get("text") or data.get("partial") or "").lower()
                    if text:
                        transcribed_text = text

                        # Checa se contém palavras-chave de caixa postal
                        for kw in VOICEMAIL_KEYWORDS:
                            if kw in text:
                                status = "MACHINE"
                                break

                        if status == "MACHINE":
                            break
                except asyncio.TimeoutError:
                    pass

            # Solicita resultado final
            if status != "MACHINE":
                await ws.send('{"eof" : 1}')
                try:
                    final_res = await asyncio.wait_for(ws.recv(), timeout=0.5)
                    final_data = json.loads(final_res)
                    final_text = (final_data.get("text") or "").lower()
                    if final_text:
                        transcribed_text = final_text
                        for kw in VOICEMAIL_KEYWORDS:
                            if kw in final_text:
                                status = "MACHINE"
                                break
                except Exception:
                    pass

    except Exception as err:
        agi_send(f'VERBOSE "Erro de comunicacao com Vosk ({VOSK_WS_URL}): {err}" 1')
        status = "HUMAN" # Fallback conservador para humano
    finally:
        audio_fd.close()

    agi_send(f'VERBOSE "Vosk AMD Concluido: STATUS={status} TEXT=\'{transcribed_text}\'" 1')
    agi_send(f'SET VARIABLE VOSK_AMD_STATUS "{status}"')
    agi_send(f'SET VARIABLE VOSK_AMD_TEXT "{transcribed_text}"')

def main():
    _ = read_agi_env()
    asyncio.run(process_eagi_audio())

if __name__ == "__main__":
    main()
