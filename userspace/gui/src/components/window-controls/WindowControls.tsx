import React from 'react';
import type { UiLanguage } from '../../i18n';
import './windowControls.css';

interface WindowControlsProps {
  language: UiLanguage;
}

const WindowControls: React.FC<WindowControlsProps> = ({ language }) => {
  void language;
  return null;
};

export default WindowControls;
