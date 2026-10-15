// 局域网花名册：静态注册各机器 agent 端点，提供查询
import type { AgentCard } from "@mac/sdk";

export class Registry {
  private agents = new Map<string, AgentCard>();

  register(card: AgentCard): void {
    this.agents.set(card.name, card);
  }

  get(name: string): AgentCard | undefined {
    return this.agents.get(name);
  }

  list(): AgentCard[] {
    return [...this.agents.values()];
  }
}
