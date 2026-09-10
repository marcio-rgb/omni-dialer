from fastapi import APIRouter, HTTPException, Depends, status
from typing import Dict, Any, List, Optional
from auth.security import get_current_user

router = APIRouter(
    prefix="/api/v1/pjsip/enumerations",
    tags=["PJSIP Enumerations"]
)

ENUMERATIONS_DATA: Dict[str, List[Dict[str, str]]] = {
    "codecs": [
        {"value": "alaw", "label": "G.711 A-law (alaw - Padrão Brasil)", "description": "Codec PCM 64kbps padrão brasileiro"},
        {"value": "ulaw", "label": "G.711 u-law (ulaw)", "description": "Codec PCM 64kbps padrão internacional"},
        {"value": "opus", "label": "Opus (WebRTC HD)", "description": "Codec HD de banda larga para IA e WebRTC"},
        {"value": "g729", "label": "G.729 (Baixa Banda)", "description": "Codec comprimido de 8kbps"},
        {"value": "g722", "label": "G.722 HD", "description": "Codec de áudio HD 64kbps"},
        {"value": "gsm", "label": "GSM 6.10", "description": "Codec clássico de telefonia móvel"}
    ],
    "transports": [
        {"value": "transport-udp", "label": "UDP (transport-udp)", "description": "Transporte UDP padrão Asterisk"},
        {"value": "transport-tcp", "label": "TCP (transport-tcp)", "description": "Transporte TCP orientado a conexão"},
        {"value": "transport-tls", "label": "TLS (transport-tls)", "description": "Transporte SIP criptografado com TLS"},
        {"value": "transport-ws", "label": "WebSocket (transport-ws)", "description": "Transporte WebSocket para WebRTC"},
        {"value": "transport-wss", "label": "Secure WebSocket (transport-wss)", "description": "Transporte WebSocket Seguro com SSL/TLS"}
    ],
    "trunk_types": [
        {"value": "registration", "label": "Registro SIP (com Usuário e Senha)", "description": "Tronco autenticado com registro ativo na operadora"},
        {"value": "ip_auth", "label": "Autenticação por IP (Peering / Sem Registro)", "description": "Tronco baseado em IP estático sem necessidade de REGISTER"},
        {"value": "livekit_return", "label": "Tronco de Retorno (LiveKit SIP Gateway)", "description": "Tronco de repasse de chamadas para o LiveKit SIP"}
    ],
    "dtmf_modes": [
        {"value": "rfc4733", "label": "RFC 4733 (RTP Out-of-band - Recomendado)", "description": "Dígitos DTMF transmitidos em pacotes RTP dedicados"},
        {"value": "inband", "label": "In-band (Áudio)", "description": "Tons DTMF transmitidos dentro da faixa de áudio de voz"},
        {"value": "info", "label": "SIP INFO", "description": "Sinalização de dígitos via mensagens SIP INFO"},
        {"value": "auto", "label": "Automático", "description": "Negociação automática de modo DTMF"}
    ],
    "contexts": [
        {"value": "cos-all", "label": "cos-all (Padrão OmniChat)", "description": "Contexto padrão de chamadas do sistema"},
        {"value": "cos-all-custom", "label": "cos-all-custom", "description": "Contexto customizado para roteamento avançado"},
        {"value": "from-pstn", "label": "from-pstn (Entrada Operadora)", "description": "Contexto para recebimento de chamadas públicas"},
        {"value": "from-internal", "label": "from-internal (Ramais Internos)", "description": "Contexto de ramais e agentes"}
    ]
}

@router.get("", response_model=Dict[str, List[Dict[str, str]]])
async def get_all_enumerations(current_user: str = Depends(get_current_user)):
    """
    Retorna todas as opções e valores válidos para configuração de telefonia PJSIP.
    """
    return ENUMERATIONS_DATA

@router.get("/{enum_type}", response_model=List[Dict[str, str]])
async def get_enumeration_by_type(enum_type: str, current_user: str = Depends(get_current_user)):
    """
    Retorna os valores permitidos para um tipo de configuração específico
    (ex: codecs, transports, trunk_types, dtmf_modes, contexts).
    """
    normalized_type = enum_type.lower().strip()
    if normalized_type not in ENUMERATIONS_DATA:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tipo de enumeração '{enum_type}' não encontrado. Tipos válidos: {list(ENUMERATIONS_DATA.keys())}"
        )
    return ENUMERATIONS_DATA[normalized_type]
