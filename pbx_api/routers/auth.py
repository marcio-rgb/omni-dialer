from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel
from auth.security import verify_password, create_access_token, get_current_user
from config import settings

router = APIRouter(prefix="/api/v1/auth", tags=["Autenticação"])

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in_minutes: int

class UserInfo(BaseModel):
    username: str
    authenticated: bool

@router.post("/token", response_model=TokenResponse)
async def login_for_access_token(form_data: OAuth2PasswordRequestForm = Depends()):
    if form_data.username != settings.ADMIN_USERNAME or not verify_password(form_data.password, settings.ADMIN_PASSWORD_HASH):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Usuário ou senha incorretos.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    access_token = create_access_token(data={"sub": form_data.username})
    return TokenResponse(
        access_token=access_token,
        token_type="bearer",
        expires_in_minutes=settings.JWT_EXPIRATION_MINUTES
    )

@router.get("/me", response_model=UserInfo)
async def get_current_user_info(current_user: str = Depends(get_current_user)):
    return UserInfo(username=current_user, authenticated=True)
