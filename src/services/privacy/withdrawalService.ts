/**
 * Privacy Withdrawal Service
 */

import { CONTRACTS, NETWORK, SNARK_SCALAR_FIELD, WITHDRAWAL_FEES } from "@/config/constants";
import type { Note } from "@/lib/storage/types";
import { WithdrawalProofGenerator } from "@/utils/WithdrawalProofGenerator";
import { encodeAbiParameters, isAddress, keccak256, parseEther } from "viem";

import { getCrosschainWithdrawalSmartAccountClient, getWithdrawalSmartAccountClient } from "@/lib/clients";
import type { ASPData, StateTreeLeaf } from "@/lib/indexer/sdk";
import {
  deriveChangeNullifier,
  deriveChangeSecret,
  deriveDepositNullifier,
  deriveDepositSecret,
  derivedNoteCommitment,
  deriveRefundNullifier,
  deriveRefundSecret,
} from "@/utils/noteDerivation";
import type { SmartAccountClient } from "permissionless";
import type { UserOperation } from "viem/account-abstraction";
import {
  type CrossChainWithdrawalData,
  type WithdrawalData,
  createCrossChainWithdrawalData,
  createWithdrawalData,
  encodeCrossChainWithdrawalCallData,
  encodeRelayCallData,
  executeWithdrawalUserOperation,
  fetchPoolScope,
  formatCrossChainProofForContract,
  formatProofForContract,
  prepareCrossChainWithdrawalUserOperation,
  prepareWithdrawalUserOperation,
} from "../blockchain/contractService";
// Import our new services
import { fetchASPData, fetchStateTreeLeaves } from "../data/indexerService";

// ============ TYPES ============

export interface WithdrawalRequest {
  note: Note;
  withdrawAmount: string;
  recipientAddress: string;
  accountKey: bigint;
  destinationChainId?: number;
}

export interface WithdrawalContext {
  stateTreeLeaves: StateTreeLeaf[];
  aspData: ASPData;
  poolScope: string;
  withdrawalData: readonly [string, string];
  context: bigint;
  newNullifier: bigint;
  newSecret: bigint;
  existingNullifier: bigint;
  existingSecret: bigint;
}
export interface CrosschainWithdrawalContext {
  stateTreeLeaves: StateTreeLeaf[];
  aspData: ASPData;
  poolScope: string;
  withdrawalData: readonly [string, string];
  context: bigint;
  newNullifier: bigint;
  newSecret: bigint;
  refundNullifier: bigint;
  refundSecret: bigint;
  existingNullifier: bigint;
  existingSecret: bigint;
}

export interface WithdrawalProofData {
  proof: {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
  };
  publicSignals: string[];
}

export interface PreparedWithdrawal {
  context: WithdrawalContext | CrosschainWithdrawalContext;
  proofData: WithdrawalProofData;
  userOperation: UserOperation<"0.7">;
  smartAccountClient: SmartAccountClient;
}

// ============ UTILITY FUNCTIONS ============

/**
 * Hash data to BigInt using keccak256 and mod scalar field
 */
function hashToBigInt(data: string): bigint {
  const hash = keccak256(data as `0x${string}`);
  return BigInt(hash) % BigInt(SNARK_SCALAR_FIELD);
}

// ============ CORE WITHDRAWAL FLOW ============

/**
 * Step 1: Fetch all required data in parallel
 */
export async function fetchWithdrawalData(poolAddress: string): Promise<{
  stateTreeLeaves: StateTreeLeaf[];
  aspData: ASPData;
  poolScope: string;
}> {
  // Fetch all required data in parallel for optimal performance
  const [stateTreeLeaves, aspData, poolScope] = await Promise.all([
    fetchStateTreeLeaves(poolAddress),
    fetchASPData(),
    fetchPoolScope(),
  ]);

  return { stateTreeLeaves, aspData, poolScope };
}

/**
 * Step 2: Calculate withdrawal context and generate nullifiers
 */
