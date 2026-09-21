import type { UiLanguage } from '../../i18n';
import ThemeLibrarySettings from './ThemeLibrarySettings';
import GuiFontSettings from './GuiFontSettings';
import './appearanceConfiguration.css';

export default function AppearanceConfiguration({ language }: { language: UiLanguage }) {
  return <div className="appearance-configuration">
    <ThemeLibrarySettings language={language} />
    <GuiFontSettings language={language} />
  </div>;
}
