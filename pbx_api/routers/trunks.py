from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from typing import List, Dict, Any, Optional
from auth.security import get_current_user
from services.asterisk_conf import asterisk_conf_service
from services.ami_client import ami_service

router = APIRouter(prefix="/api/v1/pjsip/trunks", tags=["Troncos PJSIP Vivo"])

class TrunkBatchConfigRequest(BaseModel):
    start_line: int = Field(1127011338, description="Primeiro número da faixa (ex: 1127011338)")
    end_line: int = Field(1127011397, description="Último número da faixa (ex: 1127011397)")
    password: str = Field("1020304050", description="Senha comum definida no portal da Vivo (Softphone e Hardphone)")
    proxy: str = Field("187.50.251.58:5060", description="IP e porta do SBC da Vivo")
    realm: str = Field("metapabx.vivo.net.br", description="Domínio SIP da Vivo")
    expiration: int = Field(3600, description="Tempo de registro em segundos (Vivo exige 3600)")
    codecs: str = Field("alaw,ulaw", description="Codecs permitidos")
    context: str = Field("cos-all", description="Contexto de entrada padrão")
    auto_reload: bool = Field(True, description="Recarrega o módulo PJSIP no Asterisk automaticamente após salvar")

class TrunkStatusItem(BaseModel):
    trunk: str
    server_uri: str
    auth: str
    status: str
    expiration_info: str
    is_registered: bool

class TrunksSummaryResponse(BaseModel):
    total_configured: int
    total_registered: int
    total_rejected: int
    trunks: List[TrunkStatusItem]

@router.get("", response_model=TrunksSummaryResponse)
async def list_trunks(current_user: str = Depends(get_current_user)):
    """
    Retorna o status em tempo real de todos os troncos registrados no Asterisk
    """
    registrations = await ami_service.get_registrations()
    
    total_reg = sum(1 for r in registrations if r.get("is_registered"))
    total_rej = sum(1 for r in registrations if not r.get("is_registered"))
    
    return TrunksSummaryResponse(
        total_configured=len(registrations),
        total_registered=total_reg,
        total_rejected=total_rej,
        trunks=[TrunkStatusItem(**r) for r in registrations]
    )

@router.post("/batch")
async def configure_trunks_batch(
    payload: TrunkBatchConfigRequest,
    current_user: str = Depends(get_current_user)
):
    """
    Configura em lote uma faixa inteira de troncos PJSIP da Vivo (ex: 60 linhas)
    """
    if payload.end_line < payload.start_line:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A linha final deve ser maior ou igual à linha inicial."
        )
    
    total_lines = payload.end_line - payload.start_line + 1
    if total_lines > 500:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="O lote máximo permitido é de 500 linhas por requisição."
        )

    file_path = asterisk_conf_service.generate_pjsip_trunks_conf(
        start_line=payload.start_line,
        end_line=payload.end_line,
        password=payload.password,
        proxy=payload.proxy,
        realm=payload.realm,
        expiration=payload.expiration,
        codecs=payload.codecs,
        context=payload.context
    )

    reload_output = ""
    if payload.auto_reload:
        reload_output = await ami_service.reload_pjsip()

    return {
        "success": True,
        "message": f"Configuração gerada com sucesso para {total_lines} troncos.",
        "file_path": file_path,
        "reload_output": reload_output.strip()
    }

@router.post("/reload")
async def reload_trunks(current_user: str = Depends(get_current_user)):
    """
    Recarrega imediatamente o módulo PJSIP no Asterisk
    """
    output = await ami_service.reload_pjsip()
    return {
        "success": True,
        "output": output.strip()
    }
