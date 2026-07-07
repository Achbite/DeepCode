import type { ProviderTurnMode } from './runFrame.js';

export type RunCommand =
  | { readonly kind: 'initializeRun' }
  | { readonly kind: 'maybeBuildRequirementConfirmation' }
  | { readonly kind: 'waitForRequirementDecision' }
  | { readonly kind: 'prepareProviderTurn'; readonly mode: ProviderTurnMode }
  | { readonly kind: 'callProviderAndParse' }
  | { readonly kind: 'routeProposal' }
  | { readonly kind: 'resolveResourceRequest' }
  | { readonly kind: 'submitPlanProposal' }
  | { readonly kind: 'submitActionProposal' }
  | { readonly kind: 'executeAcceptedPlanTask' }
  | { readonly kind: 'assembleReview' }
  | { readonly kind: 'waitForUserDecision' }
  | { readonly kind: 'emitAnswer' }
  | { readonly kind: 'failClosed'; readonly code: string }
  | { readonly kind: 'terminal' };
