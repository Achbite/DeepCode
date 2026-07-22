import {
  assert,
  hasFinalAssistantContent,
  runResourceScenario,
  type SmokeCase,
} from './harness.js';

export const smokeCases: SmokeCase[] = [
  { id: 'paths.resource_request_preserves_target', run: resourceRequestPreservesTarget },
];

async function resourceRequestPreservesTarget(): Promise<void> {
  const requestedPath = 'docs/runtime-guide.md';
  const scenario = await runResourceScenario({ id: 'resource-path', paths: [requestedPath] });

  const selectedRoot = scenario.resolvedResources.find((item) => item.path === '.');
  const resolved = scenario.resolvedResources.find((item) => item.path === requestedPath);
  assert(
    resolved?.path === requestedPath,
    `ResourceResolve must preserve the requested logical target: ${resolved?.path ?? '<missing>'}`
  );
  assert(Boolean(selectedRoot?.rootId), 'the user-selected attachment must establish a root identity');
  assert(
    resolved?.rootId === selectedRoot?.rootId,
    'the requested relative path must retain the user-selected root identity'
  );
  assert(
    hasFinalAssistantContent(
      scenario.result.events,
      'The requested runtime facts were incorporated.'
    ),
    'the path-bound resource fact must remain usable by the resumed provider turn'
  );
}
