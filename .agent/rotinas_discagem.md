# Rotinas de Chamadas e Discagem - OmniChat & Dialer

Este documento descreve detalhadamente a arquitetura, o fluxo de dados, as rotinas de discagem (manual e preditiva) e as chaves de estado gerenciadas no banco de dados e no Redis dentro do ecossistema do **OmniChat** e do **Dialer**.

> [!NOTE]
> Para obter as regras gerais de integração com a central telefônica Asterisk, variáveis de canal AMI, dialplans `[triagem-amd]` e fluxo de gravação de áudios, consulte também o documento [dialer-to-pbx.md](file:///home/marcio/ominichat/ecosystem/dialer-to-pbx.md).

---

## 1. Diferença Fundamental: Chamadas do Chat vs. Chamadas do Discador

Embora ambas as modalidades utilizem o **LiveKit** para gerenciar sessões de áudio/vídeo em tempo real, elas operam em redes e protocolos completamente distintos:

```mermaid
graph TD
    subgraph "1. Chamada de Chat (Áudio/Vídeo)"
        A[Agente no Navegador] <-->|WebRTC| C[Sala LiveKit]
        B[Cliente no Navegador] <-->|WebRTC| C
    end

    subgraph "2. Chamada de Discador (Telefonia SIP)"
        D[Agente no Navegador] <-->|WebRTC| F[Sala LiveKit]
        E[Cliente no Celular/Fixo] <-->|Rede Telefônica| G[VitalPBX / Asterisk]
        G <-->|SIP Trunk| F
    end
    
    style C fill:#d4edda,stroke:#28a745,stroke-width:2px
    style F fill:#f8d7da,stroke:#dc3545,stroke-width:2px
```

### A. Chamadas Nativas do Chat
* **Protocolo:** WebRTC ponta a ponta.
* **Caminho:** Navegador do Agente $\leftrightarrow$ Servidor LiveKit $\leftrightarrow$ Navegador do Cliente.
* **Fluxo:**
  1. O agente clica em iniciar uma chamada de áudio ou vídeo no chat.
  2. O servidor do OmniChat (`callService.js`) gera uma sala única no LiveKit (`call_{conversationId}_{timestamp}`) e um token JWT de agente.
  3. É gerado um link público da chamada (ex: `https://app.omnichat/live-chat/call_XYZ?audioOnly=true`).
  4. Esse link é enviado ao cliente pelo canal ativo (WhatsApp via Evolution API, Webchat, Instagram, Telegram).
  5. O cliente clica no link no celular/computador e entra na sala LiveKit diretamente pelo navegador.
* **Independência:** Não há consumo de troncos telefônicos, não passa pela central telefônica (VitalPBX/Asterisk), e não há custos de operadora de telefonia.

### B. Chamadas do Discador (Telefonia Bridged)
* **Protocolo:** WebRTC (Agente) $\leftrightarrow$ LiveKit $\leftrightarrow$ Tronco SIP $\leftrightarrow$ Asterisk $\leftrightarrow$ Rede de Telefonia (Cliente).
* **Caminho:** O agente usa WebRTC na sua interface, enquanto o cliente recebe uma ligação telefônica tradicional (GSM/Fixo) iniciada pelo discador no Asterisk.
* **Fluxo:**
  1. O discador origina uma chamada telefônica para o número do cliente via Asterisk/VitalPBX.
  2. Quando o cliente atende, o Asterisk faz o bridge/redirecionamento da chamada telefônica para um tronco SIP conectado ao LiveKit (LiveKit SIP Forwarder).
  3. O LiveKit insere o fluxo de áudio da chamada SIP em uma sala correspondente.
  4. O agente entra na mesma sala via WebRTC.
* **Uso:** Utilizado tanto no fluxo de **Discador Preditivo** quanto no botão de **Chamada Manual com Telefonia (WebRTC)** do chat.

---

## 2. Rotinas de Discagem Telefônica

O microsserviço do discador oferece três fluxos de chamadas telefônicas: **Chamada Manual via WebRTC**, **Chamada Manual via Ramal SIP** e o **Discador Preditivo**.

---

### Fluxo 1: Chamada Manual WebRTC (Botão no Chat com Telefonia)

Permite ao agente discar para o número do cliente a partir do chat, conversando através do seu microfone do navegador, enquanto o cliente recebe uma chamada de voz tradicional.

#### Diagrama de Sequência
```mermaid
sequenceDiagram
    autonumber
    actor Agente as Agente (Browser)
    participant Chat as OmniChat Server
    participant Dialer as Dialer Service
    participant Redis as Redis
    participant PBX as Asterisk (AMI)
    participant Cliente as Cliente (Telefone)

    Agente->>Chat: Inicia chamada SIP com o Cliente
    Note over Chat: callService.initiateCall(..., dialSip = true)
    Chat->>Dialer: POST /api/v1/calls/manual-webrtc (phone, roomName, agentId)
    Dialer->>Redis: Salva dados da chamada em dialer:manual_call_info:{agentId}
    Dialer->>PBX: Action: Originate (Channel: Local/{phone}@cos-all, App: Dial, Data: PJSIP/trunk/sip:{roomName}@livekit)
    
    rect rgb(240, 248, 255)
        Note over PBX: Asterisk inicia discagem para o cliente
        PBX->>Cliente: Toca telefone do cliente
        Cliente->>PBX: Atende a chamada
    end

    PBX->>Dialer: Webhook /webhooks/livekit (event: call.answered, channelId)
    Dialer->>Redis: Busca roomName correspondente a partir do channelId
    Dialer->>PBX: POST /channels/{channelId}/transfer para LiveKit SIP Trunk (sala roomName)
    PBX->>Agente: Áudio telefônico do cliente é injetado na sala LiveKit via SIP
    Agente->>Agente: Conecta à sala LiveKit via WebRTC usando token JWT
```

#### Detalhes do Originate no Asterisk
* **Canal Disparado:** `Local/${dialedPhone}@cos-all/n` (disca primeiro para o cliente).
* **Aplicação executada no atendimento:** `Dial` direcionada para `PJSIP/${sipTrunk}/sip:${roomName}@${sipHost}`.
* **Comportamento em Desenvolvimento Local:** Caso o servidor LiveKit rode localmente, o discador consulta a API `ipify.org` para obter o IP público da máquina host e redirecionar a chamada SIP na porta 5065 (`PJSIP/${sipTrunk}/sip:${roomName}@${publicIp}:5065`).

---

### Fluxo 2: Chamada Manual via Ramal SIP (Telefone IP / Softphone)

Neste fluxo, o discador conecta um ramal físico (ou softphone tipo Zoiper configurado no computador do agente) diretamente ao telefone do cliente, sem passar pelo LiveKit.

#### Fluxo de Execução
1. O agente clica em discar no modo "Ramal".
2. O OmniChat envia a requisição para o discador: `POST /api/v1/calls/manual` contendo `phone` e `agentId`.
3. O discador busca o cadastro do agente na tabela `users` do banco de dados e valida o campo `ramal` (extension).
4. O discador remove o agente temporariamente do ZSET de ociosos (`dialer:idle_agents`) e altera o status do agente para `chamada_manual`.
5. O discador envia um comando `Originate` via AMI para o Asterisk:
   * **Canal:** `Local/${agent.ramal}@cos-all/n` (chama primeiro o ramal do agente).
   * **Contexto de Destino:** `cos-all`
   * **Extensão de Destino:** O número do cliente (`dialedPhone`).
   * **Prioridade:** 1
6. O telefone físico (ou softphone) do agente toca. Quando o agente atende, o Asterisk inicia a discagem para o cliente e conecta ambos em canal telefônico direto.

---

### Fluxo 3: Discador Preditivo (Motor Automático)

O discador preditivo realiza disparos automáticos em lote com base em cálculos estatísticos de ociosidade de agentes e taxa de contato.

#### O Loop de Pacing (Executado a cada 500ms)
A cada iteração (função `tick()` em `PredictiveEngine.js`), o discador realiza a seguinte rotina matemática e operacional:

1. **Conta Agentes Disponíveis:** Lê o total de agentes no Redis ZSET `dialer:idle_agents` ($A$).
2. **Calcula a Taxa de Sucesso Recente ($S$):**
   * Consulta na tabela `call_history` as chamadas iniciadas nos últimos 5 minutos (definido por `dialer_success_rate_window_minutes`).
   * Divide a quantidade de chamadas com status `"Atendida"` pelo total de chamadas discadas.
   * Aplica limites mínimos e máximos (`dialer_min_success_rate` de 5% e `dialer_max_success_rate` de 100%).
   * Se houver penalidade de abandono ativa, a taxa é sobrescrita para $1.0$ (100% de sucesso artificial, o que reduz drasticamente os disparos).
3. **Calcula a Quantidade de Disparos Necessários ($D$):**
   $$D = \lceil (A / S) \times \text{agressividade} \rceil$$
   *(Onde agressividade é um multiplicador ajustável no painel administrativo).*
4. **Calcula o Limite por Tick:** Espaça as ligações ao longo de 60 segundos para evitar congestionamento na saída de rede.
5. **Aplica o Limite de Canais:** Compara com o máximo de linhas simultâneas disponíveis (`dialer_max_channels` menos a quantidade de canais ativos monitorados pelo Redis `dialer:active_dialing_channels`).
6. **Popula a Fila de Leads:** Se a fila `dialer:lead_queue` em Redis estiver vazia, carrega novos 100 leads undialed do banco de dados (tabela `lead`) pertencentes a campanhas preditivas ativas. Ignora telefones na blacklist (`dialer:blacklisted_phones`) ou leads em cooldown temporário.
7. **Dispara as Chamadas via AMI:** Para cada disparo autorizado, retira um lead da fila e dispara via AMI:
   * **Canal:** `Local/${dialedPhone}@${pbxContext}/n`
   * **Contexto:** `triagem-amd`
   * **Variáveis:** Se a opção `Habilitar Triagem Vosk AMD local` estiver desmarcada nas configurações (campo `dialer_use_vosk_amd` no banco), envia a variável de canal `BYPASS_VOSK=1` para instruir o Asterisk a ignorar a análise local de áudio.

#### A Triagem e Answering Machine Detection (AMD)
```mermaid
graph TD
    A[Asterisk disca para o Cliente] --> B{Cliente Atendeu?}
    B -- Não (Timeout/Ocupado/Falha) --> C[Grava 'NaoAtendida' no Histórico]
    B -- Sim --> Z{Bypass Vosk AMD?}
    Z -- Sim (Telefonia Externa com AMD) --> G[Gera UserEvent: PredictiveHuman]
    Z -- Não (Usar Vosk Local) --> D[Executa Script EAGI: vosk_amd.py]
    D --> E{Classificação Vosk}
    E -- Máquina (Caixa Postal/URA) --> F[Asterisk desliga a chamada]
    E -- Humano --> G
    G --> H[Listener do PredictiveEngine no Dialer]
    H --> I{Agentes Ociosos no Redis ZSET?}
    
    I -- Sim --> J[Bridge Agente <--> Cliente]
    I -- Não --> K[Protocolo de Abandono]

    style J fill:#d4edda,stroke:#28a745
    style K fill:#f8d7da,stroke:#dc3545
```

1. **Atendimento e Verificação de Bypass:** Quando a chamada é atendida, o Asterisk verifica a variável de canal `${BYPASS_VOSK}`. Se for igual a `"1"`, pula diretamente para o bloco de Humano (`humano`), disparando o evento `UserEvent: PredictiveHuman` sem gerar delay de análise. Caso contrário, segue para o script de EAGI (`vosk_amd.py`).
2. **Coleta de Áudio:** O script de EAGI lê o áudio bruto da chamada via File Descriptor 3 (PCM linear 8kHz, 16-bit) e envia por WebSocket para o container Docker do Vosk.
3. **Análise de Voz:** O Vosk realiza o Speech-to-Text em tempo real nos primeiros segundos e o script classifica o áudio analisando palavras-chave de caixas postais (ex: *"deixe seu recado"*, *"caixa de mensagem"*, *"está indisponível"*).
4. **Desvio de Máquina:** Se detectada máquina, a chamada é finalizada imediatamente pelo dialplan.
5. **Detecção de Humano:** Se detectado humano, o dialplan gera o evento `UserEvent: PredictiveHuman` com os parâmetros do canal.

#### O Fluxo de Atendimento do Humano (`PredictiveHuman`):
* O listener em `PredictiveEngine.js` captura o evento.
* **Isolamento de Campanhas de IA:** O listener verifica primeiramente se a campanha é do tipo IA (`isAiCampaign === true` ou associada a equipes do tipo `ai_agent`/`ia`). Se for campanha de IA, o `PredictiveEngine.js` ignora o evento (`return`), deixando o processamento integralmente sob responsabilidade do `AiPredictiveEngine.js`.
* **Cenário A: Há agente disponível no ZSET `dialer:idle_agents`**
  1. Remove o agente do ZSET `dialer:idle_agents`.
  2. Atualiza o status do agente para `ocupado` (no banco PostgreSQL).
  3. Recupera ou cria o registro do contato (com enriquecimento por CPF/Lead).
  4. Localiza ou abre uma conversa ativa (`status: 'open'`).
  5. Salva o registro da chamada ativa na tabela `calls` com o nome da sala `sala_agente_${agentId}`.
  6. Envia o evento `agent.incoming_call` via WebSocket para o navegador do agente contendo os dados do cliente para popup do CRM.
  7. Envia comando no Asterisk definindo a variável de canal `AGENT_ROOM = sala_agente_${agentId}` e redireciona o canal do cliente (`redirectCall`) para a extensão `9999` no contexto `cos-all-custom` (direcionando o cliente para o tronco SIP do LiveKit na sala correspondente).
  8. O navegador do agente entra automaticamente na sala `sala_agente_${agentId}` via WebRTC.
  9. Registra o contato atendido como `"Atendida"` na tabela `call_history`.
* **Cenário B: Protocolo de Abandono (Zero agentes disponíveis)**
  1. O discador executa o comando `hangupCall` imediatamente para derrubar a chamada do cliente em menos de 2 segundos.
  2. Cria ou localiza um contato para o cliente.
  3. Registra a ligação no histórico `call_history` como `"Abandono"` vinculada ao usuário especial `system_dialer` (`dialer@omnichat.internal`).
  4. **Proteção do Discador (Congelamento):** Salva no Redis a chave `dialer:inflated_success_rate = 1.0` por 30 segundos. Isso faz com que a fórmula de disparos do loop calcule que a taxa de sucesso é de 100%, reduzindo o número de disparos necessários para o mesmo número de agentes disponíveis, dando tempo para novos agentes ficarem disponíveis e evitando o efeito cascata de abandono de chamadas.

---

## 3. Dialplans Customizados do Asterisk PBX (`extensions__00custom.conf`)

Os dialplans do servidor Asterisk (`84.247.135.255` em `/etc/asterisk/vitalpbx/extensions__00custom.conf`) gerenciam o fluxo de mídia, gravação e redirecionamento SIP.

### Contexto `[triagem-amd]`
Executado quando uma chamada preditiva é atendida pelo destino:
```asterisk
[triagem-amd]
exten => s,1,NoOp(Chamada atendida pelo cliente. Iniciando triagem AMD...)
same => n,ExecIf($[ "${REC_STARTED}" != "yes" ]?Set(REC_FILENAME=/var/spool/asterisk/monitor/${STRFTIME(${EPOCH},,%Y/%m/%d)}/${STRFTIME(${EPOCH},,%H%M%S)}-PRED-${PHONE}-${UNIQUEID}))
same => n,ExecIf($[ "${REC_STARTED}" != "yes" ]?MixMonitor(${REC_FILENAME}.wav,b))
same => n,ExecIf($[ "${REC_STARTED}" != "yes" ]?Set(__REC_STARTED=yes))

; Respeita a configuracao /admin/dialer: dialer_use_vosk_amd = false (BYPASS_VOSK = 1)
same => n,GotoIf($["${BYPASS_VOSK}" = "1"]?humano)

same => n,EAGI(vosk_amd.py)
same => n,NoOp(Resultado do Vosk AMD: ${VOSK_AMD_STATUS})
same => n,GotoIf($["${VOSK_AMD_STATUS}" = "HUMAN"]?humano:maquina)

same => n(maquina),NoOp(Detectado Caixa Postal/Robo. Desligando...)
same => n,Hangup()

same => n(humano),NoOp(Humano detectado! Emitindo evento conforme IS_AI_CALL: ${IS_AI_CALL})
same => n,ExecIf($[ "${IS_AI_CALL}" = "1" ]?UserEvent(PredictiveAi,ChannelId: ${CHANNEL},Phone: ${PHONE},LeadId: ${LEAD_ID},CampaignId: ${CAMPAIGN_ID}))
same => n,ExecIf($[ "${IS_AI_CALL}" != "1" ]?UserEvent(PredictiveHuman,ChannelId: ${CHANNEL},Phone: ${PHONE},LeadId: ${LEAD_ID},CampaignId: ${CAMPAIGN_ID}))
same => n,Wait(5)
same => n,Hangup()
```

### Contexto `[cos-all-custom]` (Redirecionamento para LiveKit e ElevenLabs)
```asterisk
[cos-all-custom]
exten => 9999,1,NoOp(Redirecionando chamada para a sala do LiveKit: ${AGENT_ROOM})
same => n,ExecIf($[ "${REC_STARTED}" != "yes" ]?Set(REC_FILENAME=/var/spool/asterisk/monitor/${STRFTIME(${EPOCH},,%Y/%m/%d)}/${STRFTIME(${EPOCH},,%H%M%S)}-LIVEKIT-${PHONE}-${UNIQUEID}))
same => n,ExecIf($[ "${REC_STARTED}" != "yes" ]?MixMonitor(${REC_FILENAME}.wav,b))
same => n,ExecIf($[ "${REC_STARTED}" != "yes" ]?Set(__REC_STARTED=yes))
same => n,Dial(PJSIP/livekit/sip:${AGENT_ROOM}@live.creditobr.org:5060)

exten => 9998,1,NoOp(Redirecionando para ElevenLabs AI Agent: ${ELEVENLABS_AGENT_ID})
same => n,ExecIf($[ "${REC_STARTED}" != "yes" ]?Set(REC_FILENAME=/var/spool/asterisk/monitor/${STRFTIME(${EPOCH},,%Y/%m/%d)}/${STRFTIME(${EPOCH},,%H%M%S)}-ELEVEN-${PHONE}-${UNIQUEID}))
same => n,ExecIf($[ "${REC_STARTED}" != "yes" ]?MixMonitor(${REC_FILENAME}.wav,b))
same => n,ExecIf($[ "${REC_STARTED}" != "yes" ]?Set(__REC_STARTED=yes))
same => n,Dial(PJSIP/anonymous/sip:${ELEVENLABS_AGENT_ID}@sip.rtc.elevenlabs.io:5060)
same => n,Hangup()
```

### Fluxo de Download e Gravações de Áudio Backend (`recordingQueue.js`)
1. **Local de Gravação no PBX:** `/var/spool/asterisk/monitor/YYYY/MM/DD/` (arquivos `.wav` ou `.wav.wav`).
2. **Endpoint HTTP Nginx:** Expósito via `https://pbx.creditobr.com.br/monitor/...` (HTTP 200 OK).
3. **Mecanismo de Retentativa:** O worker `recordingQueue.js` tenta o download direto via `/monitor/` e possui *fallback* automático para o sufixo duplo `.wav.wav` gerado pelo script de fusão de estéreo do VitalPBX (`mix-stereo.sh`).

---

## 4. Gerenciamento de Conexão e Estado do Agente (WebSocket)

A comunicação em tempo real de controle do agente com o discador ocorre via conexão WebSocket persistente no endpoint `/api/v1/calls/ws?agentId={id}`.

### Máquina de Estados do Agente

```mermaid
stateDiagram-v2
    [*] --> Desconectado
    Desconectado --> Pausa : Conectou WebSocket
    Pausa --> Disponivel : agent.update_status(disponivel)
    Disponivel --> EsperandoLivekit : Cria Sala & Token LiveKit
    EsperandoLivekit --> FilaOciosos : agent.ready_for_calls (LiveKit Conectado)
    FilaOciosos --> Ocupado : Chamada Recebida / Discagem Manual
    Ocupado --> Disponivel : Chamada Finalizada (Hangup)
    Disponivel --> Pausa : Alteração Manual / Desconexão
    Ocupado --> Pausa : Desconexão durante Chamada (Hangup Emergência)
    Pausa --> Desconectado : Fechou WebSocket
```

### Eventos Recebidos do Cliente (Navegador)
* **`agent.update_status` (com `status: 'disponivel'`):**
  1. Cria/valida a sala no LiveKit (`sala_agente_${agentId}`).
  2. Gera o token JWT para o agente acessar a sala.
  3. Envia resposta `agent.status_updated` com o token e o nome da sala. O discador ainda **não** adiciona o agente na fila de ociosos até que ele conclua a negociação WebRTC com o LiveKit.
* **`agent.update_status` (com outros status: `pausa`, `offline`, `negociacao`):**
  1. Remove o agente do ZSET `dialer:idle_agents`.
  2. Verifica se havia chamada telefônica ativa vinculada ao agente no Redis (`dialer:active_call_channel:${agentId}`) e executa o Hangup imediato.
  3. Salva o status do agente no PostgreSQL.
* **`agent.ready_for_calls`:**
  * Disparado pelo navegador do agente após ele estabelecer com sucesso a conexão WebRTC com a sala do LiveKit.
  * O discador insere o `agentId` no Redis ZSET `dialer:idle_agents` usando o timestamp atual (`Date.now()`) como peso (garantindo fila FIFO de distribuição de chamadas).
* **`agent.hangup_call`:**
  * Solicita o encerramento da chamada. O discador busca o canal ativo no Redis e envia um comando de `Hangup` via AMI para o Asterisk.

### Eventos de Desconexão (Queda de Internet ou Fechamento de Guia)
Ao detectar o fechamento do socket:
1. O discador remove o agente do ZSET `dialer:idle_agents`.
2. Busca se há um canal de chamada ativo para o agente no Redis (`dialer:active_call_channel:${agentId}`). Se houver, envia o comando `Hangup` via AMI ao Asterisk para evitar que o telefone do cliente continue pendurado na linha.
3. Atualiza o status do agente no banco PostgreSQL para `pausa` com o motivo `"Disconnected (WebSocket)"`.

---

## 5. Estrutura de Chaves no Redis

O Redis é utilizado como banco em memória de alta performance para gerenciar o estado da operação de telefonia em tempo real. Seguem as principais chaves utilizadas:

| Chave Redis | Tipo | Finalidade / Descrição |
| :--- | :--- | :--- |
| `dialer:idle_agents` | **Sorted Set (ZSET)** | Fila de agentes disponíveis. O score é o timestamp de quando o agente ficou livre (FIFO). |
| `dialer:manual_call_info:${agentId}` | **String** | JSON contendo `roomName` e `phone` de uma chamada manual WebRTC iniciada pelo agente. Expira em 10 minutos. |
| `dialer:manual_call_agent:${uniqueId}` | **String** | Mapeamento do Unique ID da chamada no Asterisk para o ID do agente associado àquela chamada manual. |
| `dialer:manual_calls:${uniqueId}` | **Hash** | Mapeia detalhes adicionais (`agentId`, `roomName`, `phone`) de chamadas manuais WebRTC ativas a partir do Unique ID da chamada. |
| `dialer:active_call_channel:${agentId}` | **String** | Registra o nome do canal Asterisk ativo atualmente associado ao agente. Utilizado para controle de Hangup automático. |
| `dialer:predictive_call_agent:${uniqueId}`| **String** | Associa o ID único da ligação preditiva gerada no Asterisk ao ID do agente que atendeu a chamada. |
| `dialer:lead_queue` | **List** | Fila de leads prontos para serem discados pelo motor preditivo. |
| `dialer:dialed_leads` | **Set** | Conjunto contendo IDs dos leads já discados/enfileirados no dia para evitar duplicidade de captação. |
| `dialer:blacklisted_phones` | **Set** | Números de telefones bloqueados para recebimento de ligações. |
| `dialer:lead_cooldown:${leadId}` | **String** | Bloqueio temporário de rediscagem rápida para um lead específico. |
| `dialer:recent_dials` | **Sorted Set (ZSET)** | Histórico de chamadas efetuadas nos últimos 60 segundos. Utilizado na fórmula de pacing do Preditivo. |
| `dialer:active_dialing_channels` | **Set** | Lista de IDs de canais atualmente em processo de discagem/ring. |
| `dialer:dialing_calls:${leadId}` | **Hash** | Cache temporário com detalhes do lead discado (`leadId`, `phone`, `name`, `timestamp`) usado na recuperação de dados do canal. Expira em 45 segundos. |
| `dialer:inflated_success_rate` | **String** | Chave temporária ativada em caso de abandono. Trava a taxa de sucesso calculada em 100% (1.0) para diminuir disparos por 30s. |
| `dialer:recent_debug_logs` | **List** | Fila dos últimos 200 logs de debug e AMI para alimentação instantânea do Console Debug em tempo real. |
| `dialer:stats:${date}:total` | **String (Counter)**| Contador diário de chamadas discadas. |
| `dialer:stats:${date}:answered` | **String (Counter)**| Contador diário de chamadas atendidas. |
| `dialer:stats:${date}:abandoned` | **String (Counter)**| Contador diário de chamadas abandonadas (sem agente). |
| `dialer:stats:${date}:productive` | **String (Counter)**| Contador diário de chamadas produtivas (conectadas a um agente). |

---

## 6. Configurações de Ambiente & Rede de Produção (Stack 40 `omni-dialer`)

O microsserviço `omnichat_dialer` roda como serviço da Stack 40 no Portainer utilizando a rede interna Docker Swarm (`minha_rede`):

* **`LIVEKIT_URL`**: `http://livekit_livekit:7880` (Endereço DNS do Swarm para comunicação entre stacks no formato `<stack>_<servico>`. O discador na Stack 40 conecta-se ao LiveKit na Stack `livekit` via rede privada do Swarm, sem tráfego público ou Traefik).
* **`LIVEKIT_API_KEY` & `LIVEKIT_API_SECRET`**: Credenciais de autenticação JWT de Produção (`omnichat_livekit_key` / `OmniChat_LiveKit_Secret_Key_2026_SecurePass!987`). *Nota: Chaves legado `devkey` / `devkeysecret32characterslongpass123` são estritamente para o ambiente de desenvolvimento local antigo e causam erro 401 se usadas em produção.*
* **`DATABASE_URL`**: String de conexão interna com o PostgreSQL (`postgresql://postgres:...@postgres:5432/omnichat_db`).
* **`REDIS_HOST` & `REDIS_PORT`**: Conexão interna com a instância de cache (`redis:6379`).
* **`DIALER_OMNICHAT_SERVER_URL`**: `http://omnichat_server:3000` (ou `http://server:3000` em ambiente local).
* **`VITALPBX_API_URL` & `AMI_HOST`**: Conexão com o PABX Asterisk (`pbx.creditobr.com.br`).

> [!IMPORTANT]
> **Proibição de Variáveis de Ambiente em Stacks:** Na declaração da Stack 40 (`omni-dialer`), todos os parâmetros devem utilizar **valores diretos/hardcoded** no arquivo `docker-compose.yml` (inclusive `name: minha_rede`), sem utilizar expressões de variáveis dinâmicas `${VAR}`.
