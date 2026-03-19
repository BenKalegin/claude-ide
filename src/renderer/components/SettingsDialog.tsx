import React, { useRef } from 'react';
import { THEMES, ThemeGroup, type ThemeId } from '../../core/themes';
import { applyTheme } from '../lib/theme-applier';
import { useSessionStore } from '../stores/session-store';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SettingsDialog({ open, onClose }: Props): React.ReactElement | null {
  const themeId = useSessionStore((s) => s.themeId);
  const setThemeId = useSessionStore((s) => s.setThemeId);
  const originalThemeRef = useRef(themeId);

  if (!open) return null;

  const darkThemes = THEMES.filter((t) => t.group === ThemeGroup.Dark);
  const lightThemes = THEMES.filter((t) => t.group === ThemeGroup.Light);

  const handleSelect = (id: ThemeId) => {
    applyTheme(id);
    setThemeId(id);
  };

  const handleClose = () => {
    originalThemeRef.current = themeId;
    onClose();
  };

  const handleCancel = () => {
    applyTheme(originalThemeRef.current);
    setThemeId(originalThemeRef.current);
    onClose();
  };

  return (
    <div className="settings-backdrop" onClick={handleCancel}>
      <div className="settings-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">Settings</span>
          <button className="settings-close" onClick={handleClose}>&times;</button>
        </div>
        <div className="settings-body">
          <div className="settings-section">
            <h3 className="settings-section-title">Dark Themes</h3>
            <div className="theme-grid">
              {darkThemes.map((t) => (
                <button
                  key={t.id}
                  className={`theme-card ${themeId === t.id ? 'theme-card-active' : ''}`}
                  onClick={() => handleSelect(t.id)}
                >
                  <div className="theme-card-preview">
                    <div className="theme-bar" style={{ background: t.colors.bgBase }} />
                    <div className="theme-bar" style={{ background: t.colors.accent }} />
                    <div className="theme-bar" style={{ background: t.colors.green }} />
                    <div className="theme-bar" style={{ background: t.colors.red }} />
                  </div>
                  <span className="theme-card-label">{t.label}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="settings-section">
            <h3 className="settings-section-title">Light Themes</h3>
            <div className="theme-grid">
              {lightThemes.map((t) => (
                <button
                  key={t.id}
                  className={`theme-card ${themeId === t.id ? 'theme-card-active' : ''}`}
                  onClick={() => handleSelect(t.id)}
                >
                  <div className="theme-card-preview">
                    <div className="theme-bar" style={{ background: t.colors.bgBase }} />
                    <div className="theme-bar" style={{ background: t.colors.accent }} />
                    <div className="theme-bar" style={{ background: t.colors.green }} />
                    <div className="theme-bar" style={{ background: t.colors.red }} />
                  </div>
                  <span className="theme-card-label">{t.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
