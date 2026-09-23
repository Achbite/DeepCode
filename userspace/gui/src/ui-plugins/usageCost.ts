import { useSettingsStore } from '../state/settingsStore';

export type UsageCostDisplay = { currency: 'USD' | 'CNY'; usdRate: number };

export function usageCostDisplay(currency: unknown): UsageCostDisplay {
  return currency === 'CNY' ? { currency: 'CNY', usdRate: 7 } : { currency: 'USD', usdRate: 1 };
}

export function formatUsageCost(value: number | null | undefined, display: UsageCostDisplay, locale: string) {
  return value == null ? '—' : new Intl.NumberFormat(locale, {
    style: 'currency', currency: display.currency, maximumFractionDigits: 4,
  }).format(value * display.usdRate);
}

export function useUsageCostDisplay() {
  return usageCostDisplay(useSettingsStore(state => state.effectiveSettings['gui.usageWidget.currency']));
}
