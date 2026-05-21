import React, { useState } from 'react';
import './terminalPanel.css';

interface TerminalSession {
  id: string;
  name: string;
  shell: string;
  lines: string[];
}

const INITIAL_TERMINALS: TerminalSession[] = [
  {
    id: 'terminal-1',
    name: 'Terminal 1',
    shell: 'PowerShell',
    lines: [
      'DeepCode terminal surface',
      'Shell backend will attach here when node-pty is enabled.',
    ],
  },
];

const TerminalPlaceholder: React.FC = () => {
  const [sessions, setSessions] = useState<TerminalSession[]>(INITIAL_TERMINALS);
  const [activeId, setActiveId] = useState(INITIAL_TERMINALS[0].id);
  const active = sessions.find((session) => session.id === activeId) ?? sessions[0];

  const createTerminal = () => {
    const nextIndex = sessions.length + 1;
    const next: TerminalSession = {
      id: `terminal-${Date.now()}`,
      name: `Terminal ${nextIndex}`,
      shell: 'PowerShell',
      lines: ['New terminal session ready.'],
    };
    setSessions((prev) => [...prev, next]);
    setActiveId(next.id);
  };

  return (
    <div className="terminal-panel">
      <div className="terminal-panel__body">
        <div className="terminal-panel__screen">
          {active.lines.map((line, index) => (
            <div key={`${active.id}:${index}`}>{line}</div>
          ))}
          <div className="terminal-panel__prompt">
            <span>{active.shell}</span>
            <span className="terminal-panel__cursor">_</span>
          </div>
        </div>
        <aside className="terminal-panel__sessions" aria-label="Terminal sessions">
          {sessions.map((session) => (
            <button
              key={session.id}
              className={`terminal-panel__session ${
                session.id === active.id ? 'terminal-panel__session--active' : ''
              }`}
              onClick={() => setActiveId(session.id)}
              type="button"
              title={session.name}
            >
              <span className="terminal-panel__session-icon">›_</span>
              <span className="terminal-panel__session-name">{session.name}</span>
            </button>
          ))}
          <button
            className="terminal-panel__session terminal-panel__session--new"
            onClick={createTerminal}
            type="button"
            title="New terminal"
          >
            <span className="terminal-panel__session-icon">+</span>
            <span className="terminal-panel__session-name">new terminal</span>
          </button>
        </aside>
      </div>
    </div>
  );
};

export default TerminalPlaceholder;
