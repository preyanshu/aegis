export interface DataSource {
    id: number;
    name: string;
    endpoint: string;
    ticker: string;
    price: string;
    icon: string;
    exchange: {
        label: string;
        name: string;
        icon: {
            url: string;
            width: number;
            height: number;
            alt: string;
        };
    };
    type: string;
    oracleContract: string;
    group: string;
}

const EXTERNAL_REFLECTOR_TESTNET = "CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63";
const FIAT_REFLECTOR_TESTNET = "CCSSOHTBL3LEWUCBBEB5NJFC2OKFRC74OWEIJIZLRJBGAAU4VMU5NV4W";

const GROUP_STYLES: Record<string, { bg: string; fg: string }> = {
    Crypto: { bg: "#1f1534", fg: "#c084fc" },
    Stable: { bg: "#0d2f28", fg: "#5eead4" },
    FX: { bg: "#172554", fg: "#93c5fd" },
    Commodity: { bg: "#3a2308", fg: "#fbbf24" },
};

function makeIcon(symbol: string, group: string) {
    const style = GROUP_STYLES[group] ?? GROUP_STYLES.Crypto;
    const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
            <rect width="64" height="64" rx="16" fill="${style.bg}"/>
            <text x="32" y="38" text-anchor="middle" font-family="Arial, sans-serif" font-size="20" font-weight="700" fill="${style.fg}">
                ${symbol}
            </text>
        </svg>
    `;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function reflectorSource(
    id: number,
    ticker: string,
    name: string,
    group: string,
    oracleContract: string,
    price: string,
): DataSource {
    return {
        id,
        name,
        endpoint: oracleContract,
        ticker,
        price,
        icon: makeIcon(ticker, group),
        exchange: {
            label: "Oracle",
            name: "Reflector",
            icon: {
                url: makeIcon("R", group),
                width: 64,
                height: 64,
                alt: "Reflector oracle",
            },
        },
        type: group,
        oracleContract,
        group,
    };
}

export const TRUSTED_DATA_SOURCES: DataSource[] = [
    reflectorSource(1001, "BTC", "Bitcoin", "Crypto", EXTERNAL_REFLECTOR_TESTNET, "100000"),
    reflectorSource(1002, "ETH", "Ethereum", "Crypto", EXTERNAL_REFLECTOR_TESTNET, "3000"),
    reflectorSource(1003, "USDT", "Tether", "Stable", EXTERNAL_REFLECTOR_TESTNET, "1"),
    reflectorSource(1004, "XRP", "XRP", "Crypto", EXTERNAL_REFLECTOR_TESTNET, "0.5"),
    reflectorSource(1005, "SOL", "Solana", "Crypto", EXTERNAL_REFLECTOR_TESTNET, "150"),
    reflectorSource(1006, "USDC", "USD Coin", "Stable", EXTERNAL_REFLECTOR_TESTNET, "1"),
    reflectorSource(1007, "ADA", "Cardano", "Crypto", EXTERNAL_REFLECTOR_TESTNET, "0.45"),
    reflectorSource(1008, "AVAX", "Avalanche", "Crypto", EXTERNAL_REFLECTOR_TESTNET, "35"),
    reflectorSource(1009, "DOT", "Polkadot", "Crypto", EXTERNAL_REFLECTOR_TESTNET, "7"),
    reflectorSource(1010, "MATIC", "Polygon", "Crypto", EXTERNAL_REFLECTOR_TESTNET, "0.7"),
    reflectorSource(1011, "LINK", "Chainlink", "Crypto", EXTERNAL_REFLECTOR_TESTNET, "18"),
    reflectorSource(1012, "DAI", "Dai", "Stable", EXTERNAL_REFLECTOR_TESTNET, "1"),
    reflectorSource(1013, "ATOM", "Cosmos", "Crypto", EXTERNAL_REFLECTOR_TESTNET, "8"),
    reflectorSource(1014, "XLM", "Stellar", "Crypto", EXTERNAL_REFLECTOR_TESTNET, "0.12"),
    reflectorSource(1015, "UNI", "Uniswap", "Crypto", EXTERNAL_REFLECTOR_TESTNET, "10"),
    reflectorSource(1016, "EURC", "Euro Coin", "Stable", EXTERNAL_REFLECTOR_TESTNET, "1.08"),
    reflectorSource(1017, "EUR", "Euro", "FX", FIAT_REFLECTOR_TESTNET, "1.08"),
    reflectorSource(1018, "GBP", "British Pound", "FX", FIAT_REFLECTOR_TESTNET, "1.27"),
    reflectorSource(1019, "CHF", "Swiss Franc", "FX", FIAT_REFLECTOR_TESTNET, "1.12"),
    reflectorSource(1020, "CAD", "Canadian Dollar", "FX", FIAT_REFLECTOR_TESTNET, "0.73"),
    reflectorSource(1021, "MXN", "Mexican Peso", "FX", FIAT_REFLECTOR_TESTNET, "0.054"),
    reflectorSource(1022, "ARS", "Argentine Peso", "FX", FIAT_REFLECTOR_TESTNET, "0.0009"),
    reflectorSource(1023, "BRL", "Brazilian Real", "FX", FIAT_REFLECTOR_TESTNET, "0.18"),
    reflectorSource(1024, "THB", "Thai Baht", "FX", FIAT_REFLECTOR_TESTNET, "0.027"),
    reflectorSource(1025, "XAU", "Gold", "Commodity", FIAT_REFLECTOR_TESTNET, "2350"),
];