export async function calculateWithdrawalContext(
  request: WithdrawalRequest,
  withdrawalData: { stateTreeLeaves: StateTreeLeaf[]; aspData: ASPData; poolScope: string },
): Promise<WithdrawalContext> {
  const { note, recipientAddress, accountKey } = request;
  const { stateTreeLeaves, aspData, poolScope } = withdrawalData;

  // Create withdrawal data structure for context calculation
  const withdrawalDataStruct = createWithdrawalData(
    recipientAddress,
    CONTRACTS.PAYMASTER,
    WITHDRAWAL_FEES.DEFAULT_RELAY_FEE_BPS,
  );

  // Calculate context hash
  const context = hashToBigInt(
    encodeAbiParameters(
      [{ type: "tuple", components: [{ type: "address" }, { type: "bytes" }] }, { type: "uint256" }],
      [withdrawalDataStruct, BigInt(poolScope)],
    ),
  );

  // Get account key and generate nullifiers/secrets
  const poolAddress = CONTRACTS.ETH_PRIVACY_POOL;

  // Generate new nullifier and secret for the withdrawal
  const newNullifier = deriveChangeNullifier(accountKey, poolAddress, note.depositIndex, note.changeIndex + 1);
  const newSecret = deriveChangeSecret(accountKey, poolAddress, note.depositIndex, note.changeIndex + 1);

  let existingNullifier: bigint;
  let existingSecret: bigint;
  // Get existing nullifier and secret from the note being spent
  if (note.changeIndex === 0) {
    // Deposit note
    existingNullifier = deriveDepositNullifier(accountKey, note.poolAddress, note.depositIndex);
    existingSecret = deriveDepositSecret(accountKey, note.poolAddress, note.depositIndex);
  } else {
    // Change note
    existingNullifier = deriveChangeNullifier(accountKey, note.poolAddress, note.depositIndex, note.changeIndex);
    existingSecret = deriveChangeSecret(accountKey, note.poolAddress, note.depositIndex, note.changeIndex);
  }

  return {
    stateTreeLeaves,
    aspData,
    poolScope,
    withdrawalData: withdrawalDataStruct,
    context,
    newNullifier,
    newSecret,
    existingNullifier,
    existingSecret,
  };
}

/**
 * Step 3: Generate ZK proof for withdrawal
 */
export async function generateWithdrawalProof(
  request: WithdrawalRequest,
  context: WithdrawalContext,
): Promise<WithdrawalProofData> {
  const { note, withdrawAmount } = request;
  const noteCommitment = derivedNoteCommitment(request.accountKey, note);
  const {
    stateTreeLeaves,
    aspData,
    context: contextHash,
    existingNullifier,
    existingSecret,
    newNullifier,
    newSecret,
  } = context;
  // Generate ZK proof using the circuit
  const prover = new WithdrawalProofGenerator();
  const withdrawalProof = await prover.generateWithdrawalProof({
    existingCommitmentHash: noteCommitment,
    existingValue: BigInt(note.amount),
    existingNullifier: BigInt(existingNullifier),
    existingSecret: BigInt(existingSecret),
    withdrawalValue: parseEther(withdrawAmount),
    context: contextHash,
    label: BigInt(note.label),
    newNullifier: BigInt(newNullifier),
    newSecret: BigInt(newSecret),
    stateTreeCommitments: stateTreeLeaves.map((leaf) => BigInt(leaf.leafValue)),
    aspTreeLabels: aspData.approvalList.map((label: string) => BigInt(label)),
  });

  return withdrawalProof;
}

/**
 * Step 4: Prepare UserOperation for withdrawal
 */
export async function prepareWithdrawalTransaction(
  context: WithdrawalContext,
  proofData: WithdrawalProofData,
): Promise<{ userOperation: UserOperation<"0.7">; smartAccountClient: SmartAccountClient }> {
  const { poolScope, withdrawalData } = context;

  // Format proof for contract compatibility
  const formattedProof = formatProofForContract(proofData.proof, proofData.publicSignals);

  // Create withdrawal data structure
  const withdrawalStruct: WithdrawalData = {
    processooor: withdrawalData[0] as `0x${string}`,
    data: withdrawalData[1] as `0x${string}`,
  };

  // Encode relay call data
  const relayCallData = encodeRelayCallData(withdrawalStruct, formattedProof, BigInt(poolScope));

  // Create smart account client
  const smartAccountClient = await getWithdrawalSmartAccountClient();

  // Prepare UserOperation
  const userOperation = await prepareWithdrawalUserOperation(smartAccountClient, relayCallData);

  return { userOperation, smartAccountClient };
}

