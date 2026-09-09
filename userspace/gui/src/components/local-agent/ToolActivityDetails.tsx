import React, { useState } from 'react';
import type { ActivityProjection, AssistantDraftBlockProjection, ProviderHostedActivityProjection } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import { FileChanges } from './FileChanges';

interface ToolActivityGroupProps {
  activities: ActivityProjection[];
  language: UiLanguage;
  onExpand(): void;
  onOpenWorkspaceResource(workspaceId: string, logicalPath: string): void;
}

interface ProviderHostedDraftGroupProps {
  blocks: Array<Extract<AssistantDraftBlockProjection, { kind: 'providerHosted' }>>;
  language: UiLanguage;
  onExpand(): void;
}

export const ProviderHostedDraftGroup: React.FC<ProviderHostedDraftGroupProps> = ({
  blocks,
  language,
  onExpand,
}) => {
  const [expanded, setExpanded] = useState(true);
  const failed = blocks.some((block) => block.status === 'failed');
  const summary = failed
      ? t(language, 'agent.providerHosted.summary.didNotCompleteMany', { count: blocks.length })
      : t(language, 'agent.providerHosted.summary.completedMany', { count: blocks.length });
  return (
    <article className={`local-agent__tool-group${expanded ? ' local-agent__tool-group--expanded' : ''}${failed ? ' local-agent__tool-group--failed' : ''}`}>
      {blocks.length > 1 && <button
        type="button"
        className="local-agent__tool-group-summary"
        aria-expanded={expanded}
        onClick={() => {
          if (!expanded) onExpand();
          setExpanded((current) => !current);
        }}
      >
        <span className="local-agent__tool-group-icon">
          <DeepCodeShellIcon name="search" />
        </span>
        <strong>{summary}</strong>
        <span className="local-agent__tool-group-chevron" aria-hidden="true">
          <DeepCodeShellIcon name="chevronRight" />
        </span>
      </button>}
      {(blocks.length === 1 || expanded) && (
        <div className="local-agent__tool-group-items">
          {blocks.map((block) => (
            <ProviderHostedEntry
              key={block.providerCallId}
              hosted={block}
              status={block.status}
              language={language}
            />
          ))}
        </div>
      )}
    </article>
  );
};

export const ToolActivityGroup: React.FC<ToolActivityGroupProps> = ({
  activities,
  language,
  onExpand,
  onOpenWorkspaceResource,
}) => {
  const [expanded, setExpanded] = useState(true);
  const hasFailure = activities.some((activity) => (
    ['failed', 'denied', 'rejected', 'indeterminate'].includes(activity.status)
  ));
  const groupStatus = toolGroupStatus(activities);

  return (
    <article className={`local-agent__tool-group${expanded ? ' local-agent__tool-group--expanded' : ''}${hasFailure ? ' local-agent__tool-group--failed' : ''}`}>
      {activities.length > 1 && <button
        type="button"
        className="local-agent__tool-group-summary"
        aria-expanded={expanded}
        onClick={() => {
          if (!expanded) onExpand();
          setExpanded((current) => !current);
        }}
      >
        <span className="local-agent__tool-group-icon">
          <DeepCodeShellIcon
            name={activities.every((activity) => activity.kind === 'providerHosted')
              ? 'search'
              : 'tool'}
          />
        </span>
        <strong>{toolGroupSummary(activities, language)}</strong>
        {groupStatus !== 'completed' && (
          <span>{toolActivityStatus(groupStatus, language)}</span>
        )}
        <span className="local-agent__tool-group-chevron" aria-hidden="true">
          <DeepCodeShellIcon name="chevronRight" />
        </span>
      </button>}
      {(activities.length === 1 || expanded) && (
        <div className="local-agent__tool-group-items">
          {activities.map((activity) => (
            <ToolActivityEntry
              activity={activity}
              key={activity.activityId}
              language={language}
              onOpenWorkspaceResource={onOpenWorkspaceResource}
            />
          ))}
        </div>
      )}
    </article>
  );
};

interface ProviderHostedEntryProps {
  hosted: ProviderHostedActivityProjection;
  status: ActivityProjection['status'];
  language: UiLanguage;
}

