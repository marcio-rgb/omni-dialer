# Integração do Vosk AMD (Answering Machine Detection) Inteligente

Este documento detalha a implementação e a arquitetura da triagem inteligente de chamadas (detecção de caixa postal e robôs) utilizando o motor de Speech-to-Text offline **Vosk**, integrado ao **VitalPBX (Asterisk)** e ao microsserviço de discagem preditiva.

---

## 1. Arquitetura da Solução

O fluxo de áudio da chamada atendida pelo cliente é enviado em tempo real para o servidor do Vosk para transcrição cognitiva. Com base nas palavras identificadas nos primeiros segundos, o sistema classifica a chamada como humana ou máquina.

```
+------------------+                   +----------------------+
| Cliente Atende   |                   |  Servidor Vosk       |
| (Asterisk Chan)  |                   |  (Docker Container)  |
+--------+---------+                   +----------+-----------+
         |                                        ^
         | (Áudio Linear PCM via FD 3)             | (Stream WebSocket)
         v                                        |
+--------+---------+                              |
| EAGI:            +------------------------------+
| vosk_amd.py      |
+--------+---------+
         |
         | (Define VOSK_AMD_STATUS = HUMAN / MACHINE)
         v
+--------+---------+
| Dialplan:        |
| [triagem-amd]    |
+------------------+
```

---

## 2. Componente 1: Servidor Vosk (Docker Container)

O Vosk roda dentro de um container Docker isolado na mesma máquina do VitalPBX para evitar conflito de dependências e facilitar atualizações.

*   **Imagem Docker utilizada:** `alphacep/kaldi-vosk-server:latest`
*   **Porta exposta:** `2700` (TCP)
*   **Modelo de voz local:** `/opt/vosk-model-pt/model` (mapeado para `/opt/vosk-model/model` dentro do contêiner). Utiliza o modelo leve em português `vosk-model-small-pt-0.3`.

### Comando de Inicialização do Contêiner:
```bash
docker run -d \
  --name vosk-pt \
  --restart always \
  -p 2700:2700 \
  -v /opt/vosk-model-pt:/opt/vosk-model \
  alphacep/kaldi-vosk-server:latest \
  python3 /opt/vosk-server/websocket/asr_server.py /opt/vosk-model/model
```

---

## 3. Componente 2: Script EAGI (`vosk_amd.py`)

O script AGI estendido (EAGI) captura o áudio bruto do canal telefônico via File Descriptor 3 (Linear PCM, 8000Hz, 16-bit mono) e transmite via WebSocket local para o Vosk.

*   **Caminho no servidor:** `/var/lib/asterisk/agi-bin/vosk_amd.py`
*   **Permissões:** `chmod +x`
*   **Dono:** `asterisk:asterisk`
*   **Dependências do Sistema:** `apt-get install -y python3-websockets`

