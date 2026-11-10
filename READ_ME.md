## How to set up and run

### Prerequisites

- Node.js 20 or newer
- A PostgreSQL database (I used Supabase)
- A Solana mainnet RPC endpoint. The public `api.mainnet-beta.solana.com` endpoint rejected some of the calls I needed (HTTP 501, "Method call not supported by this endpoint"), so I used a free-tier Helius endpoint. In practice `SOLANA_RPC_URL` has to be set.

### Install and configure

```bash
npm install
cp .env.example .env        # Windows: copy .env.example .env
```

Fill in `DATABASE_URL` and `SOLANA_RPC_URL` in `.env`. Run every command from the project root so `.env` is found.

### Template to run the pipeline

```bash
npm run index -- --vote <VOTE_ACCOUNT> [--from <epoch>] [--to <epoch>]
```

- `--vote` is required. `--from` defaults to 1000 and `--to` defaults to the latest completed epoch.
- The tables are created automatically on the first run.

```bash
# Examples on how to run the pipeline
# How to run the pipeline from epoch 1000 to latest completed epoch with the suggested validator
npm run index -- --vote FjkSLYmi6BJAJQn1iSLUGrPrBQjMaD4y1DVdnv3yaTsX

# A single epoch
npm run index -- --vote FjkSLYmi6BJAJQn1iSLUGrPrBQjMaD4y1DVdnv3yaTsX --from 1079 --to 1079
```

### Run the API

Run the pipeline first, since the API only reads from the database.

```bash
npm run api        # http://localhost:3000
```

| Endpoint                                  | Returns                                                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /validators/:vote/rewards?from=&to=` | Per epoch: staking reward (SOL), commission %, block fees (SOL), and the number of blocks with stored fees. `from` and `to` default to the range of stored data, and a request can span at most 1000 epochs. |
| `GET /validators/:vote/summary`           | Total staking rewards and total block fees (SOL), plus how many epochs each total covers.                                                                                                                    |

```bash
curl "http://localhost:3000/validators/<VOTE_ACCOUNT>/rewards?from=1079&to=1080"
curl "http://localhost:3000/validators/<VOTE_ACCOUNT>/summary"
# If running on Windows powershell, use curl.exe instead of curl
```

Amounts are returned as strings in SOL (9 decimal places) to avoid floating-point error. A `null` means no data is stored for that epoch.

---

## Explain how Solana staking reward works

I would imagine Solana to be a giant, worldwide video game running on thousands of computers at the same time. To make sure no one cheats or the system does not crash, the game (Solana) needs referees (validators). The more referees there are, the smoother, faster and cleaner the game runs. Suppose you have some coins (SOL) and you want to put them to good use by helping the network. You team up with the validator by entrusting it with your SOL coins (staking) and give it more voting power. As your 'investment' in the validator allowed it to become 'stronger' in securing the network and processing the blocks better, the network rewards you with bonus SOL coins to thank you.

## Main design decisions

A validator earns one staking reward per epoch but can produce many blocks in that epoch, each with its own fee. Putting both data in 1 table will result in multitudes of records with duplicate data in most of the columns. So I created 1 table called `VALIDATOR_EPOCH_REWARDS` to manage the macro-level reward (one row per epoch) and another `VALIDATOR_BLOCK_FEES` to manage the micro-level fees (one row per block). Each data table has a unique key (vote account + epoch, or vote account + slot) and every write is `INSERT ... ON CONFLICT DO UPDATE`. Running the pipeline twice over the same epoch can never create duplicates, hence ensuring idempotency.

Staking rewards are paid to the vote account, while the leader schedule and block fees belong to the identity account. The two are deliberately separate: if an identity key is compromised or hot-swapped to another server, the new identity is simply pointed at the same vote account. Therefore, I key everything by vote account, derive the identity from it with `getAccountInfo`, and store it on each fee row so a row can be traced back to the identity account that actually received the fee.

The indexer runs over the same epochs many times, and I wanted every failed attempt recorded with a fresh timestamp. That lets me tell an old prune from a transient network timeout, count how often something failed, and later write a backfill script from the open gaps. If I had given it a unique constraint like the other tables, each retry would overwrite the last and I would lose that history. The cost is that the table can't say which gaps are still open, so each row has a `RESOLVED_DT` that is set when the data is created. Open gaps are the rows where it is `NULL`. Gaps that have been closed will have the `RESOLVED_DT` updated to the date and time the issue was resolved. For blocks I separate skipped slots (no block was produced, so there is no fee and it is not a gap), pruned blocks, temporarily unavailable blocks and other errors. Pruned and failed slots are logged with the real RPC error.

I also created the table `EPOCH_BLOCK_STATS` to store how many slots were assigned, produced, skipped, pruned and failed for each epoch. They must add up to the assigned total, which makes a quick consistency check, and the produced and skipped counts are what I compare against the block explorers.

When re-running the pipeline, an epoch whose stats show nothing pruned or failed is skipped entirely. Same goes for staking rewards that are already stored. That matters because nodes prune old blocks: without the skip, a re-run months later would log false gaps and overwrite good stats. Before fetching an epoch I also probe its newest 4 assigned slots, because if that one is pruned then every older slot is too. Instead of processing the remaining slots in that epoch, I skip that epoch entirely and log it in `INDEXING_GAPS`.

---

## What I'd do next with more time

Fetching up to about 2,088 blocks per epoch one at a time is the slowest part of the pipeline. I'd add a small, bounded worker pool, around five parallel `getBlock` calls, rather than unbounded parallelism, because the provider rate-limits. Each worker would only fetch and classify a slot and return a plain result. The database writes would then be batched per epoch (one `INSERT ... SELECT FROM unnest(...)` upsert) instead of one query per slot. The same approach could later run several epochs in parallel, within the provider's limit.
