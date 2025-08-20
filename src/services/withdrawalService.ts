/**
 * Withdrawal Service
 * 
 * Orchestrates the complete privacy pool withdrawal flow including:
 * - Data fetching from indexer and contracts
 * - Context calculation and nullifier generation
 * - ZK proof generation
 * - UserOperation preparation and execution
 */

import { keccak256, parseEther, encodeAbiParameters, isAddress } from 'viem';
import { SNARK_SCALAR_FIELD, WITHDRAWAL_FEES, CONTRACTS } from '../config/constants';
import { DiscoveredNote, noteCache } from '../lib/noteCache';
import { deriveNullifier, deriveSecret } from '../hooks/useDepositCommitment';
import { restoreFromMnemonic } from '../utils/crypto';
import { WithdrawalProofGenerator } from '../utils/WithdrawalProofGenerator';

// Import our new services
import { 
  fetchStateTreeLeaves, 
  fetchASPData,
  type StateTreeLeaf,
  type ASPData 
} from './queryService';
import { 
  fetchPoolScope,
  createWithdrawalData,
  formatProofForContract,
  encodeRelayCallData,
  createWithdrawalSmartAccountClient,
  prepareWithdrawalUserOperation,
  executeWithdrawalUserOperation,
  type WithdrawalData,
} from './contractService';

// ============ TYPES ============

export interface WithdrawalRequest {
  noteData: DiscoveredNote;
  withdrawAmount: string;
  recipientAddress: string;
  accountKeys: {
    mnemonic?: string;
    privateKey?: string;
  };
}

export interface WithdrawalContext {
  stateTreeLeaves: StateTreeLeaf[];
  aspData: ASPData;
  poolScope: string;
  withdrawalData: readonly [string, string];
  context: bigint;
  newNullifier: string;
  newSecret: string;
  existingNullifier: string;
  existingSecret: string;
  nextNoteIndex: number;
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
  context: WithdrawalContext;
  proofData: WithdrawalProofData;
  userOperation: any;
  smartAccountClient: any;
}

// ============ UTILITY FUNCTIONS ============

/**
 * Hash data to BigInt using keccak256 and mod scalar field
 */
function hashToBigInt(data: string): bigint {
  const hash = keccak256(data as `0x${string}`);
  return BigInt(hash) % BigInt(SNARK_SCALAR_FIELD);
}

/**
 * Get account key from mnemonic or private key
 */
function getAccountKey(accountKeys: { mnemonic?: string; privateKey?: string }): string {
  if (accountKeys.privateKey) {
    return accountKeys.privateKey;
  } else if (accountKeys.mnemonic) {
    const mnemonicArray = Array.isArray(accountKeys.mnemonic) 
      ? accountKeys.mnemonic 
      : accountKeys.mnemonic.split(' ');
    const restoredKeys = restoreFromMnemonic(mnemonicArray);
    return restoredKeys.privateKey;
  } else {
    throw new Error('No account key available for nullifier generation');
  }
}

// ============ CORE WITHDRAWAL FLOW ============

/**
 * Step 1: Fetch all required data in parallel
 */
export async function fetchWithdrawalData(): Promise<{
  stateTreeLeaves: StateTreeLeaf[];
  aspData: ASPData;
  poolScope: string;
}> {
  console.log('📊 Step 1: Fetching withdrawal data...');
  
  // Fetch all required data in parallel for optimal performance
  const [stateTreeLeaves, aspData, poolScope] = await Promise.all([
    fetchStateTreeLeaves(),
    fetchASPData(),
    fetchPoolScope()
  ]);
  
  console.log('✅ All withdrawal data fetched:', {
    stateTreeLeaves: stateTreeLeaves.length,
    approvedLabels: aspData.approvedLabels.length,
    aspRoot: aspData.aspRoot,
    poolScope
  });
  
  return { stateTreeLeaves, aspData, poolScope };
}

/**
 * Step 2: Calculate withdrawal context and generate nullifiers
 */
