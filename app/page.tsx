"use client";

import { useState, useCallback, useRef } from "react";
import type {
  PrizeCategoryInput,
  UserId,
  AccountInfo,
  RaffleView,
  LogEntry,
  DrawMode,
  PrizesDrawnEvent,
} from "@/lib/types";
import { generateRandomHex, getTransactionOutcome } from "@/lib/near";
import { convertMpcSignature } from "@/lib/mpc-signature";
import { signTeePayload } from "@/lib/tee-signer";
import {
  createRaffle,
  getRaffle,
  deriveEvmUserId,
  getAccount,
  signMessage,
  generateRandomNumber,
  parseRaffleIdFromLogs,
  parsePrizesDrawnEvents,
} from "@/lib/contracts";
import {
  addRandomRecord,
  pollRandomRecord,
  updateRandomRecord,
} from "@/lib/api";
import { verifyDrawResults, type VerificationResult } from "@/lib/verify";

const USER_ACCOUNT = process.env.NEXT_PUBLIC_USER_ACCOUNT || "";
const TEE_ACCOUNT = process.env.NEXT_PUBLIC_TEE_ACCOUNT || "";
const RANDOMNESS_CONTRACT = process.env.NEXT_PUBLIC_RANDOMNESS_CONTRACT || "";
const RAFFLE_CONTRACT = process.env.NEXT_PUBLIC_RAFFLE_CONTRACT || "";
const TOKEN = process.env.NEXT_PUBLIC_TOKEN || "";
const TEE_PRIVATE_KEY = process.env.NEXT_PUBLIC_TEE_PRIVATE_KEY || "";

const NETWORK_ID = process.env.NEXT_PUBLIC_NETWORK_ID || "testnet";
const EXPLORER_BASE = NETWORK_ID === "mainnet"
  ? "https://nearblocks.io/txns"
  : `https://${NETWORK_ID}.nearblocks.io/txns`;

interface DrawRound {
  roundIndex: number;
  events: PrizesDrawnEvent[];
  priorWinners: string[]; // all_winners before this draw
  txHash: string;
}

