import asyncpg
from typing import List, Dict, Any, Optional
from config import settings

class DatabaseManager:
    def __init__(self):
        self._dialer_pool: Optional[asyncpg.Pool] = None
        self._core_pool: Optional[asyncpg.Pool] = None

    async def init_pools(self):
        if not self._dialer_pool:
            try:
                self._dialer_pool = await asyncpg.create_pool(
                    dsn=settings.DATABASE_URL_DIALER,
                    min_size=2,
                    max_size=10,
                    timeout=10.0
                )
                print("[Database] Pool do banco 'dialer' conectado com sucesso.")
            except Exception as e:
                print(f"[Database] Erro ao conectar ao pool 'dialer': {e}")

        if not self._core_pool:
            try:
                self._core_pool = await asyncpg.create_pool(
                    dsn=settings.DATABASE_URL_CORE,
                    min_size=2,
                    max_size=10,
                    timeout=10.0
                )
                print("[Database] Pool do banco 'omnichat_db' conectado com sucesso.")
            except Exception as e:
                print(f"[Database] Erro ao conectar ao pool 'omnichat_db': {e}")

    async def close_pools(self):
        if self._dialer_pool:
            await self._dialer_pool.close()
            self._dialer_pool = None
        if self._core_pool:
            await self._core_pool.close()
            self._core_pool = None

    async def get_dialer_pool(self) -> Optional[asyncpg.Pool]:
        if not self._dialer_pool:
            await self.init_pools()
        return self._dialer_pool

    # --- CRUD SIP_TRUNKS ---

    async def get_all_trunks(self) -> List[Dict[str, Any]]:
        pool = await self.get_dialer_pool()
        if not pool:
            return []
        async with pool.acquire() as conn:
            rows = await conn.fetch("SELECT * FROM sip_trunks ORDER BY is_return_trunk DESC, trunk_name ASC")
            return [dict(r) for r in rows]

    async def get_trunk_by_id(self, trunk_id: str) -> Optional[Dict[str, Any]]:
        pool = await self.get_dialer_pool()
        if not pool:
            return None
        async with pool.acquire() as conn:
            row = await conn.fetchrow("SELECT * FROM sip_trunks WHERE id = $1 OR trunk_name = $1", trunk_id)
            return dict(row) if row else None

    async def upsert_trunk(self, data: Dict[str, Any]) -> Dict[str, Any]:
        pool = await self.get_dialer_pool()
        if not pool:
            raise RuntimeError("Database pool not initialized")
        trunk_id = str(data.get("id") or data.get("trunk_name"))
        trunk_name = str(data.get("trunk_name") or trunk_id)
        
        query = """
            INSERT INTO sip_trunks (
                id, trunk_name, provider, trunk_type, host, port, transport,
                username, password, auth_user, realm, from_user, from_domain,
                outbound_proxy, contact_user, context, codecs, dtmf_mode,
                direct_media, force_rport, rewrite_contact, rtp_symmetric,
                expiration, qualify_frequency, max_channels, enabled, is_return_trunk,
                updated_at
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7,
                $8, $9, $10, $11, $12, $13,
                $14, $15, $16, $17, $18,
                $19, $20, $21, $22,
                $23, $24, $25, $26, $27,
                NOW()
            )
            ON CONFLICT (id) DO UPDATE SET
                trunk_name = EXCLUDED.trunk_name,
                provider = EXCLUDED.provider,
                trunk_type = EXCLUDED.trunk_type,
                host = EXCLUDED.host,
                port = EXCLUDED.port,
                transport = EXCLUDED.transport,
                username = EXCLUDED.username,
                password = EXCLUDED.password,
                auth_user = EXCLUDED.auth_user,
                realm = EXCLUDED.realm,
                from_user = EXCLUDED.from_user,
                from_domain = EXCLUDED.from_domain,
                outbound_proxy = EXCLUDED.outbound_proxy,
                contact_user = EXCLUDED.contact_user,
                context = EXCLUDED.context,
                codecs = EXCLUDED.codecs,
                dtmf_mode = EXCLUDED.dtmf_mode,
                direct_media = EXCLUDED.direct_media,
                force_rport = EXCLUDED.force_rport,
                rewrite_contact = EXCLUDED.rewrite_contact,
                rtp_symmetric = EXCLUDED.rtp_symmetric,
                expiration = EXCLUDED.expiration,
                qualify_frequency = EXCLUDED.qualify_frequency,
                max_channels = EXCLUDED.max_channels,
                enabled = EXCLUDED.enabled,
                is_return_trunk = EXCLUDED.is_return_trunk,
                updated_at = NOW()
            RETURNING *
        """
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                query,
                trunk_id,
                trunk_name,
                data.get("provider", "generic"),
                data.get("trunk_type", "registration"),
                data.get("host", ""),
                int(data.get("port") or 5060),
                data.get("transport", "transport-udp"),
                data.get("username"),
                data.get("password"),
                data.get("auth_user"),
                data.get("realm"),
                data.get("from_user"),
                data.get("from_domain"),
                data.get("outbound_proxy"),
                data.get("contact_user"),
                data.get("context", "cos-all"),
                data.get("codecs", "opus,alaw,ulaw,g729"),
                data.get("dtmf_mode", "rfc4733"),
                bool(data.get("direct_media", False)),
                bool(data.get("force_rport", True)),
                bool(data.get("rewrite_contact", True)),
                bool(data.get("rtp_symmetric", True)),
                int(data.get("expiration") or 3600),
                int(data.get("qualify_frequency") or 60),
                max(1, int(data.get("max_channels") or 1)),
                bool(data.get("enabled", True)),
                bool(data.get("is_return_trunk", False))
            )
            return dict(row) if row else data

    async def delete_trunk(self, trunk_id: str) -> bool:
        pool = await self.get_dialer_pool()
        if not pool:
            return False
        async with pool.acquire() as conn:
            res = await conn.execute("DELETE FROM sip_trunks WHERE id = $1 OR trunk_name = $1", trunk_id)
            return "DELETE 1" in res

    async def toggle_trunk(self, trunk_id: str, enabled: Optional[bool] = None) -> Optional[Dict[str, Any]]:
        pool = await self.get_dialer_pool()
        if not pool:
            return None
        async with pool.acquire() as conn:
            if enabled is None:
                row = await conn.fetchrow(
                    "UPDATE sip_trunks SET enabled = NOT enabled, updated_at = NOW() WHERE id = $1 OR trunk_name = $1 RETURNING *",
                    trunk_id
                )
            else:
                row = await conn.fetchrow(
                    "UPDATE sip_trunks SET enabled = $2, updated_at = NOW() WHERE id = $1 OR trunk_name = $1 RETURNING *",
                    trunk_id, enabled
                )
            return dict(row) if row else None

    # --- SETTINGS TABLE ---

    async def get_all_settings(self) -> Dict[str, str]:
        pool = await self.get_dialer_pool()
        if not pool:
            return {}
        async with pool.acquire() as conn:
            rows = await conn.fetch("SELECT key, value FROM settings")
            return {r["key"]: r["value"] for r in rows}

    async def set_setting(self, key: str, value: str, description: Optional[str] = None):
        pool = await self.get_dialer_pool()
        if not pool:
            return
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO settings (key, value, description, created_at, updated_at)
                VALUES ($1, $2, $3, NOW(), NOW())
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
                """,
                key, str(value), description or ""
            )

db_manager = DatabaseManager()
