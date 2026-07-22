import type { SmokeCase } from './harness.js';

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode?: number;
};

type SmokeModule = {
  smokeCases: SmokeCase[];
};

const LOADERS: Record<string, () => Promise<SmokeModule>> = {
  communication: () => import('./communicationSmoke.js'),
  tools: () => import('./toolsSmoke.js'),
  paths: () => import('./pathsSmoke.js'),
  authorization: () => import('./authorizationSmoke.js'),
};

async function main(): Promise<void> {
  const group = process.argv[2] ?? '';
  const loader = LOADERS[group];
  if (!loader) throw new Error(`unknown registered smoke group: ${group || '<empty>'}`);

  const expectedSuiteId = `session.smoke.${group}`;
  if (
    process.env.DEEPCODE_TEST_CONTROLLER !== '1'
    || process.env.DEEPCODE_TEST_SUITE_ID !== expectedSuiteId
    || process.env.DEEPCODE_TEST_SMOKE_GROUP !== group
  ) {
    throw new Error('Session smoke is internal; use bash ./test.sh --profile smoke.');
  }

  const registeredCaseIds = parseRegisteredCaseIds(process.env.DEEPCODE_TEST_CASE_IDS);
  const { smokeCases } = await loader();
  const implementationCaseIds = smokeCases.map((smokeCase) => smokeCase.id);
  if (JSON.stringify(registeredCaseIds) !== JSON.stringify(implementationCaseIds)) {
    throw new Error(
      `registry/runtime smoke case mismatch: registered=${JSON.stringify(registeredCaseIds)} `
      + `implemented=${JSON.stringify(implementationCaseIds)}`
    );
  }

  for (const smokeCase of smokeCases) {
    try {
      await smokeCase.run();
      console.log(`[PASS] ${smokeCase.id}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`[FAIL] ${smokeCase.id}: ${detail}`, { cause: error });
    }
  }
}

function parseRegisteredCaseIds(raw: string | undefined): string[] {
  if (!raw) throw new Error('controller did not provide DEEPCODE_TEST_CASE_IDS');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error('DEEPCODE_TEST_CASE_IDS is not valid JSON', { cause: error });
  }
  if (!Array.isArray(value) || !value.length || !value.every((item) => typeof item === 'string')) {
    throw new Error('DEEPCODE_TEST_CASE_IDS must be a non-empty string array');
  }
  return value;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
