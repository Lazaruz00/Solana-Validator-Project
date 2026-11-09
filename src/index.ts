import { testConnection, createTables, pool } from "./database";
import {
  getEpochInfo,
  getInflationReward,
  getLeaderSchedule,
  getBlock,
  getSlot,
  getEpochSchedule,
  getFirstSlotInEpoch,
  getBlockOutcome,
  getAccountInfo,
  BlockOutcome,
} from "./api";
import { processInput, defaultStartingEpoch } from "./input";

// Assign variables
const slotsPerEpoch = 432000;
const epochLevel = -1;

async function main() {
  try {
    // receive input
    const client = processInput();

    console.log("Initialising test to connect to DB...");
    await testConnection(); // to test connection to database
    await createTables(); // to create the necessary tables

    // We retrieve the latest epoch running on Solana
    let currentEpoch: number;
    let startEpoch: number | undefined;
    let endEpoch: number | undefined;
    let latestCompletedEpoch: number;
    const epochInfo = await getEpochInfo();
    if (epochInfo.ok) {
      currentEpoch = epochInfo.value.epoch;
    } else {
      const currentSlot = await getSlot(); // this is a fall-back strategy. If getEpochInfo fails, we'll call getSlot and manually calculate the epoch number
      if (!currentSlot.ok) {
        throw new Error(
          "Error encountered in getSlot(), hence failed to fetch result for getEpochInfo().",
        );
      } else {
        currentEpoch = Math.floor(currentSlot.value / slotsPerEpoch); // since each epoch has 432000 slots, if we divide the current slots by 432000, we can get the epoch number
      }
    }

    console.log("Current epoch is: #", currentEpoch);
    // Now, we retrieve the latest COMPLETED epoch
    latestCompletedEpoch = currentEpoch - 1;
    const voteAccount = client.voteAccount;
    startEpoch = client.startEpoch ?? defaultStartingEpoch;
    endEpoch = client.endEpoch ?? latestCompletedEpoch;
    console.log(`Our range is from epoch #${startEpoch} to #${endEpoch}.`);

    // do som preliminary sanity check
    if (startEpoch > endEpoch) {
      throw new Error(
        `Invalid epoch range. Got starting epoch: ${startEpoch} and ending epoch: ${endEpoch}`,
      );
    }

    if (endEpoch > latestCompletedEpoch) {
      throw new Error(
        `Invalid ending epoch. Got ${endEpoch}, which is more than the latest completed epoch #${latestCompletedEpoch}`,
      );
    }

    const identityAccount = await decipherIdentity(voteAccount);
    console.log(
      `Vote account: ${voteAccount} -> Identity account: ${identityAccount}`,
    );

    // Main loop: We iterate over the epochs
    for (let epoch = startEpoch; epoch <= endEpoch; epoch++) {
      // to change
      console.log(`Processing epoch #${epoch} now...`);
      if (!(await hasStakingReward(voteAccount, epoch))) {
        // Indexing staking rewards
        try {
          const rewards = await getInflationReward([voteAccount], epoch);
          if (rewards.ok) {
            const reward = rewards.value[0];
            if (reward) {
              // Use an upsert query to maintain idempotency using VALIDATOR_EPOCH_REWARDS' unique constraint
              const rewardQuery = `INSERT INTO VALIDATOR_EPOCH_REWARDS (VALIDATOR_VOTE_ACCOUNT, EPOCH, STAKING_REWARD_LAMPORTS, COMMISSION_PERCENTAGE, EFFECTIVE_SLOT)
                                          VALUES ($1, $2, $3, $4, $5)
                                          ON CONFLICT (VALIDATOR_VOTE_ACCOUNT, EPOCH, DELETE_IND)
                                          DO UPDATE SET
                                          STAKING_REWARD_LAMPORTS = EXCLUDED.STAKING_REWARD_LAMPORTS,
                                          COMMISSION_PERCENTAGE = EXCLUDED.COMMISSION_PERCENTAGE,
                                          EFFECTIVE_SLOT = EXCLUDED.EFFECTIVE_SLOT,
                                          UPDATED_DT = CURRENT_TIMESTAMP;
                    `;

              // Insert reward record
              await pool.query(rewardQuery, [
                voteAccount,
                epoch,
                reward.amount,
                reward.commission ?? null,
                reward.effectiveSlot,
              ]);

              // if insertion is successful, close the corresponding gap (if any)
              await closeResolvedGap(voteAccount, epoch, "staking_reward");

              console.log(
                `Successfully indexed staking reward for epoch #${epoch}: ${reward.amount} lamports.`,
              );
            } else {
              await logGaps(
                voteAccount,
                epoch,
                "staking_reward",
                "RPC returned null: no reward for this epoch",
              );
            }
          } else {
            const stakingRewardNotFoundMsg = `${rewards.kind} (code ${rewards.errorCode ?? "N/A"} encountered: ${rewards.errorMessage ?? "N/A"})`;
            console.log(
              `No staking reward found in epoch #${epoch}. Error message: ${stakingRewardNotFoundMsg}`,
            );
            await logGaps(
              voteAccount,
              epoch,
              "staking_reward",
              stakingRewardNotFoundMsg,
            );
            console.log(`Error successfully logged to DB for epoch #${epoch}`);
          }
        } catch (error) {
          // log the error into DB
          const stakingErrorMsg = `Error encountered when calling getInflationReward() in epoch #${epoch}`;
          await logGaps(voteAccount, epoch, "staking_reward", stakingErrorMsg);
          console.log(stakingErrorMsg);
        }
      } else {
        console.log(
          `Staking for ${voteAccount} in epoch #${epoch} is fully indexed and accounted for. Skipping...`,
        );
      }

      // Indexing Block Fees
      try {
        // to keep track of the slots that were successful/skipped/pruned/unavailable/ran into error
        const slotCounts = {
          stored: 0,
          success: 0,
          skipped: 0,
          pruned: 0,
          unavailable: 0,
          error: 0,
        };
        if (await isEpochComplete(voteAccount, epoch)) {
          console.log(
            `Block fees for epoch #${epoch} are already complete, skipping.`,
          );
          continue;
        }
        // Fetch the leader schedule for the current epoch based on the validator's identity account
        console.log(`Fetching the leader schedule for epoch #${epoch}...`);
        const leaderSchedule = await getLeaderSchedule(epoch, {
          identity: identityAccount,
        });

        if (!leaderSchedule.ok) {
          const getLeaderScheduleErrorMsg = `${leaderSchedule.kind} (code ${leaderSchedule.errorCode ?? "N/A"}) encountered. Error msg: ${leaderSchedule.errorMessage ?? "N/A"}`;
          console.log(
            `Error encountered when fetching leader schedule: ${getLeaderScheduleErrorMsg}`,
          );
          await logGaps(
            voteAccount,
            epoch,
            "block_fees",
            `Leader schedule failed: ${getLeaderScheduleErrorMsg}`,
          );
        } else if (leaderSchedule.value === null) {
          console.log(
            `Leader schedule not available for validator ${voteAccount} in epoch #${epoch}.`,
          );
          await logGaps(
            voteAccount,
            epoch,
            "block_fees",
            `Leader schedule not available for epoch #${epoch}.`,
          );
        } else if (!leaderSchedule.value[identityAccount]) {
          // this is not a gap because the identity might not have slots assigned to it in this epoch.
          // since there are no blocks, there are no fees to be missing.
          console.log(`No leader slots assigned in epoch #${epoch}`);
          // since we successfully got a leader schedule for our identity account, even if the schedule is empty, resolve the gap record in DB
          await closeResolvedGap(voteAccount, epoch, "block_fees");
        } else {
          // Extract the slots dedicated to our validator
          const assignedSlots: number[] = leaderSchedule.value[identityAccount];
          console.log(
            `The number of slots assigned to the validator in epoch #${epoch}: ${assignedSlots.length}`,
          );

          // Iterate through the assigned slots to get the block data
          const schedule = await getEpochSchedule();
          if (!schedule.ok) {
            throw new Error(
              `Fetching epoch schedule failed. Reason: ${schedule.errorMessage}`,
            );
          }
          const firstSlot = getFirstSlotInEpoch(epoch, schedule.value);
          const prunedSlots: number[] = []; // this stores a list of all the slots that were pruned
          const absoluteSlots = assignedSlots.map(
            (offset) => firstSlot + offset,
          );
          const availability = await probeEpoch(absoluteSlots);
          if (availability === "pruned") {
            const allPrunedErrorMsg = `All ${assignedSlots.length} slots have been pruned for epoch #${epoch}`;
            console.log(allPrunedErrorMsg);
            await logGaps(voteAccount, epoch, "block_fees", allPrunedErrorMsg);
            // log information to indicate that in this epoch, all slots  were pruned
            await saveEpochBlockStats(voteAccount, epoch, {
              assigned: assignedSlots.length,
              produced: 0,
              skipped: 0,
              pruned: assignedSlots.length,
              failed: 0,
            });
          } else {
            const storedSlots = await getStoredSlots(voteAccount, epoch);
            for (const currentSlot of absoluteSlots) {
              // get block data
              if (storedSlots.has(currentSlot)) {
                slotCounts.stored++;
                continue; // if the slot has already been stored, don't need to store it again since the information in it remains the same
              }
              const blockData = await getBlock(currentSlot);
              const blockOutcome = getBlockOutcome(blockData);
              slotCounts[blockOutcome]++;
              if (blockData.ok && blockOutcome === "success") {
                console.log("\nSuccessfully fetched block data.");
                // Extract the fees data from the block
                const feeLamports = extractBlockFees(
                  blockData.value,
                  identityAccount,
                );
                console.log(
                  `The fees collected in slot #${currentSlot} for epoch #${epoch} is: ${feeLamports}`,
                );

                // insert record into DB
                const feeQuery = `INSERT INTO VALIDATOR_BLOCK_FEES(VALIDATOR_VOTE_ACCOUNT, IDENTITY_ACCOUNT, SLOT, EPOCH, FEE_LAMPORTS)
                                  VALUES ($1, $2, $3, $4, $5)
                                  ON CONFLICT (VALIDATOR_VOTE_ACCOUNT, SLOT, DELETE_IND)
                                  DO UPDATE SET
                                  FEE_LAMPORTS = EXCLUDED.FEE_LAMPORTS,
                                  UPDATED_DT = CURRENT_TIMESTAMP;
                `;
                await pool.query(feeQuery, [
                  voteAccount,
                  identityAccount,
                  currentSlot,
                  epoch,
                  feeLamports,
                ]);

                // if insertion is successful, close the corresponding gap (if any)
                await closeResolvedGap(
                  voteAccount,
                  epoch,
                  "block_fees",
                  currentSlot,
                );
                continue; // proceed to the next slot
              }

              // if block was skipped, just go to the next slot
              if (blockOutcome === "skipped") {
                // If a slot failed once and is later classified as skipped, its gap row stays open forever, since only successful inserts close the gap. Hence, close the gap for skipped blocks too
                await closeResolvedGap(
                  voteAccount,
                  epoch,
                  "block_fees",
                  currentSlot,
                );
                continue;
              }

              // if block was pruned, add it to the list prunedSlots so that we can summarise it later when logging gap
              if (blockOutcome === "pruned") {
                prunedSlots.push(currentSlot);
                continue; // proceed to the next slot
              }

              // if blockOutcome is "unavailable" or "error", log the gap
              if (blockOutcome === "unavailable" || blockOutcome === "error") {
                let errorReason: string = "";
                if (blockData.ok) {
                  errorReason = "Unexpected empty block result.";
                } else {
                  errorReason = `Error encountered: ${blockData.kind} with code ${blockData.errorCode ?? "N/A"}. Error message: ${blockData.errorMessage ?? "N/A"}`;
                }
                await logGaps(
                  voteAccount,
                  epoch,
                  "block_fees",
                  `Slot #${currentSlot}: ${errorReason}`,
                  currentSlot,
                );
              }
            }
            // summarise the pruned slots, if any
            if (prunedSlots.length > 0) {
              const prunedSlotsErrorMessage = `${prunedSlots.length} of the total assigned ${assignedSlots.length} were pruned; slots (${prunedSlots[0]} to ${prunedSlots[prunedSlots.length - 1]})`;
              await logGaps(
                voteAccount,
                epoch,
                "block_fees",
                prunedSlotsErrorMessage,
              );
            } else if (prunedSlots.length === 0) {
              await closeResolvedGap(voteAccount, epoch, "block_fees");
            }
            const successfulSlots = slotCounts.success + slotCounts.stored;
            const failedSlots = slotCounts.error + slotCounts.unavailable;
            const numOfSlotsPruned = slotCounts.pruned;
            const skippedSlots = slotCounts.skipped;
            const totalActualSlots =
              successfulSlots + failedSlots + numOfSlotsPruned + skippedSlots;

            // log the slot stats for each epoch
            await saveEpochBlockStats(voteAccount, epoch, {
              assigned: assignedSlots.length,
              produced: successfulSlots,
              skipped: skippedSlots,
              pruned: numOfSlotsPruned,
              failed: failedSlots,
            });
            console.log(
              `Epoch #${epoch} produced -> Successful slots: ${successfulSlots}, Failed slots: ${failedSlots}, Pruned slots: ${numOfSlotsPruned}, Skipped slots: ${skippedSlots}. ${totalActualSlots}/${assignedSlots.length} slots accounted for.`,
            );
          }
        }
      } catch (error) {
        // first log the error into DB
        await logGaps(
          voteAccount,
          epoch,
          "block_fees",
          `Error when indexing block fees for epoch #${epoch}: ${error}`,
        );
      }
    }
  } finally {
    await pool.end();
    console.log("Database pool closed successfully. Gracefully shutting down.");
  }
}

