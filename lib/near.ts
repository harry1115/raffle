import {
  Account,
  JsonRpcProvider,
  KeyPairSigner,
  parseNearAmount,
} from "near-api-js";

const NODE_URL =
  process.env.NEXT_PUBLIC_NODE_URL || "https://rpc.testnet.near.org";
const USER_ACCOUNT = process.env.NEXT_PUBLIC_USER_ACCOUNT!;
const USER_PRIVATE_KEY = process.env.NEXT_PUBLIC_USER_PRIVATE_KEY!;
const TEE_ACCOUNT = process.env.NEXT_PUBLIC_TEE_ACCOUNT!;
const TEE_PRIVATE_KEY = process.env.NEXT_PUBLIC_TEE_PRIVATE_KEY!;

const provider = new JsonRpcProvider({ url: NODE_URL });

// KeyPairSigner.fromSecretKey expects KeyPairString type (`ed25519:...`)
// but env vars are plain string, so we cast via Parameters utility
type SecretKeyParam = Parameters<typeof KeyPairSigner.fromSecretKey>[0];

export function getUserAccount(): Account {
  return new Account(
    USER_ACCOUNT,
    provider,
    KeyPairSigner.fromSecretKey(USER_PRIVATE_KEY as SecretKeyParam)
  );
}

export function getTeeAccount(): Account {
  return new Account(
    TEE_ACCOUNT,
    provider,
    KeyPairSigner.fromSecretKey(TEE_PRIVATE_KEY as SecretKeyParam)
  );
}

export async function viewCall<T>(
  contractId: string,
  methodName: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  return provider.callFunction({
    contractId,
    method: methodName,
    args,
  }) as Promise<T>;
}

export interface CallResult {
  txHash: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any;
  logs: string[];
}

export async function callMethod(
  account: Account,
  contractId: string,
  methodName: string,
  args: Record<string, unknown>,
  deposit: string = "0",
  gas: string = "300000000000000" // 300 TGas
): Promise<CallResult> {
  const outcome = await account.callFunctionRaw({
    contractId,
    methodName,
    args,
    deposit: BigInt(deposit),
    gas: BigInt(gas),
  });

  const txHash =
    outcome.transaction_outcome?.id || outcome.transaction?.hash || "";

  // Collect all logs from all receipts
  const logs: string[] = [];
  if (outcome.receipts_outcome) {
    for (const receipt of outcome.receipts_outcome) {
      if (receipt.outcome?.logs) {
        logs.push(...receipt.outcome.logs);
      }
    }
  }

  // Parse the final result value
  let resultValue: unknown = null;
  const status = outcome.status as Record<string, unknown>;
  if (status?.SuccessValue) {
    try {
      const decoded = Buffer.from(
        status.SuccessValue as string,
        "base64"
      ).toString();
      resultValue = JSON.parse(decoded);
    } catch {
      resultValue = status.SuccessValue;
    }
  }

  return { txHash, result: resultValue, logs };
}

/**
 * Fetch a transaction outcome by txHash from NEAR RPC.
 * Used to retrieve logs/result when we only have the txHash (from server polling).
 */
export async function getTransactionOutcome(
  txHash: string,
  senderAccountId: string
): Promise<CallResult> {
  const res = await fetch(NODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "dontcare",
      method: "EXPERIMENTAL_tx_status",
      params: { tx_hash: txHash, sender_account_id: senderAccountId, wait_until: "EXECUTED_OPTIMISTIC" },
    }),
  });
  const json = await res.json();
  if (json.error) {
    throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
  }

  const outcome = json.result;

  // Collect all logs from all receipts
  const logs: string[] = [];
  if (outcome.receipts_outcome) {
    for (const receipt of outcome.receipts_outcome) {
      if (receipt.outcome?.logs) {
        logs.push(...receipt.outcome.logs);
      }
    }
  }

  // Parse the final result value
  let resultValue: unknown = null;
  const status = outcome.status as Record<string, unknown>;
  if (status?.SuccessValue) {
    try {
      const decoded = Buffer.from(
        status.SuccessValue as string,
        "base64"
      ).toString();
      resultValue = JSON.parse(decoded);
    } catch {
      resultValue = status.SuccessValue;
    }
  }

  return { txHash, result: resultValue, logs };
}

export function generateRandomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const YOCTO_ONE = "1";
export const NEAR_DEPOSIT = parseNearAmount("0.5"); // 0.5 NEAR for storage
