import type { ReactNode } from 'react';
import { UiPluginSlotView, useDisplayTheme } from './UiPlugins';
import type { UiPluginInput, UiRegionData, UiRegionSlot, UiViewActions } from './types';
import { useSettingsStore } from '../state/settingsStore';
export function UiRegion({ slot, children, regions, input, data, actions }: {
  slot: UiRegionSlot; children?: ReactNode; regions?: Record<string, ReactNode>;
  input?: UiPluginInput; data?: Readonly<UiRegionData>; actions?: UiViewActions;
}) {
  const theme = useDisplayTheme();
  const locale = String(useSettingsStore(state => state.effectiveSettings['workbench.language']) ?? 'zh-CN');
  const content = regions ?? { content: children };
  return <UiPluginSlotView slot={slot} input={input ?? { kind: 'region', slot, regionNames: Object.keys(content), data, locale, theme }} regions={content} actions={actions}>{null}</UiPluginSlotView>;
}
