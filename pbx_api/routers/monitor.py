from fastapi import APIRouter, Depends
from typing import Dict, Any
from auth.security import get_current_user
from services.ami_client import ami_service
from services.agent_store import agent_store

router = APIRouter(prefix="/api/v1/monitor", tags=["Monitoramento & Operações"])

@router.get("/overview", response_model=Dict[str, Any])
async def get_system_overview(current_user: str = Depends(get_current_user)):
    """
    Retorna o panorama operacional em tempo real do PBX, Canais e Agentes
    """
    registrations = await ami_service.get_registrations()
    channels_info = await ami_service.get_channels_summary()
    idle_agents = agent_store.get_idle_agents()
    
    total_reg = sum(1 for r in registrations if r.get("is_registered"))
    total_rej = sum(1 for r in registrations if not r.get("is_registered"))

    return {
        "pjsip": {
            "total_configured": len(registrations),
            "total_registered": total_reg,
            "total_rejected": total_rej,
            "healthy": (total_reg > 0 and total_rej == 0)
        },
        "channels": {
            "active_channels": channels_info.get("active_channels", 0),
            "active_calls": channels_info.get("active_calls", 0)
        },
        "agents": {
            "total_idle": len(idle_agents),
            "idle_list": [a.get("agent_name", a.get("agent_id")) for a in idle_agents]
        }
    }

@router.post("/asterisk/reload")
async def reload_all_asterisk(current_user: str = Depends(get_current_user)):
    """
    Executa recarga completa de PJSIP, Dialplan e AMD no Asterisk
    """
    out_pjsip = await ami_service.reload_pjsip()
    out_dialplan = await ami_service.reload_dialplan()
    out_amd = await ami_service.reload_amd()

    return {
        "success": True,
        "results": {
            "pjsip": out_pjsip.strip(),
            "dialplan": out_dialplan.strip(),
            "amd": out_amd.strip()
        }
    }
