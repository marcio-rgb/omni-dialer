import time
import re
import logging
from typing import Optional, Any, Dict, List
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from auth.security import get_current_user
from services.ami_client import ami_service
from database import db_manager

logger = logging.getLogger("pbx_api.calls")

router = APIRouter(prefix="/api/v1/calls", tags=["Discagem e Chamadas"])

class ManualCallPayload(BaseModel):
    phone: str = Field(..., description="Número de telefone do cliente de destino")
    roomName: Optional[str] = Field(None, description="Nome da sala LiveKit WebRTC (camelCase)")
    room_name: Optional[str] = Field(None, description="Nome da sala LiveKit WebRTC (snake_case)")
    agentId: Optional[Any] = Field(None, description="ID do atendente (camelCase)")
    agent_id: Optional[Any] = Field(None, description="ID do atendente (snake_case)")
    aiAgentId: Optional[Any] = Field(None, description="ID do agente IA se aplicável")
    trunk: Optional[str] = Field(None, description="Nome do tronco específico para saída")

class HangupPayload(BaseModel):
    channel: Optional[str] = Field(None, description="Nome do canal Asterisk (ex: PJSIP/1127011340-00000001)")
    roomName: Optional[str] = Field(None, description="Nome da sala LiveKit")
    agentId: Optional[Any] = Field(None, description="ID do atendente")

async def _get_active_trunk(preferred_trunk: Optional[str] = None) -> Dict[str, Any]:
    """
    Busca um tronco PJSIP habilitado no banco 'dialer' ou usa um fallback seguro
    """
    try:
        pool = await db_manager.get_dialer_pool()
        if pool:
            async with pool.acquire() as conn:
                if preferred_trunk:
                    row = await conn.fetchrow(
                        """
                        SELECT trunk_name, host, realm, enabled, is_return_trunk
                        FROM sip_trunks
                        WHERE (trunk_name = $1 OR id::text = $1)
                          AND is_return_trunk = false
                        LIMIT 1
                        """,
                        preferred_trunk
                    )
                    if row:
                        return dict(row)

                # Busca o primeiro tronco de saída ativo
                row = await conn.fetchrow(
                    """
                    SELECT trunk_name, host, realm, enabled, is_return_trunk
                    FROM sip_trunks
                    WHERE enabled = true
                      AND is_return_trunk = false
                    ORDER BY id ASC
                    LIMIT 1
                    """
                )
                if row:
                    return dict(row)
    except Exception as e:
        logger.warning(f"Erro ao consultar troncos ativos no banco: {e}")

    # Fallback para o primeiro tronco padrão
    return {
        "trunk_name": preferred_trunk or "1127011340",
        "realm": "metapabx.vivo.net.br",
        "host": "187.50.251.58"
    }

def _clean_phone(raw_phone: str) -> str:
    cleaned = re.sub(r"\D", "", raw_phone)
    # Remove prefixo 55 se o número contiver DDD + 8/9 dígitos (12 ou 13 dígitos)
    if len(cleaned) in (12, 13) and cleaned.startswith("55"):
        cleaned = cleaned[2:]
    return cleaned

@router.post("/manual")
@router.post("/manual-webrtc")
async def initiate_manual_call(
    payload: ManualCallPayload,
    current_user: str = Depends(get_current_user)
):
    """
    Inicia uma chamada manual via AMI conectando o cliente ao tronco SIP e à sala WebRTC LiveKit
    """
    raw_phone = payload.phone
    phone = _clean_phone(raw_phone)
    if not phone or len(phone) < 8:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Número de telefone inválido para discagem"
        )

    agent_id = payload.agentId if payload.agentId is not None else payload.agent_id
    room_name = payload.roomName or payload.room_name or f"sala_agente_{agent_id or 1}"

    trunk_info = await _get_active_trunk(payload.trunk)
    trunk_name = trunk_info.get("trunk_name") or "1127011340"
    realm = trunk_info.get("realm") or "metapabx.vivo.net.br"

    # Canal de saída via dialplan outbound-vivo com pre-dial handler de CallerID/PAI
    channel_dest = f"Local/{phone}@outbound-vivo/n"
    context_dest = "cos-all"
    exten_dest = "9999" # Ramal 9999 em cos-all roteia para LiveKit SIP Trunk

    variables = {
        "AGENT_ROOM": room_name,
        "PHONE": phone,
        "AGENT_ID": str(agent_id or ""),
        "TRUNK_NAME": trunk_name
    }

    action_id = f"manual_{agent_id or 'ext'}_{int(time.time() * 1000)}"

    logger.info(
        f"[ManualCall] Originando chamada para '{phone}' via tronco '{trunk_name}' -> sala '{room_name}'"
    )

    result = await ami_service.originate_call(
        channel=channel_dest,
        context=context_dest,
        exten=exten_dest,
        priority=1,
        variables=variables,
        caller_id=f'"{trunk_name}" <{trunk_name}>',
        timeout=45000,
        action_id=action_id
    )

    return {
        "success": result.get("success", False),
        "status": "originated" if result.get("success") else "failed",
        "phone": phone,
        "room_name": room_name,
        "trunk": trunk_name,
        "action_id": action_id,
        "details": result.get("raw_response", "")
    }

@router.post("/hangup")
async def hangup_call(
    payload: HangupPayload,
    current_user: str = Depends(get_current_user)
):
    """
    Encerra canal ativo no Asterisk
    """
    if payload.channel:
        res = await ami_service.hangup_channel(payload.channel)
        return {"success": True, "result": res}
    return {"success": True, "message": "Nenhum canal ativo informado"}