// Helper function to log gaps or errors into DB
async function logGaps(
  voteAccount: string,
  epoch: number,
  dataType: string,
  reason: string,
  slot: number = epochLevel,
) {
  try {
    const queryString = `INSERT INTO INDEXING_GAPS (VALIDATOR_VOTE_ACCOUNT, EPOCH, DATA_TYPE, REASON, SLOT) VALUES ($1, $2, $3, $4, $5)`;
    await pool.query(queryString, [voteAccount, epoch, dataType, reason, slot]);
  } catch (error) {
    console.error(`Error encountered in logGaps() for epoch #${epoch}:`, error);
  }
}

// this function is to close a resolved gap/error, if any
async function closeResolvedGap(
  pVoteAccount: string,
  pEpoch: number,
  pDataType: string,
  pSlot: number = epochLevel,
) {
  try {
    const queryString = `UPDATE INDEXING_GAPS SET RESOLVED_DT = CURRENT_TIMESTAMP WHERE 
                          VALIDATOR_VOTE_ACCOUNT = $1
                          AND EPOCH = $2
                          AND DATA_TYPE = $3
                          AND SLOT = $4
                          AND RESOLVED_DT IS NULL;`;
    await pool.query(queryString, [pVoteAccount, pEpoch, pDataType, pSlot]);
  } catch (error) {
    console.error(`Error encountered in closeResolvedGap(): ${error}`);
  }
}