/**
 * Step 5: Execute withdrawal transaction
 */
export async function executeWithdrawal(
  smartAccountClient: SmartAccountClient,
  userOperation: UserOperation,
): Promise<string> {
  const transactionHash = await executeWithdrawalUserOperation(smartAccountClient, userOperation);
  return transactionHash;
}

// ============ COMPLETE WITHDRAWAL FLOW ============

/**
 * Complete withdrawal flow - orchestrates all steps
 */
/**
 * Calculate withdrawal context for cross-chain withdrawal
 */
async function calculateCrossChainWithdrawalContext(
  request: WithdrawalRequest,
  withdrawalData: { stateTreeLeaves: StateTreeLeaf[]; aspData: ASPData; poolScope: string }
): Promise<CrosschainWithdrawalContext> {
  const { note, recipientAddress, accountKey } = request;
  const { stateTreeLeaves, aspData, poolScope } = withdrawalData;

  // Create withdrawal data structure for context calculation
  const withdrawalDataStruct = createCrossChainWithdrawalData(
    recipientAddress,
    request.destinationChainId!,
    CONTRACTS.CROSSCHAIN_WITHDRAWAL_PAYMASTER,
    WITHDRAWAL_FEES.DEFAULT_RELAY_FEE_BPS,
  );

  // Calculate context hash
  const context = hashToBigInt(
    encodeAbiParameters(
      [{ type: "tuple", components: [{ type: "address" }, { type: "bytes" }] }, { type: "uint256" }],
      [withdrawalDataStruct, BigInt(poolScope)],
    ),
  );

  // Get account key and generate nullifiers/secrets
  const poolAddress = CONTRACTS.ETH_PRIVACY_POOL;

  // Generate new nullifier and secret for the withdrawal
  const newNullifier = deriveChangeNullifier(accountKey, poolAddress, note.depositIndex, note.changeIndex + 1);
  const newSecret = deriveChangeSecret(accountKey, poolAddress, note.depositIndex, note.changeIndex + 1);

  // Generate refund nullifier and secret for cross-chain withdrawal
  const refundNullifier = deriveRefundNullifier(accountKey, poolAddress, note.depositIndex, note.changeIndex + 1);
  const refundSecret = deriveRefundSecret(accountKey, poolAddress, note.depositIndex, note.changeIndex + 1);

  let existingNullifier: bigint;
  let existingSecret: bigint;
  // Get existing nullifier and secret from the note being spent
  if (note.changeIndex === 0) {
    // Deposit note
    existingNullifier = deriveDepositNullifier(accountKey, note.poolAddress, note.depositIndex);
    existingSecret = deriveDepositSecret(accountKey, note.poolAddress, note.depositIndex);
  } else {
    // Change note
    existingNullifier = deriveChangeNullifier(accountKey, note.poolAddress, note.depositIndex, note.changeIndex);
    existingSecret = deriveChangeSecret(accountKey, note.poolAddress, note.depositIndex, note.changeIndex);
  }

  return {
    stateTreeLeaves,
    aspData,
    poolScope,
    withdrawalData: withdrawalDataStruct,
    context,
    newNullifier,
    newSecret,
    refundNullifier,
    refundSecret,
    existingNullifier,
    existingSecret,
  };
}

/**
 * Generate ZK proof for cross-chain withdrawal
 */
