import time
from typing import Dict, List, Any, Optional

class AgentStore:
    def __init__(self):
        # agent_id -> agent_dict
        self._agents: Dict[int, Dict[str, Any]] = {}

    def update_agent_status(
        self,
        agent_id: int,
        room_name: str,
        status: str,
        campaign_ids: Optional[List[int]] = None,
        agent_name: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Atualiza o estado de um agente (idle, busy, paused, offline)
        """
        agent = self._agents.get(agent_id, {})
        agent.update({
            "agent_id": agent_id,
            "room_name": room_name or agent.get("room_name", f"sala_agente_{agent_id}"),
            "status": status.lower(),
            "campaign_ids": campaign_ids or agent.get("campaign_ids", []),
            "agent_name": agent_name or agent.get("agent_name", f"Agente {agent_id}"),
            "updated_at": time.time()
        })
        self._agents[agent_id] = agent
        return agent

    def sync_idle_agents(self, idle_agents: List[Dict[str, Any]]) -> int:
        """
        Substitui ou atualiza lista em lote de agentes livres
        """
        current_time = time.time()
        for item in idle_agents:
            agent_id = item.get("agent_id")
            if not agent_id:
                continue
            self._agents[agent_id] = {
                "agent_id": agent_id,
                "room_name": item.get("room_name", f"sala_agente_{agent_id}"),
                "status": "idle",
                "campaign_ids": item.get("campaign_ids", [item.get("campaign_id")] if "campaign_id" in item else []),
                "agent_name": item.get("agent_name", f"Agente {agent_id}"),
                "updated_at": current_time
            }
        return len(idle_agents)

    def get_idle_agents(self, campaign_id: Optional[int] = None) -> List[Dict[str, Any]]:
        idles = []
        for agent in self._agents.values():
            if agent.get("status") == "idle":
                if campaign_id is not None:
                    if campaign_id in agent.get("campaign_ids", []):
                        idles.append(agent)
                else:
                    idles.append(agent)
        # Ordena por quem esta ocioso ha mais tempo (menor updated_at)
        return sorted(idles, key=lambda x: x.get("updated_at", 0))

    def get_all_agents(self) -> List[Dict[str, Any]]:
        return list(self._agents.values())

agent_store = AgentStore()