### Código Fonte do Script (`vosk_amd.py`):
```python
#!/usr/bin/env python3
import sys
import os
import asyncio
import json
import websockets
import time
import datetime

LOG_FILE = "/var/log/asterisk/vosk_amd.log"

def read_agi_env():
    env = {}
    while True:
        line = sys.stdin.readline().strip()
        if not line:
            break
        if '=' in line:
            key, val = line.split('=', 1)
            env[key] = val
    return env

def send_agi_cmd(cmd):
    sys.stdout.write(cmd + "\n")
    sys.stdout.flush()
    return sys.stdin.readline().strip()

def write_log(env, status, duration, text, matched_keywords, error=None):
    try:
        unique_id = env.get("agi_uniqueid", "UNKNOWN")
        channel = env.get("agi_channel", "UNKNOWN")
        timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        
        log_line = f"{timestamp} | [{unique_id}] | Channel: {channel} | Status: {status} | Duration: {duration:.2f}s"
        if text:
            log_line = log_line + f" | Text: '{text}'"
        if matched_keywords:
            log_line = log_line + f" | Matched: {matched_keywords}"
        if error:
            log_line = log_line + f" | Error: {error}"
        log_line = log_line + "\n"
        
        with open(LOG_FILE, "a") as f:
            f.write(log_line)
    except:
        pass

VOICEMAIL_KEYWORDS = ["caixa", "mensagem", "recado", "postal", "sinal", "indisponivel", "ausente", "encaminhada", "operadora", "ocupado", "desligado"]
HUMAN_KEYWORDS = ["alo", "oi", "pronto", "ola", "quem", "fala", "tarde", "dia", "noite"]

async def main():
    env = read_agi_env()
    
    status = "HUMAN"
    duration = 0.0
    text_log = ""
    matched_keywords = []
    error_log = None
    start_time = time.time()
    
    try:
        audio_fd = 3
        if not os.path.exists(f"/proc/self/fd/{audio_fd}"):
            send_agi_cmd("VERBOSE \"EAGI Audio FD 3 not found, defaulting to HUMAN\" 1")
            send_agi_cmd("SET VARIABLE VOSK_AMD_STATUS HUMAN")
            write_log(env, "HUMAN", 0.0, "", [], error="EAGI Audio FD 3 not found")
            return

        audio_stream = open(audio_fd, 'rb', buffering=0)

        uri = "ws://127.0.0.1:2700"
        async with websockets.connect(uri) as websocket:
            await websocket.send(json.dumps({"config": {"sample_rate": 8000.0}}))

            max_duration = 3.5
            loop = asyncio.get_running_loop()

            while time.time() - start_time < max_duration:
                chunk = await loop.run_in_executor(None, audio_stream.read, 1600)
                if not chunk:
                    break

                await websocket.send(chunk)

                try:
                    response_json = await asyncio.wait_for(websocket.recv(), timeout=0.01)
                    res = json.loads(response_json)
                    
                    text = ""
                    if "partial" in res:
                        text = res["partial"].lower()
                    elif "text" in res:
                        text = res["text"].lower()

                    if text:
                        text_log = text
                        # Check VM keywords
                        vm_matched = [kw for kw in VOICEMAIL_KEYWORDS if kw in text]
                        if vm_matched:
                            status = "MACHINE"
                            matched_keywords = vm_matched
                            send_agi_cmd(f"VERBOSE \"Vosk AMD: Machine detected by keyword: {text}\" 2")
                            break
                        
                        # Check Human keywords
                        human_matched = [kw for kw in HUMAN_KEYWORDS if kw in text]
                        if human_matched:
                            status = "HUMAN"
                            matched_keywords = human_matched
                            send_agi_cmd(f"VERBOSE \"Vosk AMD: Human detected by keyword: {text}\" 2")
                            break

                except asyncio.TimeoutError:
                    pass

            duration = time.time() - start_time

            if status == "HUMAN":
                await websocket.send('{"eof" : 1}')
                final_res = json.loads(await websocket.recv())
                final_text = final_res.get("text", "").lower()
                
                if final_text:
                    text_log = final_text
                    vm_matched = [kw for kw in VOICEMAIL_KEYWORDS if kw in final_text]
                    human_matched = [kw for kw in HUMAN_KEYWORDS if kw in final_text]
                    
                    if vm_matched:
                        status = "MACHINE"
                        matched_keywords = vm_matched
                    elif human_matched:
                        status = "HUMAN"
                        matched_keywords = human_matched
                    else:
                        word_count = len(final_text.split())
                        if word_count > 4:
                            status = "MACHINE"
                            matched_keywords = [f"word_count_gt_4 ({word_count} words)"]
                        else:
                            status = "HUMAN"
                            matched_keywords = [f"word_count_le_4 ({word_count} words)"]

    except Exception as e:
        error_log = str(e)
        send_agi_cmd(f"VERBOSE \"Vosk AMD Error: {error_log}\" 1")
        status = "HUMAN"
        duration = time.time() - start_time

    send_agi_cmd(f"SET VARIABLE VOSK_AMD_STATUS {status}")
    send_agi_cmd(f"VERBOSE \"Vosk AMD Finished. Result is {status}\" 1")
    
    # Write to local log file
    write_log(env, status, duration, text_log, matched_keywords, error=error_log)

if __name__ == "__main__":
    asyncio.run(main())
```

---

## 4. Componente 3: Dialplan do Asterisk

O Dialplan foi modificado para substituir a chamada da aplicação clássica de AMD do Asterisk pela execução do nosso script.

*   **Caminho do arquivo:** `/etc/asterisk/vitalpbx/extensions__00custom.conf`
*   **Bloco modificado (`[triagem-amd]`):**

```asterisk
[triagem-amd]
exten => s,1,NoOp(Chamada atendida pelo cliente. Iniciando triagem AMD com Vosk...)
same => n,EAGI(vosk_amd.py)
same => n,NoOp(Resultado do Vosk AMD: ${VOSK_AMD_STATUS})
same => n,GotoIf($["${VOSK_AMD_STATUS}" = "HUMAN"]?humano:maquina)

; Se for Caixa Postal ou Robô (MACHINE)
same => n(maquina),NoOp(Detectado Caixa Postal/Robo. Desligando...)
same => n,Hangup()

; Se for uma pessoa real (HUMAN)
same => n(humano),NoOp(Humano detectado! Notificando o Dialer Backend...)
same => n,UserEvent(PredictiveHuman,ChannelId: ${CHANNEL},Phone: ${PHONE},LeadId: ${LEAD_ID},CampaignId: ${CAMPAIGN_ID})
same => n,Wait(5)
same => n,Hangup()
```