async function generateCrossChainWithdrawalProof(
  request: WithdrawalRequest,
  context: CrosschainWithdrawalContext,
): Promise<WithdrawalProofData> {
  const { note, withdrawAmount } = request;
  const noteCommitment = derivedNoteCommitment(request.accountKey, note);
  const {
    stateTreeLeaves,
    aspData,
    context: contextHash,
    existingNullifier,
    existingSecret,
    newNullifier,
    newSecret,
    refundNullifier,
    refundSecret,
  } = context;
  // Generate ZK proof using the circuit
  const prover = new WithdrawalProofGenerator();
  const withdrawalProof = await prover.generateCrosschainWithdrawalProof({
    existingCommitmentHash: noteCommitment,
    existingValue: BigInt(note.amount),
    existingNullifier: BigInt(existingNullifier),
    existingSecret: BigInt(existingSecret),
    withdrawalValue: parseEther(withdrawAmount),
    context: contextHash,
    label: BigInt(note.label),
    newNullifier: BigInt(newNullifier),
    newSecret: BigInt(newSecret),
    refundNullifier: BigInt(refundNullifier), 
    refundSecret: BigInt(refundSecret),  
    stateTreeCommitments: stateTreeLeaves.map((leaf) => BigInt(leaf.leafValue)),
    aspTreeLabels: aspData.approvalList.map((label: string) => BigInt(label)),
  });

  return withdrawalProof;
}

/**
 * Prepare cross-chain withdrawal transaction
 */
async function prepareCrossChainWithdrawalTransaction(
  request: WithdrawalRequest,
  context: CrosschainWithdrawalContext,
  proofData: WithdrawalProofData,
): Promise<{ userOperation: UserOperation<"0.7">; smartAccountClient: SmartAccountClient }> {
  const { poolScope, withdrawalData } = context;

  // Format proof for contract compatibility
  const formattedProof = formatCrossChainProofForContract(proofData.proof, proofData.publicSignals);

  // Create withdrawal data structure
  const withdrawalStruct: CrossChainWithdrawalData = {
    processooor: withdrawalData[0] as `0x${string}`,
    data: withdrawalData[1] as `0x${string}`,
  };

  // Calculate amounts for OIF
  const withdrawnAmount = BigInt(parseEther(request.withdrawAmount).toString());
  const feeAmount = (withdrawnAmount * WITHDRAWAL_FEES.DEFAULT_RELAY_FEE_BPS) / 10000n;
  const netAmount = withdrawnAmount - feeAmount; // Amount that goes to OIF escrow
  const expectedAmountOnDestinationChain = (netAmount * 99n) / 100n; // For native ETH, no conversion
  // Create intent parameters for OIF
  const currentTime = Math.floor(Date.now() / 1000);
  const intentParams = {
    fillDeadline: currentTime + 3600, // 1 hour to fill
    expires: currentTime + 86400, // 24 hours to expire (must be after fillDeadline)
    inputOracle: CONTRACTS.CROSSCHAIN_INPUT_ORACLE as `0x${string}`,
    inputs: [[0n, netAmount]] as [bigint, bigint][], // Native ETH input with net amount (contract validates this)
    outputs: [{
      oracle: `0x${CONTRACTS.CROSSCHAIN_OUTPUT_ORACLE.slice(2).padStart(64, '0')}` as `0x${string}`, // Oracle as bytes32
      settler: `0x${CONTRACTS.EXTENTED_OUTPUT_SETTLER_ESCROW_ADDRESS.slice(2).padStart(64, '0')}` as `0x${string}`, // Settler as bytes32
      chainId: BigInt(request.destinationChainId!),
      token: `0x${'0'.repeat(64)}` as `0x${string}`, // Native ETH as bytes32 (all zeros)
      amount: expectedAmountOnDestinationChain, // Net amount to recipient (after all fees)
      recipient: `0x${request.recipientAddress.slice(2).padStart(64, '0')}` as `0x${string}`, // Recipient as bytes32
      call: '0x' as `0x${string}`, // No additional callback data
      context: '0x' as `0x${string}`, // No additional callback data
    }]
  };

  // Encode cross-chain withdrawal call data
  const crossChainWithdrawalCallData = encodeCrossChainWithdrawalCallData(
    withdrawalStruct, 
    formattedProof, 
    BigInt(poolScope),
    intentParams
  );

  // Create smart account client
  const smartAccountClient = await getCrosschainWithdrawalSmartAccountClient();

  // Prepare UserOperation
  const userOperation = await prepareCrossChainWithdrawalUserOperation(smartAccountClient, crossChainWithdrawalCallData);

  return { userOperation, smartAccountClient };
}

