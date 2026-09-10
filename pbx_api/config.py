import os
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

class Settings(BaseModel):
    # API Server
    HOST: str = os.getenv("PBX_API_HOST", "0.0.0.0")
    PORT: int = int(os.getenv("PBX_API_PORT", "9443"))
    ENV: str = os.getenv("NODE_ENV", "production")
    
    # Security / JWT
    JWT_SECRET: str = os.getenv("PBX_API_JWT_SECRET", "c79f94eb9a694b7e891c338ad7ff6538b71d9d95f87e5a01bcde")
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRATION_MINUTES: int = int(os.getenv("PBX_API_JWT_EXPIRATION_MINUTES", "1440"))
    ADMIN_USERNAME: str = os.getenv("PBX_API_ADMIN_USER", "admin")
    ADMIN_PASSWORD_HASH: str = os.getenv(
        "PBX_API_ADMIN_PASSWORD_HASH",
        # Default bcrypt hash for 'omnichat@admin2026'
        "$2b$12$K8aU.CgqLspxNcrZ4s7qE.9zN0iZkFm2JzU5u9y1FvC4m7jJ5uG.a"
    )
    
    # Database Connections
    DATABASE_URL_DIALER: str = os.getenv(
        "DATABASE_URL_DIALER",
        "postgresql://postgres:ojr6DNM25InIg3qoYI4nbUL5Cx04iCiC@192.168.0.13:5896/dialer?sslmode=disable"
    )
    DATABASE_URL_CORE: str = os.getenv(
        "DATABASE_URL_CORE",
        "postgresql://postgres:ojr6DNM25InIg3qoYI4nbUL5Cx04iCiC@192.168.0.13:5896/omnichat_db?sslmode=disable"
    )

    # Asterisk Integration
    ASTERISK_AMI_HOST: str = os.getenv("ASTERISK_AMI_HOST", os.getenv("AMI_HOST", "127.0.0.1"))
    ASTERISK_AMI_PORT: int = int(os.getenv("ASTERISK_AMI_PORT", os.getenv("AMI_PORT", "5038")))
    ASTERISK_AMI_USER: str = os.getenv("ASTERISK_AMI_USER", os.getenv("AMI_USER", "Omnichat"))
    ASTERISK_AMI_PASS: str = os.getenv("ASTERISK_AMI_PASS", os.getenv("AMI_SECRET", os.getenv("AMI_PASS", "ypnqYP7EHNtYFkqww23243rwew423")))
    ASTERISK_CONF_DIR: str = os.getenv("ASTERISK_CONF_DIR", "/etc/asterisk")
    ASTERISK_SOUNDS_DIR: str = os.getenv("ASTERISK_SOUNDS_DIR", "/var/lib/asterisk/sounds")
    
    # Vosk STT Container
    VOSK_HOST: str = os.getenv("VOSK_HOST", "127.0.0.1")
    VOSK_PORT: int = int(os.getenv("VOSK_PORT", "2700"))
    
    # LiveKit Integration
    LIVEKIT_URL: str = os.getenv("LIVEKIT_URL", "http://192.168.0.13:7880")
    LIVEKIT_API_KEY: str = os.getenv("LIVEKIT_API_KEY", "omnichat_livekit_key")
    LIVEKIT_API_SECRET: str = os.getenv("LIVEKIT_API_SECRET", "OmniChat_LiveKit_Secret_Key_2026_SecurePass!987")
    
    # OmniChat Core VPS
    OMNICHAT_CORE_URL: str = os.getenv("OMNICHAT_CORE_URL", "https://api-omnichat.creditobr.org")
    DIALER_SERVICE_URL: str = os.getenv("DIALER_SERVICE_URL", "http://127.0.0.1:9443")
    
    # Redis Integration
    REDIS_HOST: str = os.getenv("REDIS_HOST", "192.168.0.13")
    REDIS_PORT: int = int(os.getenv("REDIS_PORT", "6381"))
    REDIS_PASSWORD: str = os.getenv("REDIS_PASSWORD", "ojr6DNM25InIg3qoYI4nbUL5Cx04iCiC")

settings = Settings()
