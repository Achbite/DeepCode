export const KERNEL_CATALOG_TOOL_IDS = [
  'fs.read',
  'fs.list',
  'fs.diff',
  'code.search',
  'fs.write',
  'fs.patch',
  'fs.delete',
  'git.status',
  'git.diff',
  'git.stage',
  'git.unstage',
  'git.commit',
  'git.push',
  'process.exec',
  'web.search',
  'web.fetch',
  'browser.open',
  'browser.reload',
  'browser.snapshot',
  'browser.inspect',
  'browser.click',
  'browser.type',
  'browser.scroll',
  'provider.call',
] as const;

const KERNEL_CATALOG_TOOL_ID_SET = new Set<string>(KERNEL_CATALOG_TOOL_IDS);

export function isKernelCatalogToolId(value: string): boolean {
  return KERNEL_CATALOG_TOOL_ID_SET.has(value);
}

export function actionBundleProtocolShapeLines(): string[] {
  return [
    'The nested actionBundle object must include {version,id,goal,actions,...}; goal is a short batch objective for review/audit text, not a permission grant or execution fact.',
    'actionBundle.actions[] are executable Kernel tool actions shaped {actionId,toolId,args,description,dependsOn?}. toolId must be a Kernel catalog id.',
    'fs.write actions must use args={path,sourceBlockId}; sourceBlockId references the top-level codeBlocks[].blockId that carries the exact file content.',
    'Directory targets are planning scopes, not executable write actions. Do not create empty .gitkeep or placeholder files unless the user explicitly requested that concrete file.',
    'actionBundle.continuationExpectations[] are non-executable continuation notes shaped {id,description,target?,reason?,dependsOn?}. They do not require toolId and never enter Kernel execution.',
    'actionBundle.validationExpectations[] are reviewable validation notes shaped {id,description,command?}.',
    'actionBundle.reviewExpectations[] are user review obligations shaped {id,description}.',
  ];
}

export function actionBundleProtocolShapeReference(): string {
  return actionBundleProtocolShapeLines().join('\n');
}

export function resourceRequestProtocolShapeLine(): string {
  return 'resourceRequest field must be shaped {version?,id?,reason?,items:[{id?,kind?:"file"|"directory"|"resource"|"search",manifestEntryId?,rootId?,path?,query?,include?,contextLines?,maxResults?,offsetBytes?,limitBytes?,reason?}]}. Use items[], not resources[].';
}

export function kernelCatalogToolIdList(): string {
  return KERNEL_CATALOG_TOOL_IDS.join(', ');
}
