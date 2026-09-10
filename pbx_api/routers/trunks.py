from fastapi import APIRouter, HTTPException, Depends, status
from pydantic import BaseModel, Field
from typing import List, Dict, Any, Optional
from auth.security import get_current_user
from database import db_manager
from services.asterisk_conf import asterisk_conf_service
from services.ami_client import ami_service

router = APIRouter(
    prefix="/api/v1/pjsip",
    tags=["PJSIP Trunks"]
)

class TrunkModel(BaseModel):
    id: Optional[str] = None
    trunk_name: str
    provider: Optional[str] = "generic"
    trunk_type: Optional[str] = "registration"
    host: str
    port: Optional[int] = 5060
    transport: Optional[str] = "transport-udp"
    username: Optional[str] = None
    password: Optional[str] = None
    auth_user: Optional[str] = None
    realm: Optional[str] = None
    from_user: Optional[str] = None
    from_domain: Optional[str] = None
    outbound_proxy: Optional[str] = None
    contact_user: Optional[str] = None
    context: Optional[str] = "cos-all"
    codecs: Optional[str] = "opus,alaw,ulaw,g729"
    dtmf_mode: Optional[str] = "rfc4733"
    direct_media: Optional[bool] = False
    force_rport: Optional[bool] = True
    rewrite_contact: Optional[bool] = True
    rtp_symmetric: Optional[bool] = True
    expiration: Optional[int] = 3600
    qualify_frequency: Optional[int] = 60
    max_channels: Optional[int] = 1
    enabled: Optional[bool] = True
    is_return_trunk: Optional[bool] = False
    user_agent: Optional[str] = None

class BatchTrunkModel(BaseModel):
    start_line: int
    end_line: int
    password: str = "1020304050"
    outbound_proxy: str = "187.50.251.58:5060"
    realm: str = "metapabx.vivo.net.br"
    expiration: int = 3600
    codecs: str = "alaw,ulaw"
    context: str = "cos-all"
    provider: str = "vivo"
    max_channels: int = 1
    enabled: bool = True

@router.get("/trunks", response_model=List[Dict[str, Any]])
async def list_trunks(current_user: str = Depends(get_current_user)):
    """
    Retorna todos os troncos SIP cadastrados na base de dados 'dialer' e enriquece com telemetria AMI.
    """
    trunks = await db_manager.get_all_trunks()
    
    # Telemetria do AMI
    registrations = await ami_service.get_registrations()
    reg_map = {r.get("trunk"): r for r in registrations if isinstance(r, dict)}
    
    for t in trunks:
        name = str(t.get("trunk_name") or t.get("id"))
        reg_info = reg_map.get(name) or reg_map.get(f"{name}-reg")
        t["registered"] = reg_info.get("is_registered", False) if reg_info else False
        t["ami_status"] = reg_info.get("status") if reg_info else ("Online (Peering)" if t.get("trunk_type") != "registration" else "Não Registrado")

    return trunks

@router.get("/trunks/{trunk_id}", response_model=Dict[str, Any])
async def get_trunk_details(trunk_id: str, current_user: str = Depends(get_current_user)):
    trunk = await db_manager.get_trunk_by_id(trunk_id)
    if not trunk:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tronco '{trunk_id}' não encontrado no banco dialer."
        )
    return trunk

@router.post("/trunks", response_model=Dict[str, Any], status_code=status.HTTP_201_CREATED)
async def create_or_update_trunk(payload: TrunkModel, current_user: str = Depends(get_current_user)):
    """
    Cadastra ou atualiza as configurações de um tronco no banco 'dialer'.
    """
    data = payload.model_dump(exclude_unset=False)
    saved_trunk = await db_manager.upsert_trunk(data)
    return saved_trunk

