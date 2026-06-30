import { MarketState, MarketStrategy, Agent, LogEntry, CustomProposal, InjectedProposalResponse } from "./types";
import { API_CONFIG } from "./config";
import { validateAndFixStrategies } from "./strategy-fallback";

const BASE_URL = API_CONFIG.baseUrl;

export const api = {
    // Market Data
    async getMarketState(): Promise<MarketState> {
        const response = await fetch(`${BASE_URL}/api/market`);
        if (!response.ok) throw new Error("Failed to fetch market state");
        const state = await response.json();
        // Validate and fix strategies with fallback data sources
        if (state.strategies) {
            state.strategies = validateAndFixStrategies(state.strategies);
        }
        return state;
    },

    async getGraduatedStrategies(): Promise<MarketStrategy[]> {
        const response = await fetch(`${BASE_URL}/api/history`);
        if (!response.ok) throw new Error("Failed to fetch history");
        const strategies = await response.json();
        // Validate and fix strategies with fallback data sources
        return validateAndFixStrategies(strategies);
    },

    // Agent Data
    async getAgents(): Promise<Agent[]> {
        const response = await fetch(`${BASE_URL}/api/agents`);
        if (!response.ok) throw new Error("Failed to fetch agents");
        return response.json();
    },

    async getAgentById(id: string): Promise<Agent> {
        const response = await fetch(`${BASE_URL}/api/agents/${id}`);
        if (!response.ok) throw new Error(`Failed to fetch agent ${id}`);
        return response.json();
    },

    // System Logs
    async getLogs(): Promise<LogEntry[]> {
        const response = await fetch(`${BASE_URL}/api/logs`);
        if (!response.ok) throw new Error("Failed to fetch logs");
        return response.json();
    },

    // Administrative Controls
    async initProposals(): Promise<void> {
        const response = await fetch(`${BASE_URL}/api/init/proposals`, { method: "POST" });
        if (!response.ok) throw new Error("Failed to initialize proposals");
    },

    async initAgents(): Promise<void> {
        const response = await fetch(`${BASE_URL}/api/init/agents`, { method: "POST" });
        if (!response.ok) throw new Error("Failed to initialize agents");
    },

    async startTradeLoop(): Promise<void> {
        const response = await fetch(`${BASE_URL}/api/trade/start`, { method: "POST" });
        if (!response.ok) throw new Error("Failed to start trade loop");
    },

    async stopTradeLoop(): Promise<void> {
        const response = await fetch(`${BASE_URL}/api/trade/stop`, { method: "POST" });
        if (!response.ok) throw new Error("Failed to stop trade loop");
    },

    async executeTrades(): Promise<void> {
        const response = await fetch(`${BASE_URL}/api/trade/execute`, { method: "POST" });
        if (!response.ok) throw new Error("Failed to execute trades");
    },

    // Custom Proposal Injection
    async injectProposal(proposal: CustomProposal): Promise<InjectedProposalResponse> {
        const response = await fetch(`${BASE_URL}/api/proposal/inject`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(proposal)
        });
        
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Failed to inject proposal");
        return data;
    }
};
