import {
  assert,
  hasEvent,
  hasFinalAssistantContent,
  runResourceScenario,
  type SmokeCase,
} from './harness.js';

export const smokeCases: SmokeCase[] = [
  { id: 'tools.resource_loop_reaches_answer', run: resourceLoopReachesAnswer },
];

async function resourceLoopReachesAnswer(): Promise<void> {
  const paths = Array.from({ length: 5 }, (_, index) => `history/resource-${index + 1}.md`);
  const scenario = await runResourceScenario({ id: 'tool-loop', paths });

  assert(
    paths.every((path) => scenario.resolvedResources.some((item) => item.path === path)),
    'every semantic resource request must cross the Kernel ResourceResolve boundary'
  );
  assert(
    scenario.providerRequests.length >= paths.length + 1,
    'the Loop must resume after every resource result and reach a final provider turn'
  );
  assert(
    hasFinalAssistantContent(
      scenario.result.events,
      'The requested runtime facts were incorporated.'
    ),
    'the resource Loop must converge to a final answer'
  );
  assert(!hasEvent(scenario.result.events, 'error'), 'the historical fixed-round failure must not return');
}
