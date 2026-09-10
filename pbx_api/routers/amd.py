import os
import aiofiles
import socket
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, status
from pydantic import BaseModel, Field
from typing import Dict, Any, Optional
from auth.security import get_current_user
from database import db_manager
from services.asterisk_conf import asterisk_conf_service
from services.ami_client import ami_service
from config import settings

router = APIRouter(prefix="/api/v1/amd", tags=["Triagem AMD & Áudios"])

class AmdConfigModel(BaseModel):
    amd_initial_silence: int = Field(2500, description="Silêncio máximo inicial antes da fala (ms)")
    amd_greeting: int = Field(1500, description="Duração máxima de saudação humana (ms)")
    amd_after_greeting_silence: int = Field(800, description="Silêncio esperado após saudação do cliente (ms)")
    amd_total_analysis_time: int = Field(3000, description="Tempo total de análise acústica (ms)")
    amd_min_word_length: int = Field(100, description="Duração mínima de voz para palavra (ms)")
    amd_between_words_silence: int = Field(50, description="Silêncio mínimo entre palavras (ms)")
    amd_maximum_number_of_words: int = Field(3, description="Máximo de palavras em saudação")
    amd_silence_threshold: int = Field(256, description="Limiar de decibéis para silêncio")
    vosk_server_url: Optional[str] = Field("ws://127.0.0.1:2700", description="URL do WebSocket Vosk STT")
    vosk_max_duration_sec: Optional[float] = Field(3.5, description="Tempo máximo de análise Vosk")
    vosk_voicemail_keywords: Optional[str] = Field(None, description="Palavras-chave de caixa postal")
    vosk_human_keywords: Optional[str] = Field(None, description="Palavras-chave humanas")
    dialer_use_vosk_amd: Optional[bool] = Field(True, description="AMD para discador humano")
    dialer_ai_use_vosk_amd: Optional[bool] = Field(True, description="AMD para discador IA")
    auto_reload: Optional[bool] = Field(True, description="Recarrega o módulo app_amd.so no Asterisk")

@router.get("/config", response_model=Dict[str, Any])
async def get_amd_config(current_user: str = Depends(get_current_user)):
    """
    Retorna os parâmetros de configuração do AMD e Vosk da base 'dialer'.
    """
    all_settings = await db_manager.get_all_settings()
    return {
        "amd_initial_silence": int(all_settings.get("amd_initial_silence", 2500)),
        "amd_greeting": int(all_settings.get("amd_greeting", 1500)),
        "amd_after_greeting_silence": int(all_settings.get("amd_after_greeting_silence", 800)),
        "amd_total_analysis_time": int(all_settings.get("amd_total_analysis_time", 3000)),
        "amd_min_word_length": int(all_settings.get("amd_min_word_length", 100)),
        "amd_between_words_silence": int(all_settings.get("amd_between_words_silence", 50)),
        "amd_maximum_number_of_words": int(all_settings.get("amd_maximum_number_of_words", 3)),
        "amd_silence_threshold": int(all_settings.get("amd_silence_threshold", 256)),
        "vosk_server_url": all_settings.get("vosk_server_url", "ws://127.0.0.1:2700"),
        "vosk_max_duration_sec": float(all_settings.get("vosk_max_duration_sec", 3.5)),
        "vosk_voicemail_keywords": all_settings.get("vosk_voicemail_keywords", ""),
        "vosk_human_keywords": all_settings.get("vosk_human_keywords", ""),
        "dialer_use_vosk_amd": all_settings.get("dialer_use_vosk_amd", "true") == "true",
        "dialer_ai_use_vosk_amd": all_settings.get("dialer_ai_use_vosk_amd", "true") == "true"
    }

@router.put("/config")
async def update_amd_config(
    payload: AmdConfigModel,
    current_user: str = Depends(get_current_user)
):
    """
    Atualiza os parâmetros do AMD e Vosk no banco dialer, regera amd.conf e recarrega o Asterisk.
    """
    data = payload.model_dump()
    for k, v in data.items():
        if k != "auto_reload" and v is not None:
            await db_manager.set_setting(k, str(v).lower() if isinstance(v, bool) else str(v))

    # Regera amd.conf
    file_path = asterisk_conf_service.compile_amd_conf(data)
    
    reload_output = ""
    if payload.auto_reload:
        reload_output = await ami_service.reload_amd()
        
    return {
        "success": True,
        "message": "Configuração do AMD e Vosk atualizada com sucesso.",
        "file_path": file_path,
        "reload_output": str(reload_output).strip()
    }

@router.post("/stimulus/alo")
async def upload_stimulus_audio(
    file: UploadFile = File(...),
    current_user: str = Depends(get_current_user)
):
    """
    Faz o upload e substituição do áudio de estímulo (alo.wav) para /var/lib/asterisk/sounds/custom/alo.wav
    """
    if not file.filename.lower().endswith(".wav"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="O arquivo deve estar no formato WAV (PCM 16-bit Mono 8000Hz)."
        )

    target_dir = os.path.join(settings.ASTERISK_SOUNDS_DIR, "custom")
    os.makedirs(target_dir, exist_ok=True)
    target_path = os.path.join(target_dir, "alo.wav")

    async with aiofiles.open(target_path, "wb") as out_file:
        content = await file.read()
        await out_file.write(content)

    return {
        "success": True,
        "message": "Áudio de estímulo alo.wav atualizado com sucesso.",
        "size_bytes": len(content),
        "target_path": target_path
    }

@router.get("/vosk/health")
async def check_vosk_health(current_user: str = Depends(get_current_user)):
    """
    Verifica a conectividade do servidor Vosk STT (porta 2700)
    """
    host = settings.VOSK_HOST
    port = settings.VOSK_PORT
    is_online = False
    
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(2.0)
        result = sock.connect_ex((host, port))
        is_online = (result == 0)
        sock.close()
    except Exception:
        is_online = False

    return {
        "host": host,
        "port": port,
        "status": "online" if is_online else "offline",
        "message": "Servidor Vosk STT operacional" if is_online else "Não foi possível conectar ao servidor Vosk STT"
    }
