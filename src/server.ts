import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { pool } from "./database";

const portNumber = Number(process.env.PORT ?? 3000);
const maxEpochRange = 1000; // to safeguard against unrealistic ranges
const maxInt = 2147483647;

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// this function helps to validate if the vote account provided is a valid format for Solana's vote account address
function validateVoteAccInput(pInput: unknown): string {
  if (
    typeof pInput !== "string" ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pInput)
  ) {
    throw new HttpError(400, "Invalid vote account address provided.");
  }
  return pInput;
}

// this function helps to validate the input epoch number, and ensures that it is valid. If so, returns it as an int
function validateEpochNumberInput(
  pInput: unknown,
  boundary: string,
): number | undefined {
  if (pInput === undefined) {
    return undefined;
  }
  if (typeof pInput !== "string" || !/^\d+$/.test(pInput)) {
    throw new HttpError(400, `${boundary} epoch limit is invalid`);
  }
  const limit = Number(pInput);
  if (limit > maxInt) {
    throw new HttpError(400, `Epoch limit ${limit} too large!`);
  }
  return limit;
}

type AsyncHandler = (request: Request, response: Response) => Promise<void>;
/* 
Express calls each route handler via (request, response, next). Async route handlers return a promise, but if a promise rejects due to issues with validation error/DB failure, we wrap that handler and pass the failure to next(error), which then sends it for error-handling. This prevents the error from getting lost and making the request hang.
*/
function route(handler: AsyncHandler) {
  return async function (req: Request, res: Response, next: NextFunction) {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };
}

const app = express();

// an api that lets someone see a validator's rewards per epoch over a range
app.get(
  "/validators/:vote/rewards",
  route(async (req, res) => {
    const vote = validateVoteAccInput(req.params.vote);
    // we use 'let' instead of const because if the from/to epoch limit is invalid, we will initialise with a min(epoch)/max(epoch) from our db
    let from = validateEpochNumberInput(req.query.from, "from");
    let to = validateEpochNumberInput(req.query.to, "to");

    // if from or to limits are undefined or invalid, we default to the minimum epoch and maximum epoch in our DB
    if (from === undefined || to === undefined) {
      const existingBounds = await pool.query<{
        min_epoch: number | null;
        max_epoch: number | null;
      }>(
        `SELECT MIN(EPOCH)::int AS MIN_EPOCH, MAX(EPOCH)::int AS MAX_EPOCH FROM (
            SELECT EPOCH FROM VALIDATOR_EPOCH_REWARDS WHERE VALIDATOR_VOTE_ACCOUNT = $1 AND DELETE_IND = 'F'
            UNION ALL
            SELECT EPOCH FROM VALIDATOR_BLOCK_FEES WHERE VALIDATOR_VOTE_ACCOUNT = $1 AND DELETE_IND = 'F'
            ) SUBQUERY`,
        [vote],
      );
      const { min_epoch, max_epoch } = existingBounds.rows[0];
      if (min_epoch === null || max_epoch === null) {
        throw new HttpError(404, "No data found for this validator.");
      }
      from = from ?? min_epoch;
      to = to ?? max_epoch;
    }

    // some sanity check
    if (from > to) {
      throw new HttpError(
        400,
        `Lower limit (${from}) of epoch range is larger than the upper limit (${to})!`,
      );
    }
    if (to - from + 1 > maxEpochRange) {
      throw new HttpError(400, "Range input is too large!");
    }

    const rewardQueryString = `SELECT E.EPOCH,
       ROUND(R.STAKING_REWARD_LAMPORTS::numeric / 1000000000, 9) AS STAKING_REWARD_SOL,
       R.COMMISSION_PERCENTAGE,
       ROUND(F.BLOCK_FEES_LAMPORTS::numeric / 1000000000, 9) AS BLOCK_FEES_SOL,
       F.BLOCKS_WITH_FEES
       FROM GENERATE_SERIES($2::int, $3::int) AS E(EPOCH)
       LEFT JOIN (
            SELECT EPOCH, STAKING_REWARD_LAMPORTS, COMMISSION_PERCENTAGE
            FROM VALIDATOR_EPOCH_REWARDS
            WHERE VALIDATOR_VOTE_ACCOUNT = $1
            AND DELETE_IND = 'F'
        ) R ON R.EPOCH = E.EPOCH
       LEFT JOIN (
            SELECT EPOCH, SUM(FEE_LAMPORTS) AS BLOCK_FEES_LAMPORTS, COUNT(*)::int AS BLOCKS_WITH_FEES
            FROM VALIDATOR_BLOCK_FEES
            WHERE VALIDATOR_VOTE_ACCOUNT = $1
            AND EPOCH BETWEEN $2 AND $3
            AND DELETE_IND = 'F'
            GROUP BY EPOCH
        ) F ON F.EPOCH = E.EPOCH
        ORDER BY E.EPOCH;`;
    const epochRewardQueryResult = await pool.query(rewardQueryString, [
      vote,
      from,
      to,
    ]);

    res.json({
      voteAccount: vote,
      from,
      to,
      epochs: epochRewardQueryResult.rows.map((r) => ({
        epoch: r.epoch,
        stakingRewardSol: r.staking_reward_sol,
        commissionPercentage: r.commission_percentage,
        blockFeesSol: r.block_fees_sol,
        blocksWithFees: r.blocks_with_fees, // could potentially be null since there might an epoch with no stored fees
      })),
    });
  }),
);

