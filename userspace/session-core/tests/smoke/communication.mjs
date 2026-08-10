import { answerOutput, assert, openSmokeSession } from './runner.mjs';

export const smokeCases = [
  { id: 'communication.run_open_tool_context', run: runOpenToolContext },
  { id: 'communication.instruction_answer_roundtrip',
    run: instructionAnswerRoundtrip },
];

async function runOpenToolContext() {
  const instruction = 'Inspect the current Kernel ToolContext before answering.';
  let providerInput;
  const smoke = await openSmokeSession({
    instruction,
    async provider(input) {
      providerInput = input;
      return answerOutput('ToolContext reached the Session provider turn.');
    },
  });
  const result = await smoke.runner.runInitialTurn();
  assert(result.kind === 'answer', 'the initial Provider turn must answer');
  assert(smoke.state.runOpenRequests.length === 1,
    'Host RunOpen must be invoked exactly once');
  assert(smoke.state.runOpenRequests[0].workspaceBindingRef
      === smoke.workspaceBindingRef,
  'RunOpen must preserve the workspace binding reference');
  assert(providerInput, 'the production Session v2 Provider port must run');
  assert(providerInput.toolContext.bundle.fixedPrompt
      === smoke.toolContext.fixedPrompt,
  'Kernel fixedPrompt must reach Provider without Session rewriting');
  assert(providerInput.toolContext.bundle.tools.length === 1
      && providerInput.toolContext.bundle.tools[0].toolId === 'fs.read',
  'the decoded ready tool descriptor must reach Provider');
  assert(providerInput.contextAssembly.messages[0].role === 'system'
      && providerInput.contextAssembly.messages[0].content
        === smoke.toolContext.fixedPrompt,
  'Provider context must begin with the exact Kernel block');
  assert(!Object.hasOwn(providerInput, 'runCapability'),
    'Provider input must not expose transport capability');
}

async function instructionAnswerRoundtrip() {
  const instruction = 'Answer using the instruction for this Session turn.';
  const answer = 'The current Session v2 instruction was received.';
  let providerInput;
  const smoke = await openSmokeSession({
    instruction,
    async provider(input) {
      providerInput = input;
      return answerOutput(answer);
    },
  });
  const result = await smoke.runner.runInitialTurn();
  assert(providerInput?.currentInput.text === instruction,
    'the current user instruction must reach Provider');
  assert(providerInput.contextAssembly.messages.some(
    (message) => message.content.includes(instruction)
  ), 'the current instruction must remain in Provider context');
  assert(result.kind === 'answer' && result.text === answer,
    'the Provider answer must become the Session Loop result');
  assert(smoke.state.projections.some((projection) =>
    projection.kind === 'provider.completed'
      && projection.data?.result?.kind === 'answer'
      && projection.data.result.text === answer
  ), 'the final answer must be projected from the completed Provider turn');
}
