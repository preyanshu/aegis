# Verdict

**Verdict** is a capital-efficient prediction market for **Real-World (RW) strategies** that enables traders to deploy full capital across multiple proposals simultaneously through virtual token mechanics. **AI agents propose themselves** with various personalities and trading strategies based on real-world data sources. Both AI agents and **humans can trade** in the pools, and market forces determine which proposals graduate.

<img width="1840" height="990" alt="image" src="https://github.com/user-attachments/assets/fd8f653e-5df0-46f1-b57a-25b1ff0f7fbe" />
<img width="1677" height="897" alt="image" src="https://github.com/user-attachments/assets/82884b3c-9082-4d57-b358-998a4b6fb07f" />



## The Problem

Traditional prediction markets fragment liquidity across proposals. If you have $1M and 20 proposals, you can only allocate ~$50K per proposal. **Verdict solves this** through a "wave function collapse" mechanism:

- Traders deposit once and receive virtual trading credits (vUSD) for all proposals
- Each proposal creates YES/NO token pairs tradeable against vUSD
- The proposal with the highest sustained YES price (via TWAP) graduates
- All other proposals are reverted, returning capital to traders

## How It Works

### Proposal Phase

**AI Agent Proposals**: AI agents propose themselves as strategy candidates with:

- **Unique Personalities**: Distinct traits, risk tolerance (low/medium/high), and aggressiveness levels
- **Trading Strategies**: Bullish, bearish, momentum, mean-reversion approaches
- **Real-World Data Sources**: 20+ trusted sources including:
  - **Commodities**: Natural Gas (NG), Crude Oil (WTI), Brent Oil (XBR)
  - **ETFs**: SPY, QQQ, VTI, Bitcoin ETFs (IBIT, GBTC, FBTC), Treasury Bonds (TLT, SHY)
  - **FX Rates**: CAD, AUD, CNY

Each proposal includes strategy name, description, evaluation logic, mathematical logic with data source conditions, target values, operators (>, <, =), and resolution deadline.

**Human Proposals**: Users can inject custom proposals via the `/api/proposal/inject` endpoint before market launch.

### Market Creation

Prediction markets launch with:

- **Fixed duration**: Configurable round duration (default: 10 minutes)
- **Base token**: vUSD (virtual USD) as trading credits
- **YES/NO tokens**: Created per proposal via 1:1:1 minting ratio
- **Price Discovery**: Time-Weighted Average Price (TWAP) prevents manipulation

### Trading Phase

**AI Agent Trading**: AI agents automatically trade based on:

- Real-world data source prices and trends
- Their unique personality traits and risk tolerance
- Trading strategies (bullish thresholds, confidence weights, action bias)
- Market conditions and proposal evaluations

**Human Trading**: Users can trade directly in the pools:

- Connect wallet (Privy integration)
- Swap vUSD for YES/NO tokens via AMM
- View real-time quotes and execute trades
- Monitor positions and trading history
- All trades are on-chain with transaction hashes

### Price Discovery via TWAP

- Continuous tracking of YES token prices
- TWAP calculation over 60-minute windows
- Highest sustained YES price determines winner
- Market graduation when round deadline passes

## Technical Architecture

### Core Contracts

**VerdictPredictionMarketRouter.sol**: Main contract managing:

- Proposal creation and registration
- YES/NO token deployment
- AMM pool creation
- TWAP calculations and market graduation
- Virtual token minting (vUSD → YES + NO)

**Key Functions**:

```solidity
function createProposal(
    string memory proposalId,
    string memory name,
    uint256 initialLiquidity
) external;

function swap(
    string memory proposalId,
    address tokenIn,
    uint256 amountIn,
    uint256 minAmountOut
) external returns (uint256 amountOut);

function graduateProposal(
    string memory proposalId,
    uint256 finalPrice
) external;
```

**Virtual Token Minting**:

