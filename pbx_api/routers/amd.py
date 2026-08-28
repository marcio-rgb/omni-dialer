import os
import aiofiles
import socket
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, status
from pydantic import BaseModel, Field
from typing import Dict, Any
from auth.security import get_current_user
from services.asterisk_conf import asterisk_conf_service
from services.ami_client import ami_service
from config import settings

router = APIRouter(prefix="/api/v1/amd", tags=["Triagem AMD & Áudios"])

class AmdConfigModel(BaseModel):
    initial_silence: int = Field(2500, description="Silêncio máximo inicial antes da fala (ms)")
    greeting: int = Field(1500, description="Duração máxima de saudação humana ('Alô' < 1.5s) (ms)")
    after_greeting_silence: int = Field(800, description="Silêncio esperado após saudação do cliente (ms)")
    total_analysis_time: int = Field(3000, description="Tempo total de análise acústica (ms)")
    min_word_length: int = Field(100, description="Duração mínima de voz para palavra (ms)")
    between_words_silence: int = Field(50, description="Silêncio mínimo entre palavras (ms)")
    maximum_number_of_words: int = Field(3, description="Máximo de palavras em saudação")
    silence_threshold: int = Field(256, description="Limiar de decibéis para silêncio")
    auto_reload: bool = Field(True, description="Recarrega o módulo app_amd.so no Asterisk")

@router.get("/config", response_model=Dict[str, Any])
async def get_amd_config(current_user: str = Depends(get_current_user)):
    """
    Retorna os parâmetros de configuração do AMD Interno do Asterisk (amd.conf)
    """
    return asterisk_conf_service.read_amd_config()

@router.put("/config")
async def update_amd_config(
    payload: AmdConfigModel,
    current_user: str = Depends(get_current_user)
):
    """
    Atualiza os parâmetros do amd.conf e recarrega o módulo no Asterisk
    """
    params = payload.model_dump()
    file_path = asterisk_conf_service.write_amd_config(params)
    
    reload_output = ""
    if payload.auto_reload:
        reload_output = await ami_service.reload_amd()
        
    return {
        "success": True,
        "message": "Configuração do AMD atualizada com sucesso.",
        "file_path": file_path,
        "reload_output": reload_output.strip()
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
        "vosk_host": host,
        "vosk_port": port,
        "is_online": is_online,
        "status": "ONLINE" if is_online else "OFFLINE"
    }
