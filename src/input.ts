import { parseArgs } from "node:util";

// fallback for starting epoch
export const defaultStartingEpoch = 1000;

export function processInput() {
  const { values } = parseArgs({
    options: {
      vote: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
    },
  });

  if (!values.vote) {
    throw new Error("Vote account from input is missing!");
  }

  // if vote account is provided, decipher the input epochs
  const startingEpochFromInput = getEpochDetails("from", values.from);
  const lastEpochFromInput = getEpochDetails("to", values.to);

  const result = {
    voteAccount: values.vote,
    startEpoch: startingEpochFromInput,
    endEpoch: lastEpochFromInput,
  };
  return result;
}

function getEpochDetails(
  name: string,
  inputEpoch?: string,
): number | undefined {
  if (inputEpoch === undefined || inputEpoch === "") {
    return undefined;
  } else {
    const epochNum = Number(inputEpoch);
    if (!Number.isInteger(epochNum) || epochNum < 0) {
      throw new Error(`--${name} epoch provided is invalid: ${inputEpoch}`);
    }
    return epochNum;
  }
}
