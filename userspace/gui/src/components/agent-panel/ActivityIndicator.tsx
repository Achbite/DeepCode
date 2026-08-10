import React, { useEffect, useState } from 'react';
import './activityIndicator.css';

interface ActivityIndicatorProps {
  activityKey: string;
  label: string;
  variant?: 'default' | 'retry';
  showElapsedAfterMs?: number;
}

const ActivityIndicator: React.FC<ActivityIndicatorProps> = ({
  activityKey,
  label,
  variant = 'default',
  showElapsedAfterMs = 5_000,
}) => {
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const nextStartedAt = Date.now();
    setStartedAt(nextStartedAt);
    setNow(nextStartedAt);
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [activityKey]);

  const elapsedMs = Math.max(0, now - startedAt);
  const elapsedSeconds = Math.floor(elapsedMs / 1_000);

  return (
    <>
      <span
        className={`deepcode-activity-indicator deepcode-activity-indicator--${variant}`}
        aria-hidden="true"
      />
      <span>{label}</span>
      {elapsedMs >= showElapsedAfterMs && (
        <span className="deepcode-activity-indicator__elapsed" aria-hidden="true">
          {elapsedSeconds}s
        </span>
      )}
    </>
  );
};

export default ActivityIndicator;
