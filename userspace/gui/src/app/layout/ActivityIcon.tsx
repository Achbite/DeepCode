import React from 'react';
import UiIcon, { UI_ICON_ROLES } from '../../icons/registry';
export type ActivityIconName = keyof typeof UI_ICON_ROLES.activity;
export default function ActivityIcon({ name }: { name: ActivityIconName }) {
  return <UiIcon name={UI_ICON_ROLES.activity[name]} />;
}
