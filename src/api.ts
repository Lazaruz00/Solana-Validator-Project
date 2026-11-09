import "dotenv/config";

const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type RPCResult<T = any> =
  | { ok: true; value: T }
  | {
      ok: false;
      kind: "rate-limited" | "http-error" | "rpc-error" | "network";
      errorCode?: number;
      errorMessage?: string;
    };

export type EpochSchedule = {
  firstNormalEpoch: number;
  firstNormalSlot: number;
  slotsPerEpoch: number;
};

const backoff = function (numAttempt: number): number {
  const timeGap = Math.min(1000 * 2 ** numAttempt, 3000) + Math.random() * 250;
  return timeGap;
};

export type BlockOutcome =
  | "success"
  | "skipped"
  | "pruned"
  | "unavailable"
  | "error";

// Build a common helper function that will help send requests to Solana
// this helper function acts like a centralised relay; it formats the request body into the JSON-RPC structure that Solana nodes expect, fires the request via fetch
// and also does error checking
async function callSolana<T = any>(
  requestMethod: string,
  params: any[] = [],
): Promise<RPCResult<T>> {
  let latestResponse: RPCResult<T> = {
    ok: false,
    kind: "network",
    errorMessage: "No connection made to Solana yet.",
  };

  // we want to retry the request up to 3 times if we encounter a rate limit
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(SOLANA_RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" }, // this tells Solana that the data we're passing is in JSON format, so parse it as a JSON object
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: requestMethod,
          params,
        }),
      });

      // process the response
      if (!response.ok) {
        const httpResponse = await response.text();
        const retryable = response.status === 429 || response.status >= 500;
        latestResponse = {
          ok: false,
          kind: response.status === 429 ? "rate-limited" : "http-error",
          errorCode: response.status,
          errorMessage: httpResponse,
        };
        if (!retryable) return latestResponse;

        // if retryable and we have not exceeded the max attempts
        if (attempt < maxAttempts) {
          await sleep(backoff(attempt));
        }
        continue; // retry
      }

      // if valid response from Solana
      const data = await response.json();
      if (data.error) {
        latestResponse = {
          ok: false,
          kind: "rpc-error",
          errorCode: data.error.code,
          errorMessage: data.error.message,
        };
        return latestResponse;
      } else {
        latestResponse = { ok: true, value: data.result };
        return latestResponse;
      }
    } catch (error) {
      latestResponse = {
        ok: false,
        kind: "network",
        errorMessage: String(error),
      };
      if (attempt < maxAttempts) await sleep(backoff(attempt));
    }
  }
  return latestResponse;
}

// This method will check the current state of the blockchain, and tell you the current epoch number as well as how many slots have passed
export async function getEpochInfo() {
  return await callSolana("getEpochInfo");
}

// This method acts as a fallback strategy if getEpochInfo() encounters a 501 error due to rate-limiting mechanism on Solana
export async function getSlot() {
  return await callSolana<number>("getSlot");
}

// This method will fetch the information on how much staking reward was paid to your list of vote account(s) for a particular epoch
export async function getInflationReward(
  voteAccounts: string[],
  epoch: number,
) {
  return await callSolana("getInflationReward", [
    voteAccounts,
    { epoch: Number(epoch) },
  ]);
}

// This method will tell you which slots/blocks your validator built. Solana assigns validators their specific blocks to build throughout an entire epoch
// so we need a function to pick out which block was built by our validator
export async function getLeaderSchedule(
  epoch: number,
  options?: { identity?: string },
) {
  const slotsPerEpoch = 432000;
  const targetSlot = epoch * slotsPerEpoch;
  const params: any[] = [targetSlot];
  if (options != null) params.push(options);
  return await callSolana("getLeaderSchedule", params);
}

// this function will return 3 essential information
// 1. slotsPerEpoch - 432,000 slots per epoch
// 2. firstNormalEpoch - The first epoch with the full 432,000 slots
// 3. firstNormalSlot - The absolute slot number where the firstNormalEpoch starts
export async function getEpochSchedule() {
  return await callSolana("getEpochSchedule");
}

// This method will return us the absolute slot number of our desired epoch
export function getFirstSlotInEpoch(
  epoch: number,
  schedule: EpochSchedule,
): number {
  const { firstNormalEpoch, firstNormalSlot, slotsPerEpoch } = schedule;
  if (epoch < firstNormalEpoch) {
    // warmup epochs (only relevant for very early epochs)
    return (2 ** epoch - 1) * 32;
  }
  // We calcuate the absolute slot number of a given epoch by adding the total number of slots in all preceiding epochs to the firstNormalSlot
  const firstSlotInEpoch =
    (epoch - firstNormalEpoch) * slotsPerEpoch + firstNormalSlot;
  return firstSlotInEpoch;
}

// This method will give you all the information about a specific block, including its transaction fees and rewards
export async function getBlock(slot: number) {
  return await callSolana("getBlock", [
    slot,
    {
      encoding: "json",
      maxSupportedTransactionVersion: 1,
      transactionDetails: "none",
      rewards: true,
    },
  ]);
}

// this function helps describe if the block had been pruned/skipped/became unavailable, or returns a general error if errorCode does not mach those in the if-checks
export function getBlockOutcome(pRpcResult: RPCResult<any>): BlockOutcome {
  if (pRpcResult.ok) {
    return pRpcResult.value === null ? "skipped" : "success";
  }
  if (pRpcResult.errorCode === -32007 || pRpcResult.errorCode === -32009) {
    return "skipped";
  } else if (pRpcResult.errorCode === -32001) {
    return "pruned";
  } else if (pRpcResult.errorCode === -32004) {
    return "unavailable";
  } else {
    return "error";
  }
}

// this function helps retrieve information about a vote account
export async function getAccountInfo(pVoteAccount: string) {
  return await callSolana("getAccountInfo", [
    pVoteAccount,
    { encoding: "jsonParsed" },
  ]);
}
