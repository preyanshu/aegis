/**
 * Global Network & Contract Configuration
 * ========================================
 * Single source of truth for all network and contract settings.
 * 
 * To switch networks: Change ACTIVE_NETWORK below
 */

// =============================================================================
// 🔄 ACTIVE NETWORK SELECTOR
// =============================================================================
// Change this to switch the entire app between networks:
// Options: 'mantle-sepolia' | 'arbitrum-sepolia'

export const ACTIVE_NETWORK: 'mantle-sepolia' | 'arbitrum-sepolia' = 'mantle-sepolia';

// =============================================================================
// NETWORK DEFINITIONS
// =============================================================================

type NetworkConfig = {
    chainId: number;
    chainName: string;
    networkSlug: string;
    rpcUrl: string;
    explorerName: string;
    explorerUrl: string;
    nativeCurrency: {
        name: string;
        symbol: string;
        decimals: number;
    };
};

type ContractAddresses = {
    router: `0x${string}`;
};

type GasConfig = {
    gasPriceGwei: string;
};

// -----------------------------------------------------------------------------
// Mantle Sepolia Configuration
// -----------------------------------------------------------------------------
const MANTLE_SEPOLIA_NETWORK: NetworkConfig = {
    chainId: 5003,
    chainName: 'Mantle Sepolia',
    networkSlug: 'mantle-sepolia',
    rpcUrl: 'https://mantle-sepolia.g.alchemy.com/v2/4IPIoe0y3qXgYBrKNZZ44',
    explorerName: 'Mantle Sepolia Explorer',
    explorerUrl: 'https://sepolia.mantlescan.xyz/',
    nativeCurrency: {
        name: 'Mantle',
        symbol: 'MNT',
        decimals: 18,
    },
};

const MANTLE_SEPOLIA_CONTRACTS: ContractAddresses = {
    router: '0x3e7504d1D69F6F19D6596Ecb0712544831F61f18',
};

const MANTLE_SEPOLIA_GAS: GasConfig = {
    gasPriceGwei: '0.02',
};

// -----------------------------------------------------------------------------
// Arbitrum Sepolia Configuration
// -----------------------------------------------------------------------------
const ARBITRUM_SEPOLIA_NETWORK: NetworkConfig = {
    chainId: 421614,
    chainName: 'Arbitrum Sepolia',
    networkSlug: 'arbitrum-sepolia',
    rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
    explorerName: 'Arbiscan Sepolia',
    explorerUrl: 'https://sepolia.arbiscan.io/',
    nativeCurrency: {
        name: 'Sepolia Ether',
        symbol: 'ETH',
        decimals: 18,
    },
    // Additional RPC endpoints (for reference):
    // - WebSocket: wss://sepolia-rollup.arbitrum.io/feed
    // - Sequencer: https://sepolia-rollup-sequencer.arbitrum.io/rpc
};

const ARBITRUM_SEPOLIA_CONTRACTS: ContractAddresses = {
    router: '0x7C2b85130e5c2A51058773e7932245DF9b4A4D34',
};

const ARBITRUM_SEPOLIA_GAS: GasConfig = {
    gasPriceGwei: '0.1',
};

// =============================================================================
// NETWORK REGISTRY
// =============================================================================

const NETWORKS = {
    'mantle-sepolia': {
        network: MANTLE_SEPOLIA_NETWORK,
        contracts: MANTLE_SEPOLIA_CONTRACTS,
        gas: MANTLE_SEPOLIA_GAS,
    },
    'arbitrum-sepolia': {
        network: ARBITRUM_SEPOLIA_NETWORK,
        contracts: ARBITRUM_SEPOLIA_CONTRACTS,
        gas: ARBITRUM_SEPOLIA_GAS,
    },
} as const;

// =============================================================================
// ACTIVE CONFIGURATION EXPORTS
// =============================================================================

const activeConfig = NETWORKS[ACTIVE_NETWORK];

export const NETWORK_CONFIG = activeConfig.network;
export const CONTRACT_ADDRESSES = activeConfig.contracts;
export const GAS_CONFIG = activeConfig.gas;

// =============================================================================
// API CONFIGURATION
// =============================================================================

// Network-specific API URLs
const API_URLS = {
    'mantle-sepolia': 'https://verdict-server-1.onrender.com',
    'arbitrum-sepolia': 'https://verdict-server-2.onrender.com', // Update when Arbitrum backend is deployed
} as const;

export const API_CONFIG = {
    baseUrl: API_URLS[ACTIVE_NETWORK],
} as const;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get explorer URL for a transaction
 */
export const getExplorerTxUrl = (txHash: string): string => {
    return `${NETWORK_CONFIG.explorerUrl}tx/${txHash}`;
};

/**
 * Get explorer URL for an address
 */
export const getExplorerAddressUrl = (address: string): string => {
    return `${NETWORK_CONFIG.explorerUrl}address/${address}`;
};

/**
 * Get all available networks (for UI dropdowns, etc.)
 */
export const getAvailableNetworks = () => {
    return Object.entries(NETWORKS).map(([key, value]) => ({
        id: key,
        name: value.network.chainName,
        chainId: value.network.chainId,
    }));
};

/**
 * Check if current network has contracts deployed
 */
export const isNetworkReady = (): boolean => {
    return CONTRACT_ADDRESSES.router !== '0x0000000000000000000000000000000000000000';
};