const ProviderHostedEntry: React.FC<ProviderHostedEntryProps> = ({ hosted, status, language }) => {
  const [expanded, setExpanded] = useState(false);
  const actionType = providerHostedActionType(hosted.action);
  const fieldLabels: Record<string, string> = {
    queries: 'agent.providerHosted.detail.queries',
    query: 'agent.providerHosted.detail.queries',
    url: 'agent.providerHosted.detail.url',
    pattern: 'agent.providerHosted.detail.pattern',
    sources: 'agent.providerHosted.detail.sources',
  };
  return (
    <div className={`local-agent__tool-entry local-agent__tool-entry--${status}`}>
      <button type="button" className="local-agent__tool-entry-heading" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <span className="local-agent__tool-entry-icon"><DeepCodeShellIcon name="search" /></span>
        <strong>{providerHostedSummary(hosted, status, language)}</strong>
        {status !== 'completed' && <span>{toolActivityStatus(status, language)}</span>}
        <span className="local-agent__tool-entry-chevron" aria-hidden="true"><DeepCodeShellIcon name="chevronRight" /></span>
      </button>
      {expanded && <div className="local-agent__tool-entry-details">
        <dl>
          <div>
            <dt>{t(language, 'agent.providerHosted.detail.status')}</dt>
            <dd>{toolActivityStatus(status, language)}</dd>
          </div>
          {actionType && (
            <div>
              <dt>{t(language, 'agent.providerHosted.detail.action')}</dt>
              <dd><code>{actionType}</code></dd>
            </div>
          )}
          {Object.entries(hosted.action).filter(([field]) => field !== 'type').map(([field, value]) => (
            <div key={field}>
              <dt>{fieldLabels[field] ? t(language, fieldLabels[field]) : field}</dt>
              <dd><code>{typeof value === 'string'
                ? value
                : Array.isArray(value) && value.every((item) => typeof item === 'string')
                  ? value.join('\n')
                  : JSON.stringify(value, null, 2)}</code></dd>
            </div>
          ))}
          <div>
            <dt>{t(language, 'agent.providerHosted.detail.providerTool')}</dt>
            <dd><code>{hosted.providerToolType}</code></dd>
          </div>
          <div>
            <dt>{t(language, 'agent.providerHosted.detail.providerCallId')}</dt>
            <dd><code>{hosted.providerCallId}</code></dd>
          </div>
        </dl>
      </div>}
    </div>
  );
};

interface ToolActivityEntryProps {
  activity: ActivityProjection;
  language: UiLanguage;
  onOpenWorkspaceResource(workspaceId: string, logicalPath: string): void;
}