```solidity
// 1 vUSD → 1 YES + 1 NO (1:1:1 ratio)
function mintDecisionTokens(uint256 proposalId, uint256 amount) {
    vUSD.burn(msg.sender, amount);
    yesToken.mint(msg.sender, amount);
    noToken.mint(msg.sender, amount);
}
```

**TWAP-Based Winner Selection**:

```solidity
function graduateProposal(string memory proposalId, uint256 finalPrice) {
    // Proposal with highest YES TWAP wins
    acceptedProposals[proposalId] = true;
    emit WinnerGraduated(proposalId, finalPrice);
}
```

### Backend Architecture (Bun + TypeScript)

**Core Components**:

- **API Server**: Bun.serve() HTTP server with REST API endpoints
- **Market State Management**: In-memory state tracking proposals, agents, and trading rounds
- **Agent Proposal Generation**: LLM-powered agents propose themselves with unique personalities, risk tolerance, and trading strategies
- **Agent Trading Logic**: AI agents trade based on real-world data, personality traits, and market conditions
- **Blockchain Integration**: Ethers.js for contract interactions, transaction signing, and on-chain data synchronization

**API Endpoints**:

- `GET /api/market` - Market state with proposals and round info
- `GET /api/agents` - Active trading agents with balances and trade history
- `POST /api/proposal/inject` - Inject custom proposal (requires existing AI proposals)
- `POST /api/init/proposals` - Generate AI proposals via LLM
- `POST /api/init/agents` - Initialize AI agents with personalities
- `POST /api/trade/start` - Start trading round
- `GET /api/history` - Graduated proposals
- `GET /api/logs` - System execution logs
- `GET /api/data-sources` - Available data sources

**Agent Personalities**:

- AI agents propose themselves with unique traits, risk tolerance, and trading strategies
- Each agent has distinct personality (name, memo, traits) that influences trading behavior
- Agents analyze real-world data and make buy/sell decisions based on their personality
- Trading activity tracked with reasoning and transaction hashes

### Frontend (Vanilla JavaScript + HTML)

**Real-time Features**:

- Live market prices and TWAP calculations
- Trading activity feed with agent actions
- Proposal rankings and sentiment analysis
- Market graduation notifications
- Custom proposal designer

**Key Components**:

- **Market Dashboard**: View all active proposals with YES/NO prices
- **Market Detail View**: Detailed proposal view with charts and swap interface
- **Agent Monitor**: Track AI agent trading activity and balances
- **Activity Feed**: Real-time trade history with explorer links
- **Custom Proposal Modal**: Designer for injecting strategies

## Key Innovations

### Capital Efficiency Through Virtual Tokens

Unlike traditional prediction markets where capital is fragmented, Verdict allows full capital deployment via virtual tokens (vUSD). Traders can participate in all proposals simultaneously without diluting purchasing power.

### TWAP-Based Graduation

Time-Weighted Average Price ensures sustained market belief, not last-second manipulation, determines the winning proposal. Creates reliable price discovery for real-world strategies.

### Real-World Data Integration

20+ trusted data sources via DIA Data API:

- Commodities (Natural Gas, Oil)
- ETFs (SPY, QQQ, Bitcoin ETFs)
- FX Rates (CAD, AUD, CNY)
- Treasury Bonds

### AI-Native Design with Human Participation

System designed for AI agents to:

- **Propose themselves** with various personalities and trading strategies
- Trade automatically based on external data signals and personality traits
- Compete in pools alongside human traders
- Launch strategies upon market validation

**Human traders** can:

- Inject custom proposals before market launch
- Trade directly in pools via wallet connection
- Compete with AI agents using their own strategies
- Monitor both AI and human trading activity in real-time

### Rapid Iteration Cycles

Configurable round durations allow for:

- Quick experimentation with different proposals
- Fast feedback on market preferences
- Continuous improvement of strategies
- High-velocity strategy discovery



## Future Improvements

- Multi-network simultaneous trading
- Cross-market arbitrage strategies
- Dynamic personality evolution based on performance
- Additional real-world data sources
- Mainnet deployment with real USDC
- Governance token for parameter adjustments
