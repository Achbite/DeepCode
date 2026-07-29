import {
  contractCases as authorityCases,
} from './authority-contracts.mjs';
import {
  contractCases as loopCases,
} from './loop-contracts.mjs';
import {
  contractCases as recoveryCases,
} from './recovery-contracts.mjs';
import {
  contractCases as reviewCases,
} from './review-contracts.mjs';

const SUITE_ID = 'session.v2.contracts';
const cases = [
  ...authorityCases,
  ...loopCases,
  ...recoveryCases,
  ...reviewCases,
];

async function main() {
  if (
    process.env.DEEPCODE_TEST_CONTROLLER !== '1'
    || process.env.DEEPCODE_TEST_SUITE_ID !== SUITE_ID
  ) {
    throw new Error(
      'Session v2 contracts are internal; use bash ./test.sh --suite session.v2.contracts.'
    );
  }
  assertUniqueCaseIds(cases);
  console.log(
    `[INFO] ${SUITE_ID}: ${cases.length} authoritative contracts`
  );
  for (const contractCase of cases) {
    try {
      await contractCase.run();
      console.log(`[PASS] ${contractCase.id}`);
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : String(error);
      console.error(`[FAIL] ${contractCase.id}: ${detail}`);
      throw error;
    }
  }
}

function assertUniqueCaseIds(values) {
  const seen = new Set();
  for (const value of values) {
    if (
      !value
      || typeof value.id !== 'string'
      || !value.id.trim()
      || typeof value.run !== 'function'
    ) {
      throw new Error('Session v2 contract registration is invalid.');
    }
    if (seen.has(value.id)) {
      throw new Error(
        `duplicate Session v2 contract id: ${value.id}`
      );
    }
    seen.add(value.id);
  }
}

main().catch((error) => {
  if (!(error instanceof Error)) {
    console.error(String(error));
  }
  process.exitCode = 1;
});