// Helper function to extract fees the validator earns from producing a block
function extractBlockFees(pBlockData: any, pIdentityAccount: string): number {
  let validatorFees: number = 0;
  // first we check if the block data is valid
  if (!pBlockData || !pBlockData.rewards) {
    console.log("Rewards data cannot be found in the block data.");
    return 0;
  }

  // if the block data is valid, we filter to extract the fees earned by the validator
  const feeData = pBlockData.rewards.find(
    (r: any) => r.pubkey === pIdentityAccount && r.rewardType === "Fee",
  );

  if (feeData) {
    validatorFees = feeData.lamports;
  }
  return validatorFees;
}

// this function helps to get the identity account corresponding to the vote account
async function decipherIdentity(pVoteAccount: string): Promise<string> {
  let identity: string = "";
  const accountInfo = await getAccountInfo(pVoteAccount);
  // first, we check if the account information was retrieved correctly, and if it is valid
  if (!accountInfo.ok) {
    throw new Error(
      `getAccountInfo() failed. Reason: ${accountInfo.kind} (code: ${accountInfo.errorCode ?? "N/A"}) - (${accountInfo.errorMessage ?? "Unknown error"})`,
    );
  }
  // second, we check if accountInfo carries a valid account
  // The RPC result is { context, value }
  if (!accountInfo.value?.value) {
    throw new Error(`Vote account(${pVoteAccount}) not found on chain.`);
  }
  const account = accountInfo.value.value;

  // third, we check if pVoteAccount is actually vote account
  if (account.data?.program !== "vote") {
    throw new Error(
      `The vote account (${pVoteAccount}) is not an actual vote account.`,
    );
  }

  // fourth, we get the public key (identity) only if the public key returned is valid
  if (!account.data.parsed?.info?.nodePubkey) {
    throw new Error(`No public key found for vote account ${pVoteAccount}`);
  }
  identity = account.data.parsed.info.nodePubkey;
  return identity;
}