export async function processWithdrawal(request: WithdrawalRequest): Promise<PreparedWithdrawal> {
  try {
    // Check if this is a cross-chain withdrawal
    const isCrossChain = request.destinationChainId && request.destinationChainId !== NETWORK.CHAIN_ID;
    // Step 1: Fetch all required data
    const withdrawalData = await fetchWithdrawalData(request.note.poolAddress.toLowerCase());

    // Step 2: Calculate context and generate nullifiers (different for cross-chain)
    let context: WithdrawalContext | CrosschainWithdrawalContext;
    let proofData: WithdrawalProofData;
    let userOperation: UserOperation<"0.7">;
    let smartAccountClient: SmartAccountClient;

    if (isCrossChain) {
      // Cross-chain withdrawal flow
      const crossChainContext = await calculateCrossChainWithdrawalContext(request, withdrawalData);
      proofData = await generateCrossChainWithdrawalProof(request, crossChainContext);
      const result = await prepareCrossChainWithdrawalTransaction(request, crossChainContext, proofData);
      userOperation = result.userOperation;
      smartAccountClient = result.smartAccountClient;
      context = crossChainContext;
    } else {
      // Same-chain withdrawal flow
      const sameChainContext = await calculateWithdrawalContext(request, withdrawalData);
      proofData = await generateWithdrawalProof(request, sameChainContext);
      const result = await prepareWithdrawalTransaction(sameChainContext, proofData);
      userOperation = result.userOperation;
      smartAccountClient = result.smartAccountClient;
      context = sameChainContext;
    }

    return {
      context,
      proofData,
      userOperation,
      smartAccountClient,
    };
  } catch (error) {
    console.error("Withdrawal process failed:", error);
    throw error;
  }
}

/**
 * Execute a prepared withdrawal
 */
export async function executePreparedWithdrawal(preparedWithdrawal: PreparedWithdrawal): Promise<string> {
  return executeWithdrawal(preparedWithdrawal.smartAccountClient, preparedWithdrawal.userOperation);
}

// ============ UTILITY FUNCTIONS ============

/**
 * Validate withdrawal request
 */
export function validateWithdrawalRequest(request: WithdrawalRequest): void {
  const { note, withdrawAmount, recipientAddress, accountKey } = request;

  if (!note) {
    throw new Error("Invalid note data");
  }

  if (!withdrawAmount || Number.parseFloat(withdrawAmount) <= 0) {
    throw new Error("Invalid withdrawal amount");
  }

  if (Number.parseFloat(withdrawAmount) > Number.parseFloat(note.amount)) {
    throw new Error("Withdrawal amount exceeds note balance");
  }

  if (!recipientAddress || !isAddress(recipientAddress)) {
    throw new Error("Invalid recipient address");
  }

  if (!accountKey) {
    throw new Error("No account keys provided");
  }
}

/**
 * Calculate withdrawal fees and amounts
 * withdrawAmount: Total amount being withdrawn from note
 * executionFee: Maximum fee taken from withdrawal amount (withdrawAmount * relayFeeBPS / 10000)
 * youReceive: What user actually receives (withdrawAmount - executionFee)
 * remainingInNote: What's left in the note (noteBalance - withdrawAmount)
 */
export function calculateWithdrawalAmounts(withdrawAmount: string) {
  const withdrawAmountNum = Number.parseFloat(withdrawAmount);
  const relayFeeBPS = Number(WITHDRAWAL_FEES.DEFAULT_RELAY_FEE_BPS); // 1000 BPS = 10%

  // Execution fee = withdrawAmount * relayFeeBPS / 10000 (basis points to decimal)
  const executionFee = (withdrawAmountNum * relayFeeBPS) / 10000;

  // User receives withdrawal amount minus execution fee
  const youReceive = withdrawAmountNum - executionFee;

  return {
    withdrawAmount: withdrawAmountNum,
    executionFee,
    youReceive,
    relayFeeBPS,
  };
}