// an api that lets someone see a validator's rewards overall
app.get(
  "/validators/:vote/summary",
  route(async (req, res) => {
    const vote = validateVoteAccInput(req.params.vote);
    const summaryQueryString = `
            SELECT
                (SELECT COUNT(*)::int FROM VALIDATOR_EPOCH_REWARDS WHERE VALIDATOR_VOTE_ACCOUNT = $1 AND DELETE_IND = 'F') AS EPOCHS_WITH_STAKING,
                (SELECT COALESCE(ROUND(SUM(STAKING_REWARD_LAMPORTS) / 1000000000, 9), 0)::text FROM VALIDATOR_EPOCH_REWARDS WHERE VALIDATOR_VOTE_ACCOUNT = $1 AND DELETE_IND = 'F') AS STAKING_TOTAL_SOL,
                (SELECT COUNT(DISTINCT EPOCH)::int FROM VALIDATOR_BLOCK_FEES WHERE VALIDATOR_VOTE_ACCOUNT = $1 AND DELETE_IND = 'F') AS EPOCHS_WITH_FEES,
                (SELECT COUNT(*)::int FROM VALIDATOR_BLOCK_FEES WHERE VALIDATOR_VOTE_ACCOUNT = $1 AND DELETE_IND = 'F') AS BLOCKS_WITH_FEES,
                (SELECT COALESCE(ROUND(SUM(FEE_LAMPORTS) / 1000000000, 9), 0)::text FROM VALIDATOR_BLOCK_FEES WHERE VALIDATOR_VOTE_ACCOUNT = $1 AND DELETE_IND = 'F') AS FEES_TOTAL_SOL;
        `;
    const summaryRewardQueryResult = await pool.query(summaryQueryString, [
      vote,
    ]);
    const resContainer = summaryRewardQueryResult.rows[0];
    if (
      resContainer.epochs_with_staking === 0 &&
      resContainer.blocks_with_fees === 0
    ) {
      throw new HttpError(404, `No data stored for this validator ${vote}`);
    }

    // return result
    res.json({
      voteAccount: vote,
      stakingRewards: {
        epochsCovered: resContainer.epochs_with_staking,
        totalSolRewarded: resContainer.staking_total_sol,
      },
      blockFees: {
        epochsCovered: resContainer.epochs_with_fees,
        totalBlocks: resContainer.blocks_with_fees,
        totalFeesInSol: resContainer.fees_total_sol,
      },
    });
  }),
);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error("Unhandled API error:", err);
  res.status(500).json({ error: "Internal server error" });
});

const server = app.listen(portNumber, () =>
  console.log(`API listening on http://localhost:${portNumber}`),
);

process.on("SIGINT", () => {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
});
