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
import re
import unicodedata
import urllib.request

LOG_FILE = "/var/log/asterisk/vosk_amd.log"
OMNICHAT_API_URL = os.environ.get("OMNICHAT_API_URL", "https://api-omnichat.creditobr.org")

# --- CONFIGURAÇÕES E PESOS ---
# Scores positivos indicam MÁQUINA, negativos indicam HUMANO
VOICEMAIL_KEYWORDS = {
    r'\bcaixa\s+postal\b': 5,
    r'\bcaixa\b': 2,
    r'\bmensagem\b': 2,
    r'\brecado\b': 2,
    r'\bindisponivel\b': 3,
    r'\bausente\b': 3,
    r'\boperadora\b': 3,
    r'\bvivo\b': 3,
    r'\bclaro\b': 3,
    r'\btim\b': 3,
    r'\bda\s+oi\b': 3,
    r'\boperadora\s+oi\b': 3,
    r'\bnao\s+pode\s+atender\b': 4,
    r'\bdeixe\s+seu\s+recado\b': 5,
    r'\bestamos\s+impossibilitados\b': 5,
    r'\bnumero\s+invalido\b': 4,
    r'\bchamada\s+encaminhada\b': 4,
    r'\bcaixa\s+de\s+mensagem\b': 5,
    r'\bdesligado\b': 3,
    r'\bocupado\b': 3,
    r'\btemporariamente\b': 3
}

HUMAN_KEYWORDS = {
    r'\alo\b': -3,
    r'\boi\b': -2,
    r'\bpronto\b': -2,
    r'\bquem\s+fala\b': -4,
    r'\bquem\s+esta\b': -4,
    r'\bestou\b': -2,
    r'\bpode\s+falar\b': -3,
    r'\bom\s+dia\b': -2,
    r'\boa\s+tarde\b': -2,
    r'\boa\s+noite\b': -2,
    r'\bquem\b': -2,
    r'\bpois\s+nao\b': -3,
    r'\bfale\b': -2,
    r'\bouco\b': -2
}

# Compilar Regex Estáticos
VM_REGEX = {re.compile(k): v for k, v in VOICEMAIL_KEYWORDS.items()}
HUMAN_REGEX = {re.compile(k): v for k, v in HUMAN_KEYWORDS.items()}

def remover_acentos(texto):
    return "".join(
        c for c in unicodedata.normalize("NFD", texto)
        if unicodedata.category(c) != "Mn"
    )

def calcular_score_dynamic(text_normalized, vm_patterns):
    score = 0
    for pattern, weight in vm_patterns:
        if pattern.search(text_normalized):
            score += weight
    for pattern, weight in HUMAN_REGEX.items():
        if pattern.search(text_normalized):
            score += weight
    return score

def read_agi_env():
    env = {}
    while True:
        line = sys.stdin.readline().strip()
        if not line: break
        if '=' in line:
            key, val = line.split('=', 1)
            env[key] = val
    return env

def send_agi_cmd(cmd):
    sys.stdout.write(cmd + "\n")
    sys.stdout.flush()
    return sys.stdin.readline().strip()

def write_log(env, status, duration, text, score, error=None):
    try:
        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        unique_id = env.get('agi_uniqueid', 'UNKNOWN')
        log_line = f"{ts} | [{unique_id}] | Status: {status} | Duration: {duration:.2f}s | Score: {score} | Text: '{text}'"
        if error: log_line += f" | Error: {error}"
        with open(LOG_FILE, "a") as f:
            f.write(log_line + "\n")
    except: pass

def fetch_settings_from_api():
    try:
        url = f"{OMNICHAT_API_URL}/api/public/settings/vosk"
        req = urllib.request.Request(url, headers={'User-Agent': 'VoskAMD-AGI'})
        with urllib.request.urlopen(req, timeout=2.0) as response:
            if response.status == 200:
                return json.loads(response.read().decode('utf-8'))
    except Exception as e:
        sys.stderr.write(f"Error fetching settings: {e}\n")
    return None

