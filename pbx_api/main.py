import uvicorn
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from config import settings
from database import db_manager
from routers import auth, trunks, enumerations, amd, agents, monitor, calls

@asynccontextmanager
async def lifespan(app: FastAPI):
    print("[Lifespan] Inicializando conexões de banco de dados...")
    await db_manager.init_pools()
    yield
    print("[Lifespan] Encerrando conexões de banco de dados...")
    await db_manager.close_pools()

app = FastAPI(
    title="OmniChat PBX & Dialer Edge API",
    description="API Unificada em Python para Gerenciamento de Troncos PJSIP, Triagem AMD Híbrida e Discador Preditivo",
    version="2.0.0",
    lifespan=lifespan,
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
app.include_router(enumerations.router)
app.include_router(amd.router)
app.include_router(agents.router)
app.include_router(monitor.router)
app.include_router(calls.router)

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