export async function calculateWithdrawalContext(
  request: WithdrawalRequest,
  withdrawalData: { stateTreeLeaves: StateTreeLeaf[]; aspData: ASPData; poolScope: string }
): Promise<WithdrawalContext> {
  console.log('🔐 Step 2: Calculating withdrawal context...');
  
  const { noteData, recipientAddress, accountKeys } = request;
  const { stateTreeLeaves, aspData, poolScope } = withdrawalData;
  
  // Create withdrawal data structure for context calculation
  const withdrawalDataStruct = createWithdrawalData(
    recipientAddress,
    CONTRACTS.PAYMASTER,
    WITHDRAWAL_FEES.DEFAULT_RELAY_FEE_BPS
  );
  
  // Calculate context hash
  const context = hashToBigInt(
    encodeAbiParameters(
      [
        { type: "tuple", components: [{ type: "address" }, { type: "bytes" }] }, 
        { type: "uint256" }
      ], 
      [withdrawalDataStruct, BigInt(poolScope)]
    )
  );
  
  console.log(`  Context hash: ${context}`);
  
  // Get account key and generate nullifiers/secrets
  const accountKey = getAccountKey(accountKeys);
  const poolAddress = CONTRACTS.ETH_PRIVACY_POOL;
  
  // Get next available note index (last used + 1)
  const nextNoteIndex = await noteCache.getNextNoteIndex(accountKey, poolAddress);
  console.log(`  Next note index: ${nextNoteIndex}`);
  
  // Generate new nullifier and secret for the withdrawal
  const newNullifier = deriveNullifier(accountKey, poolAddress, nextNoteIndex);
  const newSecret = deriveSecret(accountKey, poolAddress, nextNoteIndex);
  
  // Get existing nullifier and secret from the note being spent
  const existingNullifier = deriveNullifier(accountKey, poolAddress, noteData.noteIndex);
  const existingSecret = deriveSecret(accountKey, poolAddress, noteData.noteIndex);
  
  console.log(`  New nullifier: ${newNullifier}`);
  console.log(`  New secret: ${newSecret}`);
  
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
    nextNoteIndex,
  };
}

/**
 * Step 3: Generate ZK proof for withdrawal
 */
export async function generateWithdrawalProof(
  request: WithdrawalRequest,
  context: WithdrawalContext
): Promise<WithdrawalProofData> {
  console.log('🔐 Step 3: Generating ZK proof...');
  
  const { noteData, withdrawAmount } = request;
  const {
    stateTreeLeaves,
    aspData,
    context: contextHash,
    existingNullifier,
    existingSecret,
    newNullifier,
    newSecret
  } = context;
  
  // Generate ZK proof using the circuit
  const prover = new WithdrawalProofGenerator();
  const withdrawalProof = await prover.generateWithdrawalProof({
    existingCommitmentHash: BigInt(noteData.commitment),
    existingValue: parseEther(noteData.amount),
    existingNullifier: BigInt(existingNullifier),
    existingSecret: BigInt(existingSecret),
    withdrawalValue: parseEther(withdrawAmount),
    context: contextHash,
    label: BigInt(noteData.label),
    newNullifier: BigInt(newNullifier),
    newSecret: BigInt(newSecret),
    stateTreeCommitments: stateTreeLeaves.map(leaf => BigInt(leaf.leafValue)),
    aspTreeLabels: aspData.approvedLabels.map(label => BigInt(label)),
  });
  
  console.log('✅ ZK proof generated successfully');
  
  return withdrawalProof;
}

/**
 * Step 4: Prepare UserOperation for withdrawal
 */
