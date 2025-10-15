/**
 * Application Constants
 *
 * Centralized configuration values, limits, and constants used throughout the application.
 * Organized by category for easy maintenance.
 */

// ============ WITHDRAWAL CONSTANTS ============

/**
 * Default withdrawal account private key (deterministic for testing)
 * This should be moved to environment variables in production
 */
export const WITHDRAWAL_ACCOUNT_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as `0x${string}`;

/**
 * Default withdrawal fee rates
 */
export const WITHDRAWAL_FEES = {
  DEFAULT_RELAY_FEE_BPS: BigInt(1500), // 15% fee in basis points
} as const;

/**
 * Gas limits for Account Abstraction operations
 */
export const GAS_LIMITS = {
  PAYMASTER_POST_OP_GAS_LIMIT: 35000n, // Above the 32,000 minimum
} as const;

// ============ ZK CIRCUIT CONSTANTS ============

/**
 * Zero-knowledge proof and circuit parameters
 */
export const SNARK_SCALAR_FIELD = "21888242871839275222246405745257275088548364400416034343698204186575808495617";

// ============ INDEXER CONSTANTS ============

/**
 * GraphQL and indexer configuration
 */
export const INDEXER_FETCH_POLICY = "network-only";

/**
 * Indexer endpoint configuration based on environment
 */
export const INDEXER_CONFIG = {
  ENDPOINT:
    import.meta.env.MODE === "development"
      ? import.meta.env.VITE_INDEXER_URL_DEV || "http://localhost:42069/proxy/graphql"
      : import.meta.env.VITE_INDEXER_URL_PROD ||
        "https://api.thegraph.com/subgraphs/name/shinobi-cash/privacy-pools-v1",
  TOKEN:
    import.meta.env.MODE === "development"
      ? import.meta.env.VITE_INDEXER_TOKEN_DEV
      : import.meta.env.VITE_INDEXER_TOKEN_PROD,
} as const;

/**
 * IPFS configuration
 */
export const IPFS_GATEWAY_URL = "https://gateway.pinata.cloud/ipfs/";

// Deployed contract addresses on Arbitrum Sepolia
export const CONTRACTS = {
  // SimpleShinobiCashPoolPaymaster
  PAYMASTER: "0x336812c6253391CAa0cB86432520E5F72271847B",
  CROSSCHAIN_WITHDRAWAL_PAYMASTER: "0x1375837d4148Cc74bFE1d3D71894A3ECdbEfbD98" as `0x${string}`,

  EXTENTED_INPUT_SETTLER_ESCROW_ADDRESS: "0xcfE8B62927E910b5dfB002e19786302803A49390" as `0x${string}`,
  EXTENTED_OUTPUT_SETTLER_ESCROW_ADDRESS: "0x474e9d905219DF4A47c17Fc23df8f2d486DbC375" as `0x${string}`,
  CROSSCHAIN_INPUT_ORACLE: "0x4cb20f4415d3666e5d92e261de98fc9b7843d036" as `0x${string}`,
  CROSSCHAIN_OUTPUT_ORACLE: "0x4cb20f4415d3666e5d92e261de98fc9b7843d036" as `0x${string}`,
  // Expected smart account for deterministic pattern
  EXPECTED_SMART_ACCOUNT: "0xa3aBDC7f6334CD3EE466A115f30522377787c024",

  // ShinobiCash Pool contracts
  PRIVACY_POOL_ENTRYPOINT: "0x4Fe47d638A54AEd66962d3D66Ca463E1555DC35B",
  ETH_PRIVACY_POOL: "0x4e28495472B5Ed86e198034D0e3Bed50f328A541",

  // ERC-4337 EntryPoint (standard across networks)
  ERC4337_ENTRYPOINT: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
} as const;

export const NETWORK = {
  CHAIN_ID: 421614, // Arbitrum Sepolia
  NAME: "Arbitrum Sepolia",
  RPC_URL: `https://arb-sepolia.g.alchemy.com/v2/${import.meta.env.VITE_ALCHEMY_API_KEY}`,
  EXPLORER_URL: "https://sepolia.arbiscan.io",
} as const;

export const SUPPORTED_CHAINS = {
  ARBITRUM_SEPOLIA: {
    chainId: 421614,
    name: "Arbitrum Sepolia",
    type: 'source' as const,
    rpcUrl: `https://arb-sepolia.g.alchemy.com/v2/${import.meta.env.VITE_ALCHEMY_API_KEY}`,
    explorerUrl: "https://sepolia.arbiscan.io",
  },
  BASE_SEPOLIA: {
    chainId: 84532, 
    name: "Base Sepolia",
    type: 'destination' as const,
    rpcUrl: `https://base-sepolia.g.alchemy.com/v2/${import.meta.env.VITE_ALCHEMY_API_KEY}`,
    explorerUrl: "https://sepolia.basescan.org",
  }
} as const;

export const BUNDLER_URL = `https://api.pimlico.io/v2/421614/rpc?apikey=${import.meta.env.VITE_PIMLICO_API_KEY}`;