// this function takes the newest 4 slots, arranged from latest to oldest, and then probes to see if any of them were pruned
// if the first non-skipped slot was pruned, it means the older slots before them should have also been pruned.
// if so, we do not need to look into the remaining 2000+ slots since they would have no data
async function probeEpoch(pSlots: number[]): Promise<BlockOutcome> {
  const newestSlotsFirst = pSlots.slice(-4).reverse();
  let currBlockOutcome: BlockOutcome = "skipped";
  for (const currSlot of newestSlotsFirst) {
    currBlockOutcome = getBlockOutcome(await getBlock(currSlot));
    if (currBlockOutcome !== "skipped") return currBlockOutcome; // return the blockOutcome of the first non-skipped slot
  }
  return currBlockOutcome;
}

// this method will return all the stored slots so that if the pipeline re-runs, we don't need to do an insert for those records
async function getStoredSlots(pVoteAccount: string, pEpoch: number) {
  const queryString = `SELECT SLOT FROM VALIDATOR_BLOCK_FEES WHERE VALIDATOR_VOTE_ACCOUNT = $1 AND EPOCH = $2 AND DELETE_IND = 'F'`;
  const queryResult = await pool.query(queryString, [pVoteAccount, pEpoch]);
  const storedSlots = new Set(queryResult.rows.map((row) => Number(row.slot)));
  return storedSlots;
}

