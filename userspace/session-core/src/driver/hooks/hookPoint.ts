export type HookPoint =
  | 'beforeUserTurn'
  | 'beforeProviderCall'
  | 'afterProviderCall'
  | 'beforeKernelCommand'
  | 'afterKernelCommand'
  | 'beforeProjectionAppend'
  | 'afterProjectionAppend';