@router.post("/trunks/batch", response_model=Dict[str, Any])
async def create_batch_trunks(payload: BatchTrunkModel, current_user: str = Depends(get_current_user)):
    """
    Cria uma faixa de troncos em lote no banco 'dialer'.
    """
    if payload.end_line < payload.start_line:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Linha final não pode ser menor que a linha inicial."
        )

    count = 0
    for num in range(payload.start_line, payload.end_line + 1):
        num_str = str(num)
        trunk_dict = {
            "id": num_str,
            "trunk_name": num_str,
            "provider": payload.provider,
            "trunk_type": "registration",
            "host": payload.realm,
            "port": 5060,
            "transport": "transport-udp",
            "username": num_str,
            "password": payload.password,
            "auth_user": num_str,
            "realm": payload.realm,
            "from_user": num_str,
            "from_domain": payload.realm,
            "outbound_proxy": payload.outbound_proxy,
            "contact_user": num_str,
            "context": payload.context,
            "codecs": payload.codecs,
            "dtmf_mode": "rfc4733",
            "direct_media": False,
            "force_rport": True,
            "rewrite_contact": True,
            "rtp_symmetric": True,
            "expiration": payload.expiration,
            "qualify_frequency": 60,
            "max_channels": payload.max_channels,
            "enabled": payload.enabled,
            "is_return_trunk": False
        }
        await db_manager.upsert_trunk(trunk_dict)
        count += 1

    return {
        "success": True,
        "message": f"Faixa de {count} troncos cadastrada com sucesso no banco dialer.",
        "count": count
    }

@router.patch("/trunks/{trunk_id}/toggle", response_model=Dict[str, Any])
async def toggle_trunk(trunk_id: str, current_user: str = Depends(get_current_user)):
    """
    Alterna o status enabled de um tronco (true <-> false).
    """
    updated = await db_manager.toggle_trunk(trunk_id)
    if not updated:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tronco '{trunk_id}' não encontrado."
        )
    return updated

@router.delete("/trunks/{trunk_id}")
async def delete_trunk(trunk_id: str, current_user: str = Depends(get_current_user)):
    """
    Remove um tronco do banco de dados dialer.
    """
    deleted = await db_manager.delete_trunk(trunk_id)
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tronco '{trunk_id}' não encontrado."
        )
    return {"success": True, "message": f"Tronco '{trunk_id}' removido com sucesso."}

@router.post("/asterisk/apply", response_model=Dict[str, Any])
async def apply_trunks_to_asterisk(current_user: str = Depends(get_current_user)):
    """
    Lê todos os troncos do banco 'dialer', compila os arquivos .conf do Asterisk
    (pjsip_trunks_vivo.conf apenas com enabled=true e pjsip_livekit.conf com o tronco de retorno)
    e executa o reload a quente no Asterisk via AMI.
    """
    all_trunks = await db_manager.get_all_trunks()
    
    # 1. Compila PJSIP conf
    conf_path = asterisk_conf_service.compile_pjsip_conf(all_trunks)
    
    # 2. Executa PJSIP Reload e Dialplan Reload via AMI
    pjsip_reload_res = await ami_service.reload_pjsip()
    dialplan_reload_res = await ami_service.execute_command("dialplan reload")
    
    active_count = len([t for t in all_trunks if t.get("enabled") and not t.get("is_return_trunk")])
    total_channels = sum(int(t.get("max_channels") or 1) for t in all_trunks if t.get("enabled") and not t.get("is_return_trunk"))
    return_trunk_name = next((t.get("trunk_name") for t in all_trunks if t.get("is_return_trunk")), "livekit-sip")

    return {
        "success": True,
        "message": "Configurações aplicadas com sucesso no Asterisk!",
        "conf_file": conf_path,
        "active_trunks_count": active_count,
        "total_active_channels": total_channels,
        "return_trunk": return_trunk_name,
        "pjsip_reload": pjsip_reload_res,
        "dialplan_reload": dialplan_reload_res.strip() if isinstance(dialplan_reload_res, str) else dialplan_reload_res
    }