// this function writes a query to help us keep track of the slot information of each epoch
async function saveEpochBlockStats(
  voteAccount: string,
  epoch: number,
  s: {
    assigned: number;
    produced: number;
    skipped: number;
    pruned: number;
    failed: number;
  },
) {
  const query = `INSERT INTO EPOCH_BLOCK_STATS (VALIDATOR_VOTE_ACCOUNT, EPOCH, ASSIGNED_SLOTS, PRODUCED_SLOTS, SKIPPED_SLOTS, PRUNED_SLOTS, FAILED_SLOTS)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (VALIDATOR_VOTE_ACCOUNT, EPOCH, DELETE_IND)
    DO UPDATE SET ASSIGNED_SLOTS = EXCLUDED.ASSIGNED_SLOTS, PRODUCED_SLOTS = EXCLUDED.PRODUCED_SLOTS,
      SKIPPED_SLOTS = EXCLUDED.SKIPPED_SLOTS, PRUNED_SLOTS = EXCLUDED.PRUNED_SLOTS,
      FAILED_SLOTS = EXCLUDED.FAILED_SLOTS, UPDATED_DT = CURRENT_TIMESTAMP`;
  await pool.query(query, [
    voteAccount,
    epoch,
    s.assigned,
    s.produced,
    s.skipped,
    s.pruned,
    s.failed,
  ]);
}

/* 
This function is to help us skip epochs that have been fully indexed. Suppose an epoch was already fully indexed, and got pruned. We don't want the pipeline to log a false gap when re-running over that epoch because it will rewrite the good stats in our EPOCH_BLOCK_STAT with inaccurate information. Epochs that are fully indexed never change, hence skip them.
*/
async function isEpochComplete(
  voteAccount: string,
  epoch: number,
): Promise<boolean> {
  const queryString = `SELECT 1 FROM EPOCH_BLOCK_STATS
     WHERE VALIDATOR_VOTE_ACCOUNT = $1 AND EPOCH = $2 AND DELETE_IND = 'F'
       AND PRUNED_SLOTS = 0 AND FAILED_SLOTS = 0
       AND PRODUCED_SLOTS + SKIPPED_SLOTS = ASSIGNED_SLOTS;`;
  const result = await pool.query(queryString, [voteAccount, epoch]);
  return result.rows.length > 0;
}

// Same logic as isEpochComplete, but this is for staking
async function hasStakingReward(voteAccount: string, epoch: number) {
  const queryString = `SELECT 1 FROM VALIDATOR_EPOCH_REWARDS WHERE VALIDATOR_VOTE_ACCOUNT = $1 AND EPOCH = $2 AND DELETE_IND = 'F';`;
  const result = await pool.query(queryString, [voteAccount, epoch]);
  return result.rows.length > 0;
}

main().catch(function (error: Error) {
  console.error("Pipeline encountered error: ", error);
  process.exitCode = 1;
});