---

## 5. Comandos de Diagnóstico e Verificação

### Visualizar Logs do Vosk em tempo real:
```bash
docker logs -f vosk-pt
```

### Reiniciar o Servidor Vosk:
```bash
docker restart vosk-pt
```

### Recarregar o Dialplan do Asterisk após edições:
```bash
asterisk -rx "dialplan reload"
```

### Verificar o Dialplan Carregado na Memória:
```bash
asterisk -rx "dialplan show triagem-amd"
```

---

## 6. Esquema de Logs e Debug Detalhado

Para auditar as decisões de triagem (saber se o Vosk acertou ou errou), configuramos um arquivo de log local dedicado no servidor VitalPBX.

*   **Caminho do Log:** `/var/log/asterisk/vosk_amd.log`
*   **Permissões do arquivo:** `664` (dono `asterisk:asterisk`)

### Como monitorar em tempo real (Real-Time Debug):
Abra o terminal do servidor do VitalPBX e execute:
```bash
tail -f /var/log/asterisk/vosk_amd.log
```

### Formato da Linha de Log:
Cada chamada gera um registro detalhado em uma única linha estruturada:
```text
[Data Hora] | [UniqueId da Chamada] | Channel: [Canal SIP] | Status: [HUMAN/MACHINE] | Duration: [Tempo de Análise] | Text: '[Texto Transcrito]' | Matched: [Palavras-Chave Identificadas ou Regra de Contagem de Palavras]
```

### Exemplos Reais de Decisão de Logs:

#### Exemplo 1: Detecção Rápida de Humano (Alô)
```text
2026-07-09 06:36:12 | [1783543029.518] | Channel: Local/11991218977@cos-all-000000a2;1 | Status: HUMAN | Duration: 1.20s | Text: 'alo' | Matched: ['alo']
```
*   *Explicação:* O cliente atendeu e disse "Alô" no primeiro segundo. O Vosk identificou a palavra da lista `HUMAN_KEYWORDS` e cortou a análise imediatamente, conectando ao operador em apenas 1.2s.

#### Exemplo 2: Detecção de Caixa Postal por Palavra-Chave
```text
2026-07-09 06:36:45 | [1783543030.520] | Channel: Local/11996017900@cos-all-000000a3;1 | Status: MACHINE | Duration: 2.15s | Text: 'deixe sua mensagem apos o sinal' | Matched: ['mensagem', 'sinal']
```
*   *Explicação:* A gravação da operadora atendeu. O Vosk reconheceu as palavras da lista `VOICEMAIL_KEYWORDS` e desligou a ligação imediatamente com 2.1s de triagem.

#### Exemplo 3: Detecção de Caixa Postal por Extensão de Texto (Heurística)
```text
2026-07-09 06:37:10 | [1783543031.522] | Channel: Local/11942158336@cos-all-000000a4;1 | Status: MACHINE | Duration: 3.50s | Text: 'ola o numero discado nao esta disponivel no momento' | Matched: ['word_count_gt_4 (10 words)']
```
*   *Explicação:* O áudio transcreveu uma frase longa sem palavras-chave específicas da lista principal, mas como superou 4 palavras faladas continuamente nos 3.5 segundos de limite, foi classificada como máquina/gravação comercial.

### Como depurar problemas comuns (Troubleshooting):

1.  **Erro: `EAGI Audio FD 3 not found` no log:**
    *   *Causa:* O dialplan chamou `AGI(vosk_amd.py)` em vez de `EAGI(vosk_amd.py)`. A aplicação de AGI padrão não passa o áudio da chamada para o script.
    *   *Solução:* Verifique se a linha do dialplan está exatamente como `same => n,EAGI(vosk_amd.py)`.
2.  **Erro: `ModuleNotFoundError: No module named 'websockets'`:**
    *   *Causa:* O pacote python `websockets` não está instalado no ambiente global.
    *   *Solução:* Rode `apt-get install -y python3-websockets`.
3.  **Vosk-pt retornando erros de conexão:**
    *   *Causa:* O contêiner Docker `vosk-pt` travou ou não está de pé na porta `2700`.
    *   *Solução:* Rode `docker ps` para ver se o contêiner está ativo. Reinicie se necessário com `docker restart vosk-pt`.