export default function Home() {
  // Step 1: Create Raffle
  const [raffleName, setRaffleName] = useState("Demo Raffle");
  const [participantsText, setParticipantsText] = useState(
    "Alice\nBob\nCharlie\nDave\nEve\nFrank\nGrace\nHelen\nIvy\nJack"
  );
  const [categories, setCategories] = useState<PrizeCategoryInput[]>([
    { name: "First Prize", count: 1 },
    { name: "Second Prize", count: 2 },
    { name: "Third Prize", count: 3 },
  ]);
  const [raffleId, setRaffleId] = useState<number | null>(null);

  // Step 2: User Info
  const [userId, setUserId] = useState<UserId | null>(null);
  const [accountInfo, setAccountInfo] = useState<AccountInfo | null>(null);

  // Step 3: Draw mode
  const [drawModeType, setDrawModeType] = useState<"All" | "Category">("All");
  const [categoryIndex, setCategoryIndex] = useState(0);
  const [categoryCount, setCategoryCount] = useState(1);

  // Step 4: Results & Verification
  const [raffleResult, setRaffleResult] = useState<RaffleView | null>(null);
  const [drawRounds, setDrawRounds] = useState<DrawRound[]>([]);
  const [verification, setVerification] = useState<VerificationResult | null>(
    null
  );

  // Shared
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState<Record<string, boolean>>({});

  // Server flow state
  const [requestId, setRequestId] = useState<string | null>(null);
  const [pendingPayload, setPendingPayload] = useState<{
    userPayloadJson: string;
    userSignatureHex: string;
    priorWinners: string[];
  } | null>(null);
  const [polling, setPolling] = useState(false);
  const pollAbortRef = useRef<AbortController | null>(null);

  const addLog = useCallback(
    (
      action: string,
      status: LogEntry["status"],
      txHash?: string,
      detail?: string
    ) => {
      setLogs((prev) => [
        { timestamp: Date.now(), action, status, txHash, detail },
        ...prev,
      ]);
    },
    []
  );

  const setStepLoading = (step: string, v: boolean) =>
    setLoading((prev) => ({ ...prev, [step]: v }));

  // --- Step 2: Fetch User Info ---
  const fetchUserInfo = useCallback(async () => {
    setStepLoading("userInfo", true);
    try {
      const uid = await deriveEvmUserId(USER_ACCOUNT);
      setUserId(uid);
      const acc = await getAccount(uid);
      setAccountInfo(acc);
      addLog(
        "Fetch user info",
        "success",
        undefined,
        `EVM: ${uid.Evm}, nonce: ${acc?.nonce ?? "N/A"}`
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog("Fetch user info", "error", undefined, msg);
    } finally {
      setStepLoading("userInfo", false);
    }
  }, [addLog]);

  // --- Step 4: View Results ---
  const fetchRaffleResult = useCallback(
    async (id?: number) => {
      const rid = id ?? raffleId;
      if (rid === null) return;
      setStepLoading("result", true);
      try {
        const result = await getRaffle(rid);
        setRaffleResult(result);
        addLog(
          "View results",
          "success",
          undefined,
          `${result?.all_winners.length ?? 0} winner(s)`
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        addLog("View results", "error", undefined, msg);
      } finally {
        setStepLoading("result", false);
      }
    },
    [raffleId, addLog]
  );

  // --- Step 1: Create Raffle ---
  const handleCreateRaffle = async () => {
    setStepLoading("create", true);
    addLog("Create raffle", "pending");
    try {
      const participants = participantsText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (participants.length === 0)
        throw new Error("Participants list is empty");

      const res = await createRaffle(raffleName, participants, categories);
      const id = parseRaffleIdFromLogs(res.logs);
      if (id === null) throw new Error("Failed to parse raffle_id from logs");
      setRaffleId(id);
      setDrawRounds([]);
      setVerification(null);
      addLog("Create raffle", "success", res.txHash, `raffle_id = ${id}`);

      // Auto fetch user info
      await fetchUserInfo();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog("Create raffle", "error", undefined, msg);
    } finally {
      setStepLoading("create", false);
    }
  };

  // --- Step 3: Sign & Draw (server flow) ---
  const handleSignAndDraw = async () => {
    if (raffleId === null || !userId || !accountInfo) return;

    setStepLoading("draw", true);
    setVerification(null);
    try {
      // Snapshot current winners before this draw (for verification later)
      const preDrawRaffle = await getRaffle(raffleId);
      const priorWinners = preDrawRaffle?.all_winners ?? [];

      // Build draw mode
      const mode: DrawMode =
        drawModeType === "All"
          ? "All"
          : {
              Category: {
                category_index: categoryIndex,
                count: categoryCount,
              },
            };

      const drawMessage = JSON.stringify({ raffle_id: raffleId, mode });

      // Build UserPayload
      const randomSeed = generateRandomHex(32);
      const deadline = String(Date.now() + 600_000); // 10 minutes

      const userPayload = {
        user_id: userId,
        nonce: accountInfo.nonce,
        deadline,
        fee_token: TOKEN,
        random_seed: randomSeed,
        callback: {
          contract_id: RAFFLE_CONTRACT,
          message: drawMessage,
        },
      };
      const userPayloadJson = JSON.stringify(userPayload);

      // Step 3a: Sign via MPC
      addLog(
        "MPC sign",
        "pending",
        undefined,
        "Waiting for MPC signature (may take 10-30s)..."
      );
      const { mpcResponse, txHash: signTxHash } =
        await signMessage(userPayloadJson);
      const userSignatureHex = convertMpcSignature(mpcResponse);
      addLog(
        "MPC sign",
        "success",
        signTxHash,
        `signature: ${userSignatureHex.slice(0, 20)}...`
      );

      // Save pending payload for Mock TEE
      setPendingPayload({ userPayloadJson, userSignatureHex, priorWinners });

      // Step 3b: Submit to server
      const reqId = crypto.randomUUID();
      setRequestId(reqId);

      addLog(
        "Submit request",
        "pending",
        undefined,
        `requestId: ${reqId}`
      );
      await addRandomRecord(reqId, {
        user_payload: userPayloadJson,
        user_signature: userSignatureHex,
      });
      addLog("Submit request", "success", undefined, `requestId: ${reqId}`);

      // Step 3c: Poll for result
      setPolling(true);
      const abortController = new AbortController();
      pollAbortRef.current = abortController;

      addLog(
        "Polling",
        "pending",
        undefined,
        "Waiting for TEE to process (polling every 2s)..."
      );

      let pollResult: { txHash: string } | { failMsg: string };
      try {
        pollResult = await pollRandomRecord(reqId, abortController.signal);
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          // Polling was aborted (Mock TEE took over)
          return;
        }
        throw e;
      } finally {
        setPolling(false);
        pollAbortRef.current = null;
      }

      if ("failMsg" in pollResult) {
        throw new Error(`TEE processing failed: ${pollResult.failMsg}`);
      }

      // Got txHash from server — fetch transaction outcome
      addLog(
        "Fetch tx result",
        "pending",
        pollResult.txHash,
        "Fetching transaction outcome..."
      );
      const txResult = await getTransactionOutcome(
        pollResult.txHash,
        TEE_ACCOUNT
      );

      // Collect PrizesDrawn events from tx logs
      const events = parsePrizesDrawnEvents(txResult.logs);
      const round: DrawRound = {
        roundIndex: drawRounds.length,
        events,
        priorWinners,
        txHash: pollResult.txHash,
      };
      setDrawRounds((prev) => [...prev, round]);

      addLog(
        "Generate randomness",
        "success",
        pollResult.txHash,
        `Draw complete, ${events.length} category(s) drawn`
      );

      // Cleanup
      setPendingPayload(null);
      setRequestId(null);

      // Auto fetch results & refresh user info
      await fetchRaffleResult();
      await fetchUserInfo();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog("Sign & draw", "error", undefined, msg);
    } finally {
      setStepLoading("draw", false);
    }
  };

  // --- Mock TEE Draw (local TEE signing + report txHash to server) ---
  const handleMockDraw = async () => {
    if (!pendingPayload || !requestId) return;

    setStepLoading("mockDraw", true);
    try {
      const { userPayloadJson, userSignatureHex, priorWinners } =
        pendingPayload;

      // Local TEE sign
      const teeRandomSeed = generateRandomHex(32);
      const { teePayload, teeSignature } = signTeePayload(
        userPayloadJson,
        userSignatureHex,
        teeRandomSeed,
        TEE_PRIVATE_KEY
      );
      addLog("Mock TEE sign", "success", undefined, "Local Ed25519 signing done");

      // Call generate_random_number on contract
      addLog(
        "Mock generate randomness",
        "pending",
        undefined,
        "Calling generate_random_number..."
      );
      const drawResult = await generateRandomNumber({
        user_payload: userPayloadJson,
        user_signature: userSignatureHex,
        tee_payload: teePayload,
        tee_signature: teeSignature,
      });

      // Report txHash to server
      await updateRandomRecord(requestId, drawResult.txHash);
      addLog(
        "Mock update server",
        "success",
        undefined,
        `txHash reported: ${drawResult.txHash.slice(0, 16)}...`
      );

      // Abort polling (server flow will see AbortError and return)
      pollAbortRef.current?.abort();

      // Process result locally
      const events = parsePrizesDrawnEvents(drawResult.logs);
      const round: DrawRound = {
        roundIndex: drawRounds.length,
        events,
        priorWinners,
        txHash: drawResult.txHash,
      };
      setDrawRounds((prev) => [...prev, round]);

      addLog(
        "Mock generate randomness",
        "success",
        drawResult.txHash,
        `Draw complete, ${events.length} category(s) drawn`
      );

      // Cleanup
      setPendingPayload(null);
      setRequestId(null);
      setPolling(false);

      // Auto fetch results & refresh user info
      await fetchRaffleResult();
      await fetchUserInfo();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog("Mock TEE draw", "error", undefined, msg);
    } finally {
      setStepLoading("mockDraw", false);
      setStepLoading("draw", false);
    }
  };

  // --- Verify ---
  const handleVerify = async () => {
    if (!raffleResult || drawRounds.length === 0) return;
    setStepLoading("verify", true);
    addLog("Verify", "pending", undefined, "Reconstructing winners...");
    try {
      const participants = raffleResult.participants;
      const allRoundResults: VerificationResult = { passed: true, rounds: [] };

      for (const round of drawRounds) {
        const result = await verifyDrawResults(
          participants,
          round.events,
          round.priorWinners
        );
        allRoundResults.rounds.push(...result.rounds);
        if (!result.passed) allRoundResults.passed = false;
      }

      setVerification(allRoundResults);
      const passCount = allRoundResults.rounds.filter((r) => r.passed).length;
      addLog(
        "Verify",
        allRoundResults.passed ? "success" : "error",
        undefined,
        `${passCount}/${allRoundResults.rounds.length} round(s) passed`
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog("Verify", "error", undefined, msg);
    } finally {
      setStepLoading("verify", false);
    }
  };

  // --- Category Editor ---
  const addCategory = () =>
    setCategories((prev) => [...prev, { name: "", count: 1 }]);
  const removeCategory = (i: number) =>
    setCategories((prev) => prev.filter((_, idx) => idx !== i));
  const updateCategory = (
    i: number,
    field: "name" | "count",
    value: string
  ) =>
    setCategories((prev) =>
      prev.map((c, idx) =>
        idx === i
          ? {
              ...c,
              [field]: field === "count" ? parseInt(value) || 0 : value,
            }
          : c
      )
    );

  return (
    <main className="max-w-4xl mx-auto p-6 space-y-8">
      <h1 className="text-2xl font-bold">Raffle Demo — Randomness Infura</h1>

      {/* Config Info */}
      <section className="p-4 bg-gray-100 dark:bg-gray-800 rounded-lg text-sm font-mono space-y-1">
        <div>User: {USER_ACCOUNT}</div>
        {/* <div>TEE: {TEE_ACCOUNT}</div> */}
        <div>Randomness Contract: {RANDOMNESS_CONTRACT}</div>
        <div>Raffle Contract: {RAFFLE_CONTRACT}</div>
        <div>Token: {TOKEN}</div>
      </section>

      {/* Step 1: Create Raffle */}
      <section className="p-4 border rounded-lg space-y-4">
        <h2 className="text-lg font-semibold">1. Create Raffle</h2>

        <div>
          <label className="block text-sm font-medium mb-1">Raffle Name</label>
          <input
            className="w-full border rounded px-3 py-2 dark:bg-gray-900"
            value={raffleName}
            onChange={(e) => setRaffleName(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">
            Participants (one per line)
          </label>
          <textarea
            className="w-full border rounded px-3 py-2 h-32 font-mono text-sm dark:bg-gray-900"
            value={participantsText}
            onChange={(e) => setParticipantsText(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">
            Prize Categories
          </label>
          {categories.map((cat, i) => (
            <div key={i} className="flex gap-2 mb-2 items-center">
              <input
                className="border rounded px-2 py-1 flex-1 dark:bg-gray-900"
                placeholder="Category name"
                value={cat.name}
                onChange={(e) => updateCategory(i, "name", e.target.value)}
              />
              <input
                className="border rounded px-2 py-1 w-20 dark:bg-gray-900"
                type="number"
                min={1}
                value={cat.count}
                onChange={(e) => updateCategory(i, "count", e.target.value)}
              />
              <span className="text-sm text-gray-500">winners</span>
              <button
                className="text-red-500 text-sm hover:underline"
                onClick={() => removeCategory(i)}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            className="text-blue-500 text-sm hover:underline"
            onClick={addCategory}
          >
            + Add Category
          </button>
        </div>

        <button
          className="bg-blue-600 text-white px-6 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
          onClick={handleCreateRaffle}
          disabled={loading.create}
        >
          {loading.create ? "Creating..." : "Create Raffle"}
        </button>

        {raffleId !== null && (
          <div className="text-green-600 font-medium">
            Raffle created, ID: {raffleId}
          </div>
        )}
      </section>

      {/* Step 2: User Info */}
      {userId && (
        <section className="p-4 border rounded-lg space-y-2">
          <h2 className="text-lg font-semibold">2. User Info</h2>
          <div className="text-sm font-mono space-y-1">
            <div>EVM Address: {userId.Evm}</div>
            <div>Nonce: {accountInfo?.nonce ?? "N/A"}</div>
            <div>
              Token Balance:{" "}
              {accountInfo?.tokens
                ? Object.entries(accountInfo.tokens)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(", ") || "None"
                : "N/A"}
            </div>
          </div>
          <button
            className="text-blue-500 text-sm hover:underline"
            onClick={fetchUserInfo}
            disabled={loading.userInfo}
          >
            {loading.userInfo ? "Refreshing..." : "Refresh"}
          </button>
        </section>
      )}

      {/* Step 3: Sign & Draw */}
      {raffleId !== null && userId && (
        <section className="p-4 border rounded-lg space-y-4">
          <h2 className="text-lg font-semibold">3. Sign & Draw</h2>

          <div className="flex gap-4 items-center">
            <label className="text-sm font-medium">Draw Mode:</label>
            <select
              className="border rounded px-2 py-1 dark:bg-gray-900"
              value={drawModeType}
              onChange={(e) =>
                setDrawModeType(e.target.value as "All" | "Category")
              }
            >
              <option value="All">Draw All</option>
              <option value="Category">By Category</option>
            </select>
          </div>

          {drawModeType === "Category" && (
            <div className="flex gap-4 items-center">
              <div>
                <label className="text-sm">Category Index:</label>
                <input
                  className="border rounded px-2 py-1 w-20 ml-2 dark:bg-gray-900"
                  type="number"
                  min={0}
                  value={categoryIndex}
                  onChange={(e) =>
                    setCategoryIndex(parseInt(e.target.value) || 0)
                  }
                />
              </div>
              <div>
                <label className="text-sm">Count:</label>
                <input
                  className="border rounded px-2 py-1 w-20 ml-2 dark:bg-gray-900"
                  type="number"
                  min={1}
                  value={categoryCount}
                  onChange={(e) =>
                    setCategoryCount(parseInt(e.target.value) || 1)
                  }
                />
              </div>
            </div>
          )}

          <div className="text-xs text-gray-500">
            Flow: Build UserPayload &rarr; MPC Sign (~10-30s) &rarr; Submit to
            Server &rarr; Poll for Result
          </div>

          <div className="flex gap-4 items-center">
            <button
              className="bg-green-600 text-white px-6 py-2 rounded hover:bg-green-700 disabled:opacity-50"
              onClick={handleSignAndDraw}
              disabled={loading.draw || loading.mockDraw}
            >
              {loading.draw ? "Drawing..." : "Sign & Draw"}
            </button>

            {/* {polling && pendingPayload && (
              <button
                className="bg-yellow-600 text-white px-6 py-2 rounded hover:bg-yellow-700 disabled:opacity-50"
                onClick={handleMockDraw}
                disabled={loading.mockDraw}
              >
                {loading.mockDraw ? "Mock Processing..." : "Mock TEE Draw"}
              </button>
            )} */}

            {polling && (
              <span className="text-yellow-500 text-sm animate-pulse">
                Polling for result...
              </span>
            )}
          </div>
        </section>
      )}

      {/* Step 4: Results */}
      {raffleResult && (
        <section className="p-4 border rounded-lg space-y-4">
          <h2 className="text-lg font-semibold">4. Results</h2>
          <div className="text-sm">
            <span className="font-medium">{raffleResult.name}</span>
            <span className="text-gray-500 ml-2">
              ({raffleResult.participants.length} participants,{" "}
              {raffleResult.all_winners.length} winner(s))
            </span>
          </div>

          {raffleResult.categories.map((cat, i) => (
            <div key={i} className="border-l-4 border-blue-500 pl-4">
              <div className="font-medium">
                {cat.name}
                <span className="text-gray-500 text-sm ml-2">
                  ({cat.winners.length}/{cat.count})
                </span>
              </div>
              {cat.winners.length > 0 ? (
                <ul className="list-disc list-inside text-sm mt-1">
                  {cat.winners.map((w, j) => (
                    <li key={j}>
                      {w}
                      <span className="text-gray-400 ml-1">(#{j + 1})</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-gray-400 text-sm">Not drawn yet</div>
              )}
            </div>
          ))}

          <div className="flex gap-4 items-center">
            <button
              className="text-blue-500 text-sm hover:underline"
              onClick={() => fetchRaffleResult()}
              disabled={loading.result}
            >
              {loading.result ? "Refreshing..." : "Refresh Results"}
            </button>
          </div>
        </section>
      )}

      {/* Step 5: Verification */}
      {drawRounds.length > 0 && raffleResult && (
        <section className="p-4 border rounded-lg space-y-4">
          <h2 className="text-lg font-semibold">5. Verify</h2>
          <div className="text-xs text-gray-500">
            Reconstruct winners from PrizesDrawn event logs using the same
            sha256(seed || rank) algorithm, then compare with on-chain results.
          </div>

          <div className="text-sm text-gray-500">
            {drawRounds.length} draw round(s) recorded
          </div>

          <button
            className="bg-purple-600 text-white px-6 py-2 rounded hover:bg-purple-700 disabled:opacity-50"
            onClick={handleVerify}
            disabled={loading.verify}
          >
            {loading.verify ? "Verifying..." : "Verify Results"}
          </button>

          {verification && (
            <div className="space-y-2">
              <div
                className={`font-semibold ${verification.passed ? "text-green-600" : "text-red-600"}`}
              >
                {verification.passed ? "PASSED" : "FAILED"} —{" "}
                {verification.rounds.filter((r) => r.passed).length}/
                {verification.rounds.length} round(s)
              </div>

              {verification.rounds.map((round, i) => (
                <div
                  key={i}
                  className={`p-3 rounded text-sm ${round.passed ? "bg-green-50 dark:bg-green-900/20" : "bg-red-50 dark:bg-red-900/20"}`}
                >
                  <div className="font-medium">
                    <span
                      className={
                        round.passed ? "text-green-600" : "text-red-600"
                      }
                    >
                      {round.passed ? "PASS" : "FAIL"}
                    </span>{" "}
                    {round.categoryName}
                  </div>
                  <div className="text-xs text-gray-500 font-mono mt-1">
                    seed: {round.seed.slice(0, 16)}...
                  </div>
                  <div className="mt-1 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <div className="font-medium text-gray-500">
                        Reconstructed:
                      </div>
                      {round.expected.map((w, j) => (
                        <div key={j}>
                          {w} (#{j + 1})
                        </div>
                      ))}
                    </div>
                    <div>
                      <div className="font-medium text-gray-500">On-chain:</div>
                      {round.actual.map((w, j) => (
                        <div key={j}>
                          {w} (#{j + 1})
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Activity Log */}
      {logs.length > 0 && (
        <section className="p-4 border rounded-lg">
          <h2 className="text-lg font-semibold mb-2">Activity Log</h2>
          <div className="space-y-1 max-h-64 overflow-y-auto text-sm font-mono">
            {logs.map((log, i) => (
              <div key={i} className="flex gap-2">
                <span className="text-gray-400 shrink-0">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
                <span
                  className={
                    log.status === "success"
                      ? "text-green-500"
                      : log.status === "error"
                        ? "text-red-500"
                        : "text-yellow-500"
                  }
                >
                  [
                  {log.status === "success"
                    ? "OK"
                    : log.status === "error"
                      ? "ERR"
                      : "..."}
                  ]
                </span>
                <span>{log.action}</span>
                {log.detail && (
                  <span className="text-gray-500 truncate">{log.detail}</span>
                )}
                {log.txHash && (
                  <a
                    href={`${EXPLORER_BASE}/${log.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-500 hover:underline shrink-0"
                  >
                    [tx]
                  </a>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
