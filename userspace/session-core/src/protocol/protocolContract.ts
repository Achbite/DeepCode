export function actionBundleProtocolShapeLines(): string[] {
  return [
    'The nested actionBundle object must include {version,id,goal,actions,...}; goal is a short batch objective for review/audit text, not a permission grant or execution fact.',
    'actionBundle.actions[] are executable Kernel tool actions shaped {actionId,toolId,args,description}. toolId must be a Kernel catalog id.',
    'fs.create and fs.write actions use args={path,contentBlockId}; fs.edit uses args={path,replacementBlockId,patchSpec}. Block references resolve against top-level contentBlocks[].blockId.',
    'Directory targets are planning scopes, not executable write actions. Do not create empty .gitkeep or placeholder files unless the user explicitly requested that concrete file.',
    'actionBundle.continuationExpectations[] are non-executable continuation notes shaped {id,description,target?,reason?}. They do not require toolId and never enter Kernel execution.',
    'actionBundle.validationExpectations[] are optional reviewable validation notes shaped {id,description,command?}; Session derives routine defaults when omitted.',
    'actionBundle.reviewExpectations[] are optional user review obligations shaped {id,description}; Session derives routine defaults when omitted.',
  ];
}

export function actionBundleProtocolShapeReference(): string {
  return actionBundleProtocolShapeLines().join('\n');
}

export function resourceRequestProtocolShapeLine(): string {
  return 'resourceRequest field must be shaped {version?,id?,reason?,items:[{id?,kind?:"file"|"directory"|"resource"|"search",manifestEntryId?,rootId?,path?,query?,include?,contextLines?,maxResults?,offsetBytes?,limitBytes?,reason?}]}. Use items[], not resources[].';
}