const ToolActivityEntry: React.FC<ToolActivityEntryProps> = ({
  activity,
  language,
  onOpenWorkspaceResource,
}) => {
  const [expanded, setExpanded] = useState(false);
  const tool = activity.tool;
  const shell = tool?.shell;
  const result = shell?.result;
  const resources = tool?.resources.filter((resource) => !(resource.kind === 'workspacePath'
    && tool.fileChanges?.some((change) => change.workspaceId === resource.workspaceId && change.path === resource.logicalPath))) ?? [];
  if (activity.providerHosted) {
    return (
      <ProviderHostedEntry
        hosted={activity.providerHosted}
        status={activity.status}
        language={language}
      />
    );
  }
  return (
    <div className={`local-agent__tool-entry local-agent__tool-entry--${activity.status}`}>
      <button
        type="button"
        className="local-agent__tool-entry-heading"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="local-agent__tool-entry-icon"><DeepCodeShellIcon name={shell ? 'terminal' : isFileMutationOperation(tool?.operation) ? 'compose' : tool?.operation?.startsWith('fs.') ? 'artifact' : 'tool'} /></span>
        <strong>{toolActivitySummary(activity, language)}</strong>
        {activity.status !== 'completed' && (
          <span>{toolActivityStatus(activity.status, language)}</span>
        )}
        <span className="local-agent__tool-entry-chevron" aria-hidden="true">
          <DeepCodeShellIcon name="chevronRight" />
        </span>
      </button>
      {expanded && (
        <div className="local-agent__tool-entry-details">
          <FileChanges activities={[activity]} compact />
          <dl>
            <div>
              <dt>{t(language, 'agent.tool.detail.operation')}</dt>
              <dd><code>{tool?.operation ?? activity.label}</code></dd>
            </div>
            {shell && (
              <>
                <div>
                  <dt>{t(language, 'agent.tool.shell.command')}</dt>
                  <dd><code>{shell.command}</code></dd>
                </div>
                <div>
                  <dt>{t(language, 'agent.tool.shell.cwd')}</dt>
                  <dd><code>{shell.cwd}</code></dd>
                </div>
                {result && (
                  <>
                    <div>
                      <dt>{t(language, 'agent.tool.shell.environment')}</dt>
                      <dd>{t(language, 'agent.tool.shell.environmentValue', {
                        shell: result.environment.shell,
                      })}</dd>
                    </div>
                    <div>
                      <dt>{t(language, 'agent.tool.shell.writeScope')}</dt>
                      <dd>{t(
                        language,
                        `agent.tool.shell.writeScope.${result.environment.writeScope}`,
                      )}</dd>
                    </div>
                  </>
                )}
              </>
            )}
          </dl>
          {activity.inputRejection && (
            <div className="local-agent__input-rejection">
              <p>{activity.inputRejection.message}</p>
              {activity.inputRejection.issues.map((issue, index) => (
                <div key={`${issue.path}:${issue.rule}:${index}`}>
                  <code>{issue.path}</code><span>{issue.message}</span>
                  {issue.expected !== undefined && <code>{JSON.stringify(issue.expected)}</code>}
                </div>
              ))}
            </div>
          )}
          {resources.length > 0 && (
            <div className="local-agent__tool-resources">
              {resources.map((resource, index) => {
                const key = `${resource.kind}:${resource.workspaceId ?? ''}:${resource.logicalPath ?? resource.uri ?? resource.label}:${index}`;
                if (
                  resource.kind === 'workspacePath'
                  && resource.workspaceId
                  && resource.logicalPath
                ) {
                  return (
                    <button
                      type="button"
                      key={key}
                      onClick={() => onOpenWorkspaceResource(
                        resource.workspaceId!, resource.logicalPath!,
                      )}
                    >
                      {resource.label}
                    </button>
                  );
                }
                if (resource.kind === 'url' && resource.uri) {
                  return (
                    <a href={resource.uri} key={key} rel="noreferrer" target="_blank">
                      {resource.label}
                    </a>
                  );
                }
                return <span key={key}>{resource.label}</span>;
              })}
            </div>
          )}
          {result && (
            <div className="local-agent__shell-result">
              <div className="local-agent__shell-result-meta">
                <span>{t(language, 'agent.tool.shell.exit', {
                  code: result.exitCode ?? t(language, 'agent.tool.shell.noExitCode'),
                })}</span>
                <span>{t(language, 'agent.tool.shell.duration', {
                  duration: result.durationMs,
                })}</span>
                {result.timedOut && <span>{t(language, 'agent.tool.shell.timedOut')}</span>}
                {result.truncated && <span>{t(language, 'agent.tool.shell.truncated')}</span>}
              </div>
              {result.stdout && (
                <section>
                  <span>{t(language, 'agent.tool.shell.stdout')}</span>
                  <pre>{result.stdout}</pre>
                </section>
              )}
              {result.stderr && (
                <section>
                  <span>{t(language, 'agent.tool.shell.stderr')}</span>
                  <pre>{result.stderr}</pre>
                </section>
              )}
              {!result.stdout && !result.stderr && (
                <small>{t(language, 'agent.tool.shell.noOutput')}</small>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

function toolGroupSummary(
  activities: ActivityProjection[],
  language: UiLanguage,
): string {
  const status = toolGroupStatus(activities);
  if (activities.every((activity) => activity.kind === 'providerHosted')) {
    if (status === 'completed') {
      return t(language, 'agent.providerHosted.summary.completedMany', {
        count: activities.length,
      });
    }
    if (['failed', 'cancelled', 'indeterminate', 'denied'].includes(status)) {
      return t(language, 'agent.providerHosted.summary.didNotCompleteMany', {
        count: activities.length,
      });
    }
    return t(language, 'agent.providerHosted.summary.activeMany', {
      count: activities.length,
    });
  }
  if (status === 'active') {
    return t(language, 'agent.tool.summary.activeMany', { count: activities.length });
  }
  if (status === 'requested') {
    return t(language, 'agent.tool.summary.requestedMany', { count: activities.length });
  }
  if (status === 'waiting') {
    return t(language, 'agent.tool.summary.waitingMany', { count: activities.length });
  }
  if (status === 'completed') {
    const hasShell = activities.some((activity) => (
      activity.tool?.operation === 'bash'
    ));
    const editCount = activities.filter((activity) => (
      isFileMutationOperation(activity.tool?.operation)
    )).length;
    if (hasShell && editCount > 0) {
      return t(language, 'agent.tool.summary.editedAndRan');
    }
    if (editCount === activities.length) {
      return t(language, 'agent.tool.summary.editedMany', { count: editCount });
    }
  }
  return t(language, 'agent.tool.summary.usedMany', { count: activities.length });
}

function toolActivitySummary(activity: ActivityProjection, language: UiLanguage): string {
  if (activity.kind === 'providerHosted' && activity.providerHosted) {
    return providerHostedSummary(activity.providerHosted, activity.status, language);
  }
  const operation = activity.tool?.operation ?? activity.label;
  const target = activity.tool?.resources[0]?.label;
  const command = activity.tool?.shell?.command;
  if (activity.status === 'completed') {
    if (operation === 'bash' && command) {
      return t(language, 'agent.tool.activity.ranCommand', { command });
    }
    if (operation === 'fs.delete' && target) {
      return t(language, 'agent.tool.activity.deletedPath', { path: target });
    }
    if (isFileMutationOperation(operation) && target) {
      return t(language, 'agent.tool.activity.editedPath', { path: target });
    }
    if (operation === 'fs.read' && target) {
      return t(language, 'agent.tool.activity.readPath', { path: target });
    }
    return t(language, 'agent.tool.summary.usedOne', { operation });
  }
  if (['failed', 'denied', 'rejected', 'indeterminate', 'cancelled'].includes(activity.status)) {
    if (operation === 'bash' && command) {
      return t(language, 'agent.tool.activity.commandDidNotComplete', { command });
    }
    return t(language, 'agent.tool.activity.didNotComplete', {
      operation,
      target: target ? ` · ${target}` : '',
    });
  }
  if (operation === 'bash' && command) {
    return t(language, 'agent.tool.activity.runningCommand', { command });
  }
  return t(language, 'agent.tool.activity.runningOperation', {
    operation,
    target: target ? ` · ${target}` : '',
  });
}

function providerHostedSummary(hosted: ProviderHostedActivityProjection, status: ActivityProjection['status'], language: UiLanguage): string {
  const target = providerHostedActionTarget(hosted.action);
  const state = status === 'completed' ? 'completed'
    : ['failed', 'denied', 'indeterminate', 'cancelled'].includes(status) ? 'didNotComplete' : 'active';
  return target ? t(language, `agent.providerHosted.summary.${state}Target`, { target })
    : t(language, `agent.providerHosted.summary.${state}`);
}

function providerHostedActionType(action: Record<string, unknown> | undefined): string {
  return typeof action?.type === 'string' ? action.type : '';
}

function providerHostedActionTarget(action: Record<string, unknown> | undefined): string {
  if (!action) return '';
  if (Array.isArray(action.queries)) {
    const queries = action.queries.filter((query): query is string => (
      typeof query === 'string' && query.length > 0
    ));
    if (queries.length > 0) return queries.join(' · ');
  }
  for (const field of ['query', 'url', 'pattern']) {
    const value = action[field];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

function isFileMutationOperation(operation: string | undefined): boolean {
  return operation !== undefined && [
    'fs.write',
    'fs.edit',
    'fs.delete',
  ].includes(operation);
}

function toolActivityStatus(
  status: ActivityProjection['status'],
  language: UiLanguage,
): string {
  return t(language, `agent.tool.status.${status}`);
}

function toolGroupStatus(
  activities: ActivityProjection[],
): ActivityProjection['status'] {
  const priority: ActivityProjection['status'][] = [
    'active',
    'waiting',
    'requested',
    'failed',
    'denied',
    'rejected',
    'indeterminate',
    'cancelled',
    'completed',
  ];
  return priority.find((status) => activities.some((activity) => activity.status === status))
    ?? 'indeterminate';
}
