import time
import json
import logging
from typing import Dict, List, Any, Optional
import redis
from config import settings

logger = logging.getLogger("pbx_api.agent_store")

class AgentStore:
    def __init__(self):
        # Local fallback cache
        self._agents: Dict[int, Dict[str, Any]] = {}
        try:
            self._redis = redis.Redis(
                host=settings.REDIS_HOST,
                port=settings.REDIS_PORT,
                password=settings.REDIS_PASSWORD or None,
                decode_responses=True,
                socket_timeout=2.0
            )
        except Exception as e:
            logger.warning(f"Could not initialize Redis client for AgentStore: {e}")
            self._redis = None

    def _get_redis(self):
        if self._redis is None:
            try:
                self._redis = redis.Redis(
                    host=settings.REDIS_HOST,
                    port=settings.REDIS_PORT,
                    password=settings.REDIS_PASSWORD or None,
                    decode_responses=True,
                    socket_timeout=2.0
                )
            except Exception:
                pass
        return self._redis

    def update_agent_status(
        self,
        agent_id: int,
        room_name: str,
        status: str,
        campaign_ids: Optional[List[int]] = None,
        agent_name: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Atualiza o estado de um agente diretamente no Redis e no cache local
        """
        now = time.time()
        agent = self._agents.get(agent_id, {})
        agent.update({
            "agent_id": agent_id,
            "room_name": room_name or agent.get("room_name", f"sala_agente_{agent_id}"),
            "status": status.lower(),
            "campaign_ids": campaign_ids or agent.get("campaign_ids", []),
            "agent_name": agent_name or agent.get("agent_name", f"Agente {agent_id}"),
            "updated_at": now
        })
        self._agents[agent_id] = agent

        r = self._get_redis()
        if r:
            try:
                str_id = str(agent_id)
                if status.lower() in ["idle", "disponivel"]:
                    r.set(f"dialer:agent_webrtc_active:{str_id}", "true", ex=7200)
                    r.zadd("dialer:idle_agents", {str_id: now})
                else:
                    r.zrem("dialer:idle_agents", str_id)
                    r.delete(f"dialer:agent_webrtc_active:{str_id}")
            except Exception as re:
                logger.warning(f"Redis error in update_agent_status: {re}")

        return agent

    def sync_idle_agents(self, idle_agents: List[Dict[str, Any]]) -> int:
        """
        Substitui ou atualiza lista em lote de agentes livres no Redis
        """
        current_time = time.time()
        r = self._get_redis()
        
        for item in idle_agents:
            agent_id = item.get("agent_id")
            if not agent_id:
                continue
            str_id = str(agent_id)
            self._agents[agent_id] = {
                "agent_id": agent_id,
                "room_name": item.get("room_name", f"sala_agente_{agent_id}"),
                "status": "idle",
                "campaign_ids": item.get("campaign_ids", [item.get("campaign_id")] if "campaign_id" in item else []),
                "agent_name": item.get("agent_name", f"Agente {agent_id}"),
                "updated_at": current_time
            }
            if r:
                try:
                    r.set(f"dialer:agent_webrtc_active:{str_id}", "true", ex=7200)
                    r.zadd("dialer:idle_agents", {str_id: current_time})
                except Exception as re:
                    logger.warning(f"Redis error in sync_idle_agents: {re}")

        return len(idle_agents)

    def get_idle_agents(self, campaign_id: Optional[int] = None) -> List[Dict[str, Any]]:
        """
        Retorna a lista de agentes ociosos consultando o Redis ZSET compartilhado
        """
        r = self._get_redis()
        if r:
            try:
                # Recupera todos os IDs do ZSET ordenados por score (FIFO)
                idle_ids = r.zrange("dialer:idle_agents", 0, -1)
                result = []
                for aid_str in idle_ids:
                    try:
                        aid = int(aid_str)
                    except ValueError:
                        continue
                    agent_info = self._agents.get(aid, {
                        "agent_id": aid,
                        "room_name": f"sala_agente_{aid}",
                        "status": "idle",
                        "campaign_ids": [],
                        "agent_name": f"Agente {aid}",
                        "updated_at": time.time()
                    })
                    if campaign_id is not None:
                        if campaign_id in agent_info.get("campaign_ids", []):
                            result.append(agent_info)
                    else:
                        result.append(agent_info)
                return result
            except Exception as re:
                logger.warning(f"Redis error in get_idle_agents, falling back to local memory: {re}")

        # Fallback local
        idles = [a for a in self._agents.values() if a.get("status") in ["idle", "disponivel"]]
        if campaign_id is not None:
            idles = [a for a in idles if campaign_id in a.get("campaign_ids", [])]
        return sorted(idles, key=lambda x: x.get("updated_at", 0))

    def get_all_agents(self) -> List[Dict[str, Any]]:
        return list(self._agents.values())

agent_store = AgentStore()
