import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from config import settings
from routers import auth, trunks, amd, agents, monitor

app = FastAPI(
    title="OmniChat PBX & Dialer Edge API",
    description="API de Gerenciamento de Troncos PJSIP Vivo, Triagem AMD Híbrida e Sincronização de Agentes do Ecossistema OmniChat",
    version="2.0.0",
    docs_url="/docs",
    redoc_url="/redoc"
)

# CORS Middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include Routers
app.include_router(auth.router)
app.include_router(trunks.router)
app.include_router(amd.router)
app.include_router(agents.router)
app.include_router(monitor.router)

@app.get("/", tags=["Status"])
async def root():
    return {
        "service": "OmniChat PBX & Dialer Edge API",
        "version": "2.0.0",
        "status": "ONLINE",
        "docs": "/docs"
    }

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=(settings.ENV == "development")
    )