export async function prepareWithdrawalTransaction(
  context: WithdrawalContext,
  proofData: WithdrawalProofData
): Promise<{ userOperation: any; smartAccountClient: any }> {
  console.log('📤 Step 4: Preparing withdrawal transaction...');
  
  const { poolScope, withdrawalData } = context;
  
  // Format proof for contract compatibility
  const formattedProof = formatProofForContract(proofData.proof, proofData.publicSignals);
  
  // Create withdrawal data structure
  const withdrawalStruct: WithdrawalData = {
    processooor: withdrawalData[0] as `0x${string}`,
    data: withdrawalData[1] as `0x${string}`,
  };
  
  // Encode relay call data
  const relayCallData = encodeRelayCallData(
    withdrawalStruct,
    formattedProof,
    BigInt(poolScope)
  );
  
  // Create smart account client
  const smartAccountClient = await createWithdrawalSmartAccountClient();
  
  // Prepare UserOperation
  const userOperation = await prepareWithdrawalUserOperation(
    smartAccountClient,
    relayCallData
  );
  
  console.log('✅ Withdrawal transaction prepared');
  console.log(`  UserOperation prepared for account: ${smartAccountClient.account.address}`);
  
  return { userOperation, smartAccountClient };
}

/**
 * Step 5: Execute withdrawal transaction
 */
export async function executeWithdrawal(
  smartAccountClient: any,
  userOperation: any
): Promise<string> {
  console.log('🚀 Step 5: Executing withdrawal...');
  
  const transactionHash = await executeWithdrawalUserOperation(
    smartAccountClient,
    userOperation
  );
  
  console.log('🎉 Withdrawal executed successfully!');
  console.log(`  Transaction hash: ${transactionHash}`);
  
  return transactionHash;
}

// ============ COMPLETE WITHDRAWAL FLOW ============

/**
 * Complete withdrawal flow - orchestrates all steps
 */
export async function processWithdrawal(request: WithdrawalRequest): Promise<PreparedWithdrawal> {
  try {
    console.log('🚀 Starting complete withdrawal process...');
    
    // Step 1: Fetch all required data
    const withdrawalData = await fetchWithdrawalData();
    
    // Step 2: Calculate context and generate nullifiers
    const context = await calculateWithdrawalContext(request, withdrawalData);
    
    // Step 3: Generate ZK proof
    const proofData = await generateWithdrawalProof(request, context);
    
    // Step 4: Prepare UserOperation
    const { userOperation, smartAccountClient } = await prepareWithdrawalTransaction(
      context,
      proofData
    );
    
    console.log('✅ Withdrawal preparation completed successfully');
    
    return {
      context,
      proofData,
      userOperation,
      smartAccountClient,
    };
    
  } catch (error) {
    console.error('❌ Withdrawal process failed:', error);
    throw error;
  }
}

/**
 * Prepare withdrawal without execution (for preview)
 */
export async function prepareWithdrawal(request: WithdrawalRequest): Promise<PreparedWithdrawal> {
  return processWithdrawal(request);
}

/**
 * Execute a prepared withdrawal
 */
export async function executePreparedWithdrawal(
  preparedWithdrawal: PreparedWithdrawal
): Promise<string> {
  return executeWithdrawal(
    preparedWithdrawal.smartAccountClient,
    preparedWithdrawal.userOperation
  );
}

// ============ UTILITY FUNCTIONS ============

/**
 * Validate withdrawal request
 */
export function validateWithdrawalRequest(request: WithdrawalRequest): void {
  const { noteData, withdrawAmount, recipientAddress, accountKeys } = request;
  
  if (!noteData || !noteData.commitment) {
    throw new Error('Invalid note data');
  }
  
  if (!withdrawAmount || parseFloat(withdrawAmount) <= 0) {
    throw new Error('Invalid withdrawal amount');
  }
  
  
  if (parseFloat(withdrawAmount) > parseFloat(noteData.amount)) {
    throw new Error('Withdrawal amount exceeds note balance');
  }
  
  if (!recipientAddress || !isAddress(recipientAddress)) {
    throw new Error('Invalid recipient address');
  }
  
  if (!accountKeys.privateKey && !accountKeys.mnemonic) {
    throw new Error('No account keys provided');
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
  const withdrawAmountNum = parseFloat(withdrawAmount);
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