async def main():
    env = read_agi_env()
    start_time = time.time()
    
    settings = fetch_settings_from_api() or {}
    
    vosk_url = settings.get("vosk_server_url", "ws://127.0.0.1:2700")
    max_duration = float(settings.get("vosk_max_duration", 5000)) / 1000.0
    speech_timeout = float(settings.get("vosk_speech_timeout", 1500)) / 1000.0
    max_words = int(settings.get("vosk_max_words", 4))
    
    voicemail_words_str = settings.get("vosk_voicemail_words")
    if voicemail_words_str:
        words = [w.strip() for w in voicemail_words_str.split(",") if w.strip()]
        vm_patterns = [(re.compile(rf"\b{re.escape(w)}\b"), 5) for w in words]
    else:
        vm_patterns = list(VM_REGEX.items())

    state = {
        "status": "HUMAN",
        "score_final": 0,
        "text_log": "",
        "speech_started": False,
        "speech_start_time": 0.0,
        "last_speech_time": time.time()
    }

    async def receive_responses(websocket):
        try:
            async for message in websocket:
                res = json.loads(message)
                text = res.get("partial", "") or res.get("text", "")
                
                if text:
                    if not state["speech_started"]:
                        state["speech_started"] = True
                        state["speech_start_time"] = time.time()
                    
                    state["last_speech_time"] = time.time()
                    
                    if time.time() - state["speech_start_time"] < 0.5:
                        continue

                    text_norm = remover_acentos(text.lower())
                    state["text_log"] = text
                    state["score_final"] = calcular_score_dynamic(text_norm, vm_patterns)
                    
                    if state["score_final"] >= 5:
                        state["status"] = "MACHINE"
                        break
                    if state["score_final"] <= -5:
                        state["status"] = "HUMAN"
                        break
        except asyncio.CancelledError:
            pass
        except Exception as e:
            sys.stderr.write(f"Vosk recv error: {e}\n")

    try:
        audio_fd = 3
        if not os.path.exists(f"/proc/self/fd/{audio_fd}"):
            send_agi_cmd("SET VARIABLE VOSK_AMD_STATUS HUMAN")
            write_log(env, "HUMAN", 0.0, "", 0, error="EAGI Audio FD 3 not found")
            return

        audio_stream = open(audio_fd, 'rb', buffering=0)
        async with websockets.connect(vosk_url) as websocket:
            await websocket.send(json.dumps({"config": {"sample_rate": 8000.0}}))

            recv_task = asyncio.create_task(receive_responses(websocket))

            while time.time() - start_time < max_duration and state["status"] == "HUMAN":
                chunk = await asyncio.get_event_loop().run_in_executor(None, audio_stream.read, 3200)
                if not chunk: break
                await websocket.send(chunk)

                if state["status"] == "MACHINE":
                    break

                if state["speech_started"] and (time.time() - state["last_speech_time"]) > speech_timeout:
                    break

                await asyncio.sleep(0.01)

            recv_task.cancel()
            try:
                await recv_task
            except:
                pass

            if state["status"] == "HUMAN":
                if state["speech_started"]:
                    word_count = len(state["text_log"].split())
                    
                    if word_count > max_words and (time.time() - state["speech_start_time"]) < 2.5:
                        state["status"] = "MACHINE"
                    elif state["score_final"] > 0:
                        state["status"] = "MACHINE"
                    elif word_count >= 8 and not any(h_pat.search(remover_acentos(state["text_log"].lower())) for h_pat in HUMAN_REGEX):
                        state["status"] = "MACHINE"
                    else:
                        state["status"] = "HUMAN"
                else:
                    state["status"] = "MACHINE"

    except Exception as e:
        state["status"] = "HUMAN"
        write_log(env, state["status"], time.time() - start_time, state["text_log"], state["score_final"], error=str(e))
        send_agi_cmd(f"SET VARIABLE VOSK_AMD_STATUS {state['status']}")
        return

    send_agi_cmd(f"SET VARIABLE VOSK_AMD_STATUS {state['status']}")
    write_log(env, state["status"], time.time() - start_time, state["text_log"], state["score_final"])

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
same => n,GotoIf($["${BYPASS_VOSK}" = "1"]?humano)
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

---

## 7. Estratégia para Não Usar Vosk AMD (AMD Externo/Operadora)

Quando o cliente opta por contratar uma operadora de telefonia (Trunk SIP) que já fornece o serviço de detecção de caixa postal (AMD) diretamente na rede celular/fixa, a execução da análise de transcrição local pelo Vosk torna-se desnecessária e prejudicial (pois introduz um delay de cerca de 3,5 segundos de silêncio/fala antes de transferir a chamada ao operador).

### A Estratégia: Criar outro dialplan ou adaptar o mesmo?
**A melhor estratégia é adaptar o mesmo dialplan (`[triagem-amd]`) utilizando roteamento condicional por variável de canal.**

#### Por que NÃO criar outro dialplan/contexto?
1. **Simplicidade de Código:** Evita a necessidade de gerenciar múltiplos contextos dinâmicos no código do discador (`PredictiveEngine.js`), mantendo a origem de chamada sempre fixa para o mesmo destino.
2. **Coesão e Rastreabilidade:** Todos os logs de depuração do canal e o fluxo de eventos de atendimento passam pelo mesmo ponto, facilitando o diagnóstico.

#### Como funciona a adaptação:
Enviamos a variável de canal `BYPASS_VOSK=1` a partir do `PredictiveEngine.js` ao disparar a chamada. No dialplan do Asterisk (`/etc/asterisk/vitalpbx/extensions__00custom.conf`), fazemos um desvio condicional antes de chamar o script do Vosk:

