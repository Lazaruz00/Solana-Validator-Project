import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config(); // this loads environment variables from the .env file

// to create a connection to the Supabase PostgreSQL DB via the DATABASE_URL in .env
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// helper function to test the connection
export async function testConnection() {
  try {
    const client = await pool.connect();
    const result = await client.query("SELECT NOW()");
    console.log("Database connected successfully");
    console.log("Current DB timestamp: ", result.rows[0].now);
    client.release();
  } catch (error) {
    console.error("Error encountered when connecting to DB: ", error);
  }
}

// helper function to create the tables in DB
export async function createTables() {
  const createRewardTable =
    "CREATE TABLE IF NOT EXISTS VALIDATOR_EPOCH_REWARDS(" +
    "ID SERIAL PRIMARY KEY," +
    "VALIDATOR_VOTE_ACCOUNT VARCHAR(64) NOT NULL," +
    "EPOCH INT NOT NULL," +
    "STAKING_REWARD_LAMPORTS BIGINT NOT NULL," +
    "COMMISSION_PERCENTAGE INT," +
    "EFFECTIVE_SLOT BIGINT," +
    "CREATED_DT TIMESTAMP DEFAULT CURRENT_TIMESTAMP," +
    "UPDATED_DT TIMESTAMP DEFAULT CURRENT_TIMESTAMP," +
    "DELETE_IND VARCHAR(1) NOT NULL DEFAULT 'F'," +
    "CONSTRAINT UNIQUE_VALIDATOR_EPOCH UNIQUE (VALIDATOR_VOTE_ACCOUNT, EPOCH, DELETE_IND));";

  const createFeeTable =
    "CREATE TABLE IF NOT EXISTS VALIDATOR_BLOCK_FEES(" +
    "ID SERIAL PRIMARY KEY," +
    "VALIDATOR_VOTE_ACCOUNT VARCHAR(64) NOT NULL," +
    "IDENTITY_ACCOUNT VARCHAR(64) NOT NULL," +
    "SLOT BIGINT NOT NULL," +
    "EPOCH INT NOT NULL," +
    "FEE_LAMPORTS BIGINT NOT NULL," +
    "CREATED_DT TIMESTAMP DEFAULT CURRENT_TIMESTAMP," +
    "UPDATED_DT TIMESTAMP DEFAULT CURRENT_TIMESTAMP," +
    "DELETE_IND VARCHAR(1) NOT NULL DEFAULT 'F'," +
    "CONSTRAINT UNIQUE_VALIDATOR_SLOT UNIQUE (VALIDATOR_VOTE_ACCOUNT, SLOT, DELETE_IND));";

  const createErrorGapTable =
    "CREATE TABLE IF NOT EXISTS INDEXING_GAPS(" +
    "ID SERIAL PRIMARY KEY," +
    "VALIDATOR_VOTE_ACCOUNT VARCHAR(64) NOT NULL," +
    "EPOCH INT NOT NULL," +
    "SLOT BIGINT NOT NULL DEFAULT -1," +
    "DATA_TYPE VARCHAR(64) NOT NULL," +
    "REASON TEXT NOT NULL," +
    "CREATED_DT TIMESTAMP DEFAULT CURRENT_TIMESTAMP," +
    "RESOLVED_DT TIMESTAMP," +
    "UPDATED_DT TIMESTAMP DEFAULT CURRENT_TIMESTAMP," +
    "DELETE_IND VARCHAR(1) NOT NULL DEFAULT 'F');";

  const createEpochBlockStats =
    "CREATE TABLE IF NOT EXISTS EPOCH_BLOCK_STATS(" +
    "ID SERIAL PRIMARY KEY," +
    "VALIDATOR_VOTE_ACCOUNT VARCHAR(64) NOT NULL," +
    "EPOCH INT NOT NULL," +
    "ASSIGNED_SLOTS INT NOT NULL," +
    "PRODUCED_SLOTS INT NOT NULL," +
    "SKIPPED_SLOTS INT NOT NULL," +
    "PRUNED_SLOTS INT NOT NULL," +
    "FAILED_SLOTS INT NOT NULL," +
    "CREATED_DT TIMESTAMP DEFAULT CURRENT_TIMESTAMP," +
    "UPDATED_DT TIMESTAMP DEFAULT CURRENT_TIMESTAMP," +
    "DELETE_IND VARCHAR(1) NOT NULL DEFAULT 'F'," +
    "CONSTRAINT UNIQUE_VALIDATOR_EPOCH_SLOT_STAT UNIQUE (VALIDATOR_VOTE_ACCOUNT, EPOCH, DELETE_IND));";

  const queryString =
    createRewardTable +
    "\n" +
    createFeeTable +
    "\n" +
    createErrorGapTable +
    "\n" +
    createEpochBlockStats;
  try {
    await pool.query(queryString);
    console.log("DB tables have been successfully created!");
  } catch (error) {
    console.error("Error encountered when creating tables: ", error);
    throw error;
  }
}
