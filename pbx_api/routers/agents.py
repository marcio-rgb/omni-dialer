from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
from auth.security import get_current_user
from services.agent_store import agent_store

router = APIRouter(prefix="/api/v1/dialer/agents", tags=["Sincronização de Agentes"])

class AgentStatusPayload(BaseModel):
    agent_id: int = Field(..., description="ID numérico do usuário/operador")
    room_name: Optional[str] = Field(None, description="Nome da sala LiveKit (ex: sala_agente_4)")
    status: str = Field("idle", description="Estado: idle, busy, paused, offline")
    campaign_ids: Optional[List[int]] = Field(default_factory=list, description="IDs das campanhas associadas")
    agent_name: Optional[str] = Field(None, description="Nome do operador")

class AgentSyncPayload(BaseModel):
    timestamp: Optional[int] = None
    idle_agents: List[AgentStatusPayload]

@router.post("/status")
async def update_single_agent_status(
    payload: AgentStatusPayload,
    current_user: str = Depends(get_current_user)
):
    """
    Recebe notificação reativa de mudança de status de um agente (enviado pelo Chat/LiveKit)
    """
    agent = agent_store.update_agent_status(
        agent_id=payload.agent_id,
        room_name=payload.room_name or f"sala_agente_{payload.agent_id}",
        status=payload.status,
        campaign_ids=payload.campaign_ids,
        agent_name=payload.agent_name
    )
    return {
        "success": True,
        "agent": agent
    }

@router.post("/sync")
async def sync_idle_agents_batch(
    payload: AgentSyncPayload,
    current_user: str = Depends(get_current_user)
):
    """
    Sincroniza em lote a lista completa de agentes ociosos (Heartbeat do Chat)
    """
    count = agent_store.sync_idle_agents([a.model_dump() for a in payload.idle_agents])
    return {
        "success": True,
        "synced_count": count
    }

@router.get("/idle", response_model=List[Dict[str, Any]])
async def get_idle_agents(
    campaign_id: Optional[int] = None,
    current_user: str = Depends(get_current_user)
):
    """
    Retorna a lista de agentes atualmente disponíveis/ociosos (usado pelo motor de discagem)
    """
    return agent_store.get_idle_agents(campaign_id=campaign_id)

@router.get("/all", response_model=List[Dict[str, Any]])
async def get_all_agents(current_user: str = Depends(get_current_user)):
    """
    Retorna o status de todos os agentes monitorados
    """
    return agent_store.get_all_agents()