```asterisk
[triagem-amd]
exten => s,1,NoOp(Chamada atendida pelo cliente. Iniciando triagem AMD com Vosk...)
same => n,GotoIf($["${BYPASS_VOSK}" = "1"]?humano) ; <-- SE BYPASS ATIVO, VAI DIRETO PRO OPERADOR
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

Com isso, o fluxo de eventos e atendimento permanece idêntico, mas o Asterisk pula a execução do Vosk e entrega a chamada imediatamente ao operador quando o cliente atende.

---

## 8. Gerenciamento e Controle das Salas dos Agentes no LiveKit

O discador gerencia o áudio bidirecional integrando o cliente (via telefonia tradicional convertida em SIP) e o agente (via WebRTC no navegador) dentro de salas dedicadas do LiveKit.

### A Chave e o Nome da Sala
O nome das salas no discador segue um padrão rígido gerado a partir do ID exclusivo do agente:
* **Chave da Sala:** `sala_agente_${agentId}` (exemplo: para o agente com ID `12`, a sala será `sala_agente_12`).
* **Motivo do Padrão:** O agente possui uma sala "estática" pessoal no LiveKit. Quando ele fica online, ele já se conecta a essa sala e aguarda nela. As ligações telefônicas dos clientes são então transferidas para dentro desta mesma sala.

### Ciclo de Abertura e Controle da Sala

```
+--------------------------------------------------------------------------+
| 1. AGENTE FICA ONLINE                                                    |
|                                                                          |
|  [Navegador] --- (WS: agent.update_status: 'disponivel') ---> [Backend]  |
|                                                                          |
|  [Backend]  --- (Cria sala 'sala_agente_{id}' no LiveKit) --------------->  |
|  [Backend]  --- (Gera token JWT com privilégios de agente) ------------->  |
|  [Backend]  --- (WS: agent.status_updated + token) -------> [Navegador]  |
|                                                                          |
|  [Navegador] --- (Conecta WebRTC na sala com JWT)                         |
|  [Navegador] --- (WS: agent.ready_for_calls) --------------> [Backend]  |
|  * O Agente é inserido na fila dialer:idle_agents no Redis.               |
+--------------------------------------------------------------------------+
                                    |
                                    v
+--------------------------------------------------------------------------+
| 2. BRIDGE DE CHAMADA ATENDIDA                                             |
|                                                                          |
|  * O motor de discagem identifica humano atendido (UserEvent).           |
|  * Retira o agente mais ocioso da fila 'dialer:idle_agents'.             |
|  * Atualiza o status do agente no Postgres para 'ocupado'.               |
|  * Envia comando de redirecionamento (Redirect) ao Asterisk:            |
|                                                                          |
|    SetVar: AGENT_ROOM = sala_agente_{id}                                 |
|    Redirect: Canal do Cliente -> Extensão 9999 em cos-all-custom         |
+--------------------------------------------------------------------------+
                                    |
                                    v
+--------------------------------------------------------------------------+
| 3. CONEXÃO SIP TELEFONIA <--> LIVEKIT                                    |
|                                                                          |
|  * O dialplan na extensão 9999 recebe o canal do cliente.                |
|  * Executa a discagem para o tronco SIP do LiveKit:                      |
|                                                                          |
|    Dial(PJSIP/livekit-sip/sip:${AGENT_ROOM}@livekit-sip:5060)            |
|                                                                          |
|  * O áudio do celular do cliente entra na sala 'sala_agente_{id}' via SIP.|
|  * Como o agente já está na sala via WebRTC, a conversa se inicia.       |
+--------------------------------------------------------------------------+
                                    |
                                    v
+--------------------------------------------------------------------------+
| 4. ENCERRAMENTO (HANGUP)                                                 |
|                                                                          |
|  * Se o agente desligar (WS: agent.hangup_call) ou o cliente desligar:   |
|  * O discador executa Hangup no canal Asterisk correspondente.           |
|  * Limpa a chave 'dialer:active_call_channel:{agentId}' no Redis.        |
|  * Restabelece o status do agente para 'disponivel' e o insere de volta  |
|    no topo da fila de ociosos (reiniciando o ciclo).                     |
+--------------------------------------------------------------------------+
```

### Limpeza e Prevenção de Canais Presos
Para evitar que chamadas fiquem "presas" no Asterisk ou consumindo licenças do LiveKit em caso de problemas na rede do agente:
* **Queda do WebSocket:** Se o agente fechar a guia ou perder a conexão de internet, o evento `close` do socket é disparado no discador.
* **Ação Automática:** O discador busca imediatamente a chave `dialer:active_call_channel:${agentId}` no Redis. Se houver um canal ativo associado a este agente, o discador envia um comando `Hangup` via AMI ao Asterisk para desligar a chamada do cliente imediatamente, evitando chamadas presas na operadora.


