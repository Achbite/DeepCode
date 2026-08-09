import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const SUITE_ID = 'session.v2.contracts';
const CONTRACT_CASE_TIMEOUT_MS = 15_000;
const CANONICAL_PROGRESS_STREAM_RETRY_MS = 250;
const LEGACY_LOADER_CHILD_ENV =
  'DEEPCODE_GUI_CONTRACT_LEGACY_LOADER_CHILD';
const HOST_CAPABILITY = `dchostuiv2_${'a'.repeat(64)}`;
const GUI_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const STORE_MODULE = path.join(
  GUI_ROOT,
  'dist',
  'userspace',
  'gui',
  'src',
  'state',
  'agentSessionStore.js'
);
const TOKEN_USAGE_STATS_MODULE = path.join(
  GUI_ROOT,
  'dist',
  'userspace',
  'gui',
  'src',
  'utils',
  'tokenUsageStats.js'
);
const UI_TIMELINE_PROJECTION_MODULE = path.join(
  GUI_ROOT,
  'dist',
  'userspace',
  'gui',
  'src',
  'utils',
  'uiTimelineProjection.js'
);
const SESSION_TIMELINE_DELTA_MODULE = path.resolve(
  GUI_ROOT,
  '..',
  'session-core',
  'dist',
  'timelineDelta.js'
);
const NOW = '2026-07-31T00:00:00.000Z';

if (
  process.env.DEEPCODE_TEST_CONTROLLER !== '1'
  || process.env.DEEPCODE_TEST_SUITE_ID !== SUITE_ID
) {
  throw new Error(
    'GUI agent-session contracts are internal; use bash ./test.sh --suite session.v2.contracts.'
  );
}

const ASYNC_LOADER_SOURCE = [
  "import { readFile } from 'node:fs/promises';",
  'export async function resolve(specifier, context, nextResolve) {',
  '  if (',
  "    (specifier.startsWith('./') || specifier.startsWith('../'))",
  "    && !/\\.[A-Za-z0-9]+(?:[?#].*)?$/.test(specifier)",
  '  ) {',
  '    try {',
  '      return await nextResolve(`${specifier}.js`, context);',
  '    } catch {',
  '      // Let Node report the original resolution error below.',
  '    }',
  '  }',
  '  return nextResolve(specifier, context);',
  '}',
  'export async function load(url, context, nextLoad) {',
  "  if (url.endsWith('.json')) {",
  '    return {',
  "      format: 'module',",
  '      shortCircuit: true,',
  "      source: `export default ${await readFile(new URL(url), 'utf8')};`,",
  '    };',
  '  }',
  '  return nextLoad(url, context);',
  '}',
].join('\n');
const ASYNC_LOADER_URL =
  `data:text/javascript,${encodeURIComponent(ASYNC_LOADER_SOURCE)}`;

if (typeof nodeModule.register === 'function') {
  nodeModule.register(ASYNC_LOADER_URL, import.meta.url);
} else if (process.env[LEGACY_LOADER_CHILD_ENV] !== '1') {
  const outcome = await runLegacyLoaderChild();
  if (outcome.signal) {
    process.kill(process.pid, outcome.signal);
    await new Promise(() => {});
  }
  process.exit(outcome.code ?? 1);
}

async function runLegacyLoaderChild() {
  const child = spawn(
    process.execPath,
    [
      '--no-warnings',
      '--experimental-loader',
      ASYNC_LOADER_URL,
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    {
      env: {
        ...process.env,
        [LEGACY_LOADER_CHILD_ENV]: '1',
      },
      stdio: 'inherit',
    }
  );
  const forwardedSignals = ['SIGHUP', 'SIGINT', 'SIGTERM'];
  const signalHandlers = new Map();
  for (const signal of forwardedSignals) {
    const handler = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function flushAsyncTurns(count = 3) {
  for (let turn = 0; turn < count; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

class WindowTimerTracker {
  constructor() {
    this.pending = new Map();
  }

  setTimeout(callback, delayMs = 0, ...args) {
    const normalizedDelay = Number(delayMs) || 0;
    let timer;
    timer = setTimeout(() => {
      this.pending.delete(timer);
      callback(...args);
    }, normalizedDelay);
    this.pending.set(timer, normalizedDelay);
    return timer;
  }

  clearTimeout(timer) {
    this.pending.delete(timer);
    clearTimeout(timer);
  }

  countByDelay(delayMs) {
    let count = 0;
    for (const pendingDelay of this.pending.values()) {
      if (pendingDelay === delayMs) count += 1;
    }
    return count;
  }

  clearAll() {
    for (const timer of this.pending.keys()) clearTimeout(timer);
    this.pending.clear();
  }
}

const windowTimers = new WindowTimerTracker();

async function waitFor(predicate, label, timeoutMs = 2_500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function withTimeout(promise, timeoutMs, label) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}.`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function sessionRecord(id, title = id) {
  return {
    id,
    title,
    projectId: `project-${id}`,
    eventCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function emptyTimeline(sessionId, revision = 0) {
  return {
    schemaVersion: 'deepcode.shared-conversation-projection.v2',
    shapeVersion: 'deepcode.shared-conversation.work-segments.v2',
    sessionId,
    revision,
    sourceEventVersion: revision,
    generatedAt: NOW,
    turns: [],
    eventCount: revision,
  };
}

function activeTimeline(sessionId, kernelRunId, revision = 1) {
  return {
    ...emptyTimeline(sessionId, revision),
    runProjection: {
      runId: kernelRunId,
      revision,
      status: 'active',
      phase: 'processing',
      currentActivity: null,
      wait: null,
      languageBinding: {
        language: 'neutral',
        status: 'unavailable',
      },
    },
  };
}

class Scenario {
  constructor(name, sessionIds) {
    this.name = name;
    this.sessionIds = new Set(sessionIds);
    this.sessions = new Map(
      sessionIds.map((id) => [id, sessionRecord(id)])
    );
    this.timelines = new Map(
      sessionIds.map((id) => [id, emptyTimeline(id)])
    );
    this.runRoutes = new Map();
    this.handlers = new Map();
    this.records = [];
    this.startStatus = 'waiting';
    this.startSequence = 0;
  }

  setActiveRun(sessionId, kernelRunId, hostRunId, status = 'running') {
    this.timelines.set(sessionId, activeTimeline(sessionId, kernelRunId));
    this.runRoutes.set(kernelRunId, { hostRunId, status, sessionId });
    this.runRoutes.set(hostRunId, { hostRunId, status, sessionId });
  }

  setRunStatus(hostRunId, status) {
    for (const route of this.runRoutes.values()) {
      if (route.hostRunId === hostRunId) route.status = status;
    }
  }

  sessionResult(sessionId) {
    const session = this.sessions.get(sessionId);
    assert(session, `${this.name}: unknown session ${sessionId}`);
    return {
      session: {
        ...session,
        eventCount: this.timelines.get(sessionId)?.eventCount ?? 0,
        updatedAt: NOW,
      },
    };
  }

  runResult(sessionId, requestedRunId, statusOverride) {
    const route = this.runRoutes.get(requestedRunId) ?? {
      hostRunId: requestedRunId,
      status: statusOverride ?? 'running',
      sessionId,
    };
    const status = statusOverride ?? route.status;
    return {
      run: {
        runId: route.hostRunId,
        sessionId,
        status,
        startedAt: NOW,
        updatedAt: NOW,
        ...(status === 'completed'
          || status === 'failed'
          || status === 'cancelled'
          ? { completedAt: NOW }
          : {}),
      },
      ...this.sessionResult(sessionId),
    };
  }

  recordsOf(kind) {
    return this.records.filter((record) => record.kind === kind);
  }
}

class ControlledHost {
  constructor() {
    this.scenariosBySession = new Map();
    this.currentSessionId = undefined;
    this.closePromise = undefined;
    this.server = http.createServer((request, response) => {
      void this.dispatch(request, response).catch((error) => {
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'application/json' });
        }
        if (!response.writableEnded) {
          response.end(JSON.stringify({
            ok: false,
            error: 'controlled_host_failure',
            message: error instanceof Error ? error.message : String(error),
          }));
        }
      });
    });
  }

  register(scenario) {
    for (const sessionId of scenario.sessionIds) {
      if (this.scenariosBySession.has(sessionId)) {
        throw new Error(`duplicate controlled Host session: ${sessionId}`);
      }
      this.scenariosBySession.set(sessionId, scenario);
    }
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    assert(address && typeof address === 'object');
    this.port = address.port;
  }

  async close() {
    if (!this.closePromise) {
      this.closePromise = new Promise((resolve, reject) => {
        this.server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        this.server.closeAllConnections();
      });
    }
    await this.closePromise;
  }

  allSessions() {
    const sessions = new Map();
    for (const scenario of new Set(this.scenariosBySession.values())) {
      for (const [id, session] of scenario.sessions) sessions.set(id, session);
    }
    return [...sessions.values()];
  }

  async dispatch(request, response) {
    assert.equal(
      request.headers['x-deepcode-host-ui-capability'],
      HOST_CAPABILITY,
      'GUI request omitted the trusted Host admission capability'
    );
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const body = await readJsonBody(request);
    const route = matchRoute(
      request.method ?? 'GET',
      url.pathname,
      url.searchParams
    );
    if (route.kind === 'list') {
      return sendApiData(response, {
        sessions: this.allSessions(),
        currentSessionId: this.currentSessionId,
      });
    }
    if (!route.sessionId) {
      return sendApiError(response, 404, 'route_not_found');
    }
    const scenario = this.scenariosBySession.get(route.sessionId);
    if (!scenario) {
      return sendApiError(response, 404, 'session_not_found');
    }
    const record = {
      kind: route.kind,
      method: request.method,
      path: url.pathname,
      sessionId: route.sessionId,
      runId: route.runId,
      afterRevision: route.afterRevision,
      body,
      startedAt: Date.now(),
      aborted: false,
    };
    scenario.records.push(record);
    response.once('close', () => {
      if (!response.writableEnded) record.aborted = true;
    });
    const context = {
      request,
      response,
      route,
      record,
      scenario,
      host: this,
      data: (data) => sendApiData(response, data),
      error: (status, message) => sendApiError(response, status, message),
      destroy: () => request.socket.destroy(),
      sseOpen: () => {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        response.write(': controlled-host-open\n\n');
      },
      sseEvent: (event, data) => {
        response.write(`event: ${event}\n`);
        response.write(`data: ${JSON.stringify(data)}\n\n`);
      },
    };
    const custom = scenario.handlers.get(route.kind);
    if (custom && await custom(context)) return;
    return this.defaultResponse(context);
  }

  defaultResponse(context) {
    const {
      route,
      scenario,
      host,
      data,
      sseOpen,
      sseEvent,
    } = context;
    const { sessionId, runId } = route;
    switch (route.kind) {
      case 'activate':
        host.currentSessionId = sessionId;
        data(scenario.sessionResult(sessionId));
        return;
      case 'timeline':
        data(scenario.timelines.get(sessionId) ?? emptyTimeline(sessionId));
        return;
      case 'timelineStream': {
        const snapshot = scenario.timelines.get(sessionId)
          ?? emptyTimeline(sessionId);
        sseOpen();
        sseEvent('snapshot', {
          type: 'snapshot',
          sessionId,
          revision: snapshot.revision,
          snapshot,
        });
        return;
      }
      case 'start': {
        scenario.startSequence += 1;
        const hostRunId = `host-${sessionId}-${scenario.startSequence}`;
        scenario.runRoutes.set(hostRunId, {
          hostRunId,
          status: scenario.startStatus,
          sessionId,
        });
        data(scenario.runResult(
          sessionId,
          hostRunId,
          scenario.startStatus
        ));
        return;
      }
      case 'runGet':
        data(scenario.runResult(sessionId, runId));
        return;
      case 'guidance':
        data(scenario.runResult(sessionId, runId));
        return;
      case 'cancel':
        scenario.setRunStatus(runId, 'cancelled');
        data(scenario.runResult(sessionId, runId, 'cancelled'));
        return;
      default:
        sendApiError(response, 404, 'route_not_found');
    }
  }
}

async function readJsonBody(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

function sendApiData(response, data) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: true, data }));
}

function sendApiError(response, status, message) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    ok: false,
    error: 'controlled_host_error',
    message,
  }));
}

function matchRoute(method, pathname, searchParams) {
  if (method === 'GET' && pathname === '/api/agent/sessions') {
    return { kind: 'list' };
  }
  let match = pathname.match(/^\/api\/agent\/sessions\/([^/]+)\/activate$/);
  if (method === 'POST' && match) {
    return { kind: 'activate', sessionId: decodeURIComponent(match[1]) };
  }
  match = pathname.match(/^\/api\/agent\/sessions\/([^/]+)\/timeline$/);
  if (method === 'GET' && match) {
    return { kind: 'timeline', sessionId: decodeURIComponent(match[1]) };
  }
  match = pathname.match(
    /^\/api\/agent\/sessions\/([^/]+)\/timeline\/stream$/
  );
  if (method === 'GET' && match) {
    return {
      kind: 'timelineStream',
      sessionId: decodeURIComponent(match[1]),
      afterRevision: Number(searchParams?.get('afterRevision') ?? 0),
    };
  }
  match = pathname.match(
    /^\/api\/agent\/sessions\/([^/]+)\/runs\/([^/]+)\/guidance$/
  );
  if (method === 'POST' && match) {
    return {
      kind: 'guidance',
      sessionId: decodeURIComponent(match[1]),
      runId: decodeURIComponent(match[2]),
    };
  }
  match = pathname.match(
    /^\/api\/agent\/sessions\/([^/]+)\/runs\/([^/]+)\/cancel$/
  );
  if (method === 'POST' && match) {
    return {
      kind: 'cancel',
      sessionId: decodeURIComponent(match[1]),
      runId: decodeURIComponent(match[2]),
    };
  }
  match = pathname.match(/^\/api\/agent\/sessions\/([^/]+)\/runs\/([^/]+)$/);
  if (method === 'GET' && match) {
    return {
      kind: 'runGet',
      sessionId: decodeURIComponent(match[1]),
      runId: decodeURIComponent(match[2]),
    };
  }
  match = pathname.match(/^\/api\/agent\/sessions\/([^/]+)\/runs$/);
  if (method === 'POST' && match) {
    return { kind: 'start', sessionId: decodeURIComponent(match[1]) };
  }
  return { kind: 'unknown' };
}

let storeSequence = 0;

async function freshStore(label) {
  storeSequence += 1;
  const moduleUrl = pathToFileURL(STORE_MODULE);
  moduleUrl.searchParams.set(
    'contract',
    `${storeSequence}-${encodeURIComponent(label)}`
  );
  const module = await import(moduleUrl.href);
  return module.useAgentSessionStore;
}

async function activate(store, sessionId) {
  await store.getState().activateSession(sessionId);
  assert.equal(
    store.getState().session?.id,
    sessionId,
    `activation did not select ${sessionId}`
  );
}

async function cleanupStore(store) {
  store.setState({
    session: null,
    timeline: null,
    loading: false,
  });
  await delay(30);
}

function holdRequests(scenario, kind) {
  const held = [];
  scenario.handlers.set(kind, (context) => {
    held.push(context);
    return true;
  });
  return held;
}

function holdSseRequests(scenario, kind) {
  const held = [];
  scenario.handlers.set(kind, (context) => {
    held.push(context);
    context.sseOpen();
    return true;
  });
  return held;
}

function respondGuidance(context, title) {
  const { scenario, route } = context;
  if (title) {
    scenario.sessions.set(
      route.sessionId,
      sessionRecord(route.sessionId, title)
    );
  }
  context.data(scenario.runResult(route.sessionId, route.runId, 'running'));
}

const contractCases = [
  {
    id: 'task_list_requires_latest_accepted_plan_and_preserves_exact_targets',
    async run() {
      const {
        latestAcceptedPlanTaskItemsFromProjection,
      } = await import(pathToFileURL(UI_TIMELINE_PROJECTION_MODULE).href);
      const {
        normalizeAgentTimelineSnapshot,
      } = await import(pathToFileURL(SESSION_TIMELINE_DELTA_MODULE).href);
      const sessionId = 'task-list-plan-a';
      const runId = 'kernel-task-list-plan-a';
      const oldPlanBlockId = 'plan-old-accepted';
      const planBlock = (id, state, sequence) => ({
        id,
        sequence,
        durability: 'committed',
        kind: 'plan',
        narrativeKind: 'plan',
        entryRole: 'interaction',
        title: 'Plan',
        summary: '',
        status: state === 'open' ? 'waiting' : 'completed',
        defaultCollapsed: false,
        interaction: {
          kind: 'plan',
          interactionId: `interaction-${id}`,
          interactionRevision: `event-${id}`,
          targetId: id,
          runId,
          state,
          ...(state === 'open'
            ? {}
            : {
                selectedDecision: {
                  decision: state === 'accepted' ? 'accept' : 'reject',
                  source: 'button',
                  decidedAt: NOW,
                },
              }),
        },
        attachments: [],
        provenance: {
          origin: 'session',
          authority: 'session',
          sourceEventRefs: [`event-${id}`],
          factRefs: [],
          evidenceRefs: [],
        },
        languageBinding: {
          language: 'neutral',
          status: 'unavailable',
        },
      });
      const taskItem = (id, blockId, target, progress, outcome) => ({
        id,
        titleKey: 'agent.task.fsCreate',
        titleArgs: { tool: 'fs.create' },
        summaryKey: 'agent.task.target',
        messageArgs: { target },
        targetRefs: [`workspace:${target}`],
        resourcePresentation: [{
          kind: 'workspacePath',
          label: target,
          workspaceRelativePath: target,
          canonicalResourceRef: `workspace:${target}`,
        }],
        progress,
        outcome,
        attention: null,
        blockId,
        narrativeKind: 'plan',
      });
      const projectionForLatestState = (state) => {
        const latestPlanBlockId = `plan-latest-${state}`;
        return normalizeAgentTimelineSnapshot({
          ...activeTimeline(sessionId, runId, 12),
          turns: [{
            id: 'turn-task-list-plan-a',
            sequence: 0,
            sessionId,
            status: 'running',
            startedAt: NOW,
            blocks: [
              planBlock(oldPlanBlockId, 'accepted', 0),
              planBlock(latestPlanBlockId, state, 1),
            ],
            workSegments: [],
            parts: [
              { kind: 'block', blockId: oldPlanBlockId },
              { kind: 'block', blockId: latestPlanBlockId },
            ],
          }],
          taskProjection: {
            title: 'Plan tasks',
            items: [
              taskItem(
                'task-old-plan',
                oldPlanBlockId,
                'legacy.cpp',
                'completed',
                'succeeded'
              ),
              taskItem(
                'task-build-sh',
                latestPlanBlockId,
                'build.sh',
                'queued',
                null
              ),
              taskItem(
                'task-run-sh',
                latestPlanBlockId,
                'run.sh',
                'completed',
                'succeeded'
              ),
              taskItem(
                'task-main-cpp',
                latestPlanBlockId,
                'src/main.cpp',
                'completed',
                'unexecuted'
              ),
              {
                ...taskItem(
                  'task-review-only',
                  latestPlanBlockId,
                  'review.md',
                  'queued',
                  null
                ),
                narrativeKind: 'review',
              },
            ],
          },
        });
      };

      assert.deepEqual(
        latestAcceptedPlanTaskItemsFromProjection(
          projectionForLatestState('open')
        ),
        [],
        'an older accepted Plan leaked through the latest open Plan snapshot'
      );
      assert.deepEqual(
        latestAcceptedPlanTaskItemsFromProjection(
          projectionForLatestState('rejected')
        ),
        [],
        'an older accepted Plan leaked through the latest rejected Plan snapshot'
      );

      const acceptedItems = latestAcceptedPlanTaskItemsFromProjection(
        projectionForLatestState('accepted')
      );
      assert.equal(
        acceptedItems.length,
        3,
        'the accepted Plan task count was compacted or widened'
      );
      assert.deepEqual(
        acceptedItems.map((item) => item.id),
        ['task-build-sh', 'task-run-sh', 'task-main-cpp'],
        'same-name tasks were folded or reordered'
      );
      assert.deepEqual(
        acceptedItems.map((item) => ({
          id: item.id,
          blockId: item.blockId,
          titleKey: item.titleKey,
          titleArgs: item.titleArgs,
          targetRefs: item.targetRefs,
          resourcePresentation: item.resourcePresentation,
          progress: item.progress,
          outcome: item.outcome,
        })),
        [
          {
            id: 'task-build-sh',
            blockId: 'plan-latest-accepted',
            titleKey: 'agent.task.fsCreate',
            titleArgs: { tool: 'fs.create' },
            targetRefs: ['workspace:build.sh'],
            resourcePresentation: [{
              kind: 'workspacePath',
              label: 'build.sh',
              workspaceRelativePath: 'build.sh',
              canonicalResourceRef: 'workspace:build.sh',
            }],
            progress: 'queued',
            outcome: null,
          },
          {
            id: 'task-run-sh',
            blockId: 'plan-latest-accepted',
            titleKey: 'agent.task.fsCreate',
            titleArgs: { tool: 'fs.create' },
            targetRefs: ['workspace:run.sh'],
            resourcePresentation: [{
              kind: 'workspacePath',
              label: 'run.sh',
              workspaceRelativePath: 'run.sh',
              canonicalResourceRef: 'workspace:run.sh',
            }],
            progress: 'completed',
            outcome: 'succeeded',
          },
          {
            id: 'task-main-cpp',
            blockId: 'plan-latest-accepted',
            titleKey: 'agent.task.fsCreate',
            titleArgs: { tool: 'fs.create' },
            targetRefs: ['workspace:src/main.cpp'],
            resourcePresentation: [{
              kind: 'workspacePath',
              label: 'src/main.cpp',
              workspaceRelativePath: 'src/main.cpp',
              canonicalResourceRef: 'workspace:src/main.cpp',
            }],
            progress: 'completed',
            outcome: 'unexecuted',
          },
        ],
        'structured targets or outcomes were degraded in the task-list view'
      );
    },
  },
  {
    id: 'cache_hit_rate_is_derived_from_canonical_integer_counters',
    async run() {
      const {
        deriveTokenUsageStats,
        formatPercent,
      } = await import(pathToFileURL(TOKEN_USAGE_STATS_MODULE).href);
      const canonicalProjection = {
        totals: {
          promptCacheHitTokens: 1,
          promptCacheMissTokens: 2,
          cachedTokens: 1,
          promptTokens: 3,
          completionTokens: 4,
          totalTokens: 7,
          providerCallCount: 1,
          providers: ['deepseek'],
        },
        requests: [{
          requestId: 'provider-turn-token-usage',
          turnId: 'provider-turn-token-usage',
          userEventId: 'event-token-usage-user',
          title: 'deepseek / deepseek-token-usage-contract',
          startedAt: '2026-07-31T00:00:00.000Z',
          completedAt: '2026-07-31T00:00:01.000Z',
          stages: ['provider.completed'],
          promptCacheHitTokens: 1,
          promptCacheMissTokens: 2,
          cachedTokens: 1,
          promptTokens: 3,
          completionTokens: 4,
          totalTokens: 7,
          providerCallCount: 1,
          providers: ['deepseek'],
        }],
      };
      assert.equal(
        Object.hasOwn(canonicalProjection.totals, 'cacheHitRate'),
        false
      );
      assert.equal(
        Object.hasOwn(canonicalProjection.requests[0], 'cacheHitRate'),
        false
      );

      const stats = deriveTokenUsageStats(canonicalProjection);
      assert.equal(stats.promptCacheHitTokens, 1);
      assert.equal(stats.promptCacheMissTokens, 2);
      assert.equal(stats.cacheHitRate, 1 / 3);
      assert.equal(stats.requests[0].cacheHitRate, 1 / 3);
      assert.equal(stats.hasCacheData, true);
      assert.equal(stats.requests[0].hasCacheData, true);
      assert.equal(formatPercent(stats.cacheHitRate), '33%');
      assert.equal(
        formatPercent(stats.requests[0].cacheHitRate),
        '33%'
      );
    },
  },
  {
    id: 'canonical_timeline_stream_is_reference_counted_and_reconciles_revision_gaps',
    async run(host) {
      const sessionId = 'watcher-a';
      const scenario = new Scenario(this.id, [sessionId]);
      scenario.setActiveRun(sessionId, 'kernel-watcher-a', 'host-watcher-a');
      host.register(scenario);
      const store = await freshStore(this.id);
      await activate(store, sessionId);
      assert.equal(
        store.getState().selectionReady,
        true,
        `watcher Session activation was not ready: ${String(
          store.getState().errorMessage
        )}`
      );
      scenario.records.length = 0;
      const heldStreams = holdSseRequests(scenario, 'timelineStream');
      const heldGuidance = holdRequests(scenario, 'guidance');
      const heldCancel = holdRequests(scenario, 'cancel');

      const guidance = store.getState().sendMessage('guidance consumer');
      await waitFor(
        () => heldGuidance.length === 1 && heldStreams.length >= 1,
        'guidance consumer and the shared typed timeline stream'
      );
      const cancellation = store.getState().cancelCurrentRun();
      await waitFor(
        () => heldCancel.length === 1,
        'the concurrent legal cancel consumer'
      );
      await flushAsyncTurns();
      assert.equal(
        heldStreams.length,
        1,
        'legal concurrent consumers created duplicate watchers'
      );
      assert.equal(
        heldStreams[0].record.afterRevision,
        1,
        'typed timeline stream did not resume after the visible snapshot'
      );

      const heldTrailingTimeline = holdRequests(scenario, 'timeline');
      respondGuidance(heldGuidance[0]);
      await guidance;
      assert.equal(
        heldStreams[0].record.aborted,
        false,
        'guidance release aborted the cancel consumer shared watcher'
      );
      assert.equal(heldStreams.length, 1);

      scenario.setRunStatus(heldCancel[0].route.runId, 'cancelled');
      scenario.timelines.set(sessionId, emptyTimeline(sessionId, 2));
      heldCancel[0].data(scenario.runResult(
        sessionId,
        heldCancel[0].route.runId,
        'cancelled'
      ));
      await cancellation;
      scenario.handlers.delete('guidance');
      scenario.handlers.delete('cancel');
      await waitFor(
        () => heldTrailingTimeline.length >= 1
          && heldStreams[0].record.aborted,
        'final watcher abort and trailing canonical snapshot refresh'
      );
      await flushAsyncTurns();
      assert.equal(
        heldTrailingTimeline.length,
        1,
        'the final consumer release started duplicate snapshot refreshes'
      );
      scenario.handlers.delete('timeline');
      scenario.handlers.delete('timelineStream');
      heldTrailingTimeline[0].data(emptyTimeline(sessionId, 2));
      await waitFor(
        () => windowTimers.countByDelay(
          CANONICAL_PROGRESS_STREAM_RETRY_MS
        ) === 0,
        'the final consumer release to clear the stream retry timer'
      );
      await cleanupStore(store);
    },
  },
  {
    id: 'canonical_timeline_revision_gap_refetches_exact_snapshot',
    async run(host) {
      const {
        applyAgentTimelineDelta,
      } = await import(pathToFileURL(SESSION_TIMELINE_DELTA_MODULE).href);
      const sessionId = 'revision-gap-a';
      const scenario = new Scenario(this.id, [sessionId]);
      scenario.setActiveRun(
        sessionId,
        'kernel-revision-gap-a',
        'host-revision-gap-a'
      );
      host.register(scenario);
      const store = await freshStore(this.id);
      await activate(store, sessionId);
      scenario.records.length = 0;
      const heldTimeline = holdRequests(scenario, 'timeline');
      const heldGuidance = holdRequests(scenario, 'guidance');
      const gapDelta = {
        schemaVersion: 'deepcode.shared-conversation-projection.v2',
        shapeVersion: 'deepcode.shared-conversation.work-segments.v2',
        sessionId,
        baseRevision: 99,
        revision: 100,
        sourceEventVersion: 100,
        generatedAt: NOW,
        eventCount: 100,
        turnReplacements: [],
        removedTurnIds: [],
        rootReplacements: {},
      };
      assert.throws(
        () => applyAgentTimelineDelta(
          activeTimeline(sessionId, 'kernel-revision-gap-a', 1),
          gapDelta
        ),
        (error) =>
          error?.code === 'AgentTimelineRevisionGap'
          && error.expectedBaseRevision === 1
          && error.receivedBaseRevision === 99,
        'the stream fixture must be valid v2 and fail only on its revision gap'
      );
      let streamSequence = 0;
      scenario.handlers.set('timelineStream', (context) => {
        streamSequence += 1;
        context.sseOpen();
        if (streamSequence === 1) {
          context.sseEvent('delta', {
            type: 'delta',
            sessionId,
            revision: 100,
            delta: gapDelta,
          });
          context.response.end();
        }
        return true;
      });

      const mutation = store.getState().sendMessage('revision gap');
      await waitFor(
        () => heldGuidance.length === 1
          && heldTimeline.length === 1
          && scenario.recordsOf('timelineStream').length === 1,
        'revision gap fallback to a canonical snapshot'
      );
      assert.equal(
        scenario.recordsOf('timelineStream')[0].afterRevision,
        1
      );
      scenario.timelines.set(
        sessionId,
        activeTimeline(sessionId, 'kernel-revision-gap-a', 2)
      );
      scenario.handlers.delete('timeline');
      heldTimeline[0].data(scenario.timelines.get(sessionId));
      await waitFor(
        () => store.getState().timeline?.revision === 2,
        'exact replacement snapshot after the revision gap'
      );
      respondGuidance(heldGuidance[0]);
      await mutation;
      scenario.handlers.delete('guidance');
      scenario.handlers.delete('timelineStream');
      await cleanupStore(store);
    },
  },
  {
    id: 'late_session_a_results_never_replace_active_session_b',
    async run(host) {
      const sessionA = 'late-a';
      const sessionB = 'late-b';
      const scenario = new Scenario(this.id, [sessionA, sessionB]);
      scenario.setActiveRun(sessionA, 'kernel-late-a', 'host-late-a');
      host.register(scenario);
      const store = await freshStore(this.id);
      await activate(store, sessionA);
      const heldGuidance = holdRequests(scenario, 'guidance');
      const mutation = store.getState().sendMessage('late A mutation');
      await waitFor(
        () => heldGuidance.length > 0
          && scenario.recordsOf('timelineStream').length > 0,
        'late A mutation and typed timeline stream'
      );

      await activate(store, sessionB);
      assert.equal(store.getState().session?.id, sessionB);
      const heldTimeline = holdRequests(scenario, 'timeline');
      scenario.timelines.set(
        sessionA,
        activeTimeline(sessionA, 'kernel-late-a', 2)
      );
      respondGuidance(heldGuidance[0], 'late A updated');
      await waitFor(
        () => heldTimeline.length === 1,
        'late canonical snapshot for Session A'
      );
      scenario.handlers.delete('timeline');
      heldTimeline[0].data(activeTimeline(
        sessionA,
        'kernel-late-a',
        2
      ));
      await mutation;
      await delay(50);

      const state = store.getState();
      assert.equal(state.session?.id, sessionB);
      assert.equal(state.timeline?.sessionId, sessionB);
      scenario.handlers.delete('guidance');
      await cleanupStore(store);
    },
  },
  {
    id: 'stale_generation_requires_force_fresh_before_next_send',
    async run(host) {
      const sessionId = 'stale-a';
      const scenario = new Scenario(this.id, [sessionId]);
      scenario.setActiveRun(sessionId, 'kernel-stale-a', 'host-stale-a');
      host.register(scenario);
      const store = await freshStore(this.id);
      await activate(store, sessionId);
      scenario.records.length = 0;
      const heldTimeline = holdRequests(scenario, 'timeline');
      const heldGuidance = holdRequests(scenario, 'guidance');
      scenario.handlers.set('timelineStream', (context) => {
        context.sseOpen();
        context.response.end();
        return true;
      });

      const first = store.getState().sendMessage('timeline mutation');
      await waitFor(
        () => heldTimeline.length > 0 && heldGuidance.length > 0,
        'pre-mutation timeline fetch'
      );
      const preMutationFetchCount = scenario.recordsOf('timeline').length;
      assert.equal(
        preMutationFetchCount,
        1,
        'the fixture must hold exactly one pre-mutation timeline generation'
      );
      respondGuidance(heldGuidance[0]);
      await first;
      scenario.handlers.delete('guidance');
      scenario.handlers.set('timeline', (context) => {
        context.error(503, 'forced canonical refresh unavailable');
        return true;
      });
      const second = store.getState().sendMessage('must fail closed');
      await flushAsyncTurns();
      assert.equal(
        scenario.recordsOf('guidance').length,
        1,
        'the next send reached Host before the stale timeline generation was fenced'
      );
      assert.equal(
        scenario.recordsOf('start').length,
        0,
        'the next send started a Run before the stale timeline generation was fenced'
      );
      heldTimeline[0].data(activeTimeline(
        sessionId,
        'kernel-stale-a',
        1
      ));
      await second;
      assert(
        scenario.recordsOf('timeline').length > preMutationFetchCount,
        'the stale pre-mutation generation did not trigger a new force-fresh fetch'
      );
      assert.equal(
        scenario.recordsOf('guidance').length,
        1,
        'a stale timeline allowed a second guidance mutation'
      );
      assert.equal(
        scenario.recordsOf('start').length,
        0,
        'a stale timeline allowed a new Run'
      );
      assert.equal(
        store.getState().selectionReady,
        false,
        'a failed current-generation refresh left the Session send-ready'
      );
      assert.match(
        store.getState().errorMessage ?? '',
        /Agent 会话仍在准备中/
      );

      scenario.handlers.delete('timeline');
      await store.getState().refreshActiveSessionContext();
      assert.equal(
        store.getState().selectionReady,
        true,
        'an explicit current-generation refresh did not recover Session readiness'
      );
      await store.getState().sendMessage('fresh guidance');
      assert.equal(scenario.recordsOf('guidance').length, 2);
      assert.equal(
        scenario.recordsOf('guidance').at(-1)?.runId,
        'host-stale-a',
        'force-fresh did not recover the canonical Host route'
      );
      scenario.handlers.delete('timelineStream');
      await cleanupStore(store);
    },
  },
  {
    id: 'host_active_identity_survives_unknown_get_until_terminal_status',
    async run(host) {
      const sessionId = 'identity-a';
      const scenario = new Scenario(this.id, [sessionId]);
      scenario.setActiveRun(
        sessionId,
        'kernel-identity-a',
        'host-identity-a'
      );
      host.register(scenario);
      const store = await freshStore(this.id);
      await activate(store, sessionId);
      scenario.handlers.set('runGet', (context) => {
        context.error(503, 'Host run status unknown');
        return true;
      });
      await store.getState().sendMessage('trigger unknown status refresh');
      await waitFor(
        () => scenario.recordsOf('runGet').length >= 2,
        'unknown Host run refresh'
      );

      scenario.handlers.delete('runGet');
      scenario.handlers.set('cancel', (context) => {
        scenario.setRunStatus(context.route.runId, 'cancelled');
        scenario.timelines.set(sessionId, emptyTimeline(sessionId, 2));
        context.data(scenario.runResult(
          sessionId,
          context.route.runId,
          'cancelled'
        ));
        return true;
      });
      await store.getState().cancelCurrentRun();
      assert.equal(
        scenario.recordsOf('cancel').at(-1)?.runId,
        'host-identity-a',
        'unknown GET cleared the Host-active identity'
      );
      await waitFor(
        () => !store.getState().timeline?.runProjection,
        'terminal canonical timeline'
      );
      const cancelCount = scenario.recordsOf('cancel').length;
      await store.getState().cancelCurrentRun();
      assert.equal(
        scenario.recordsOf('cancel').length,
        cancelCount,
        'terminal Host status did not clear the active identity'
      );
      scenario.handlers.delete('cancel');
      await cleanupStore(store);
    },
  },
  {
    id: 'activation_last_intent_wins_and_unknown_outcome_is_reasserted',
    async run(host) {
      const sessionA = 'activation-a';
      const sessionB = 'activation-b';
      const sessionC = 'activation-c';
      const scenario = new Scenario(
        this.id,
        [sessionA, sessionB, sessionC]
      );
      host.register(scenario);
      const store = await freshStore(this.id);
      await activate(store, sessionA);
      scenario.records.length = 0;
      const heldB = [];
      scenario.handlers.set('activate', (context) => {
        if (context.route.sessionId !== sessionB) return false;
        heldB.push(context);
        return true;
      });

      const activateB = store.getState().activateSession(sessionB);
      await waitFor(() => heldB.length === 1, 'held activation B');
      const activateC = store.getState().activateSession(sessionC);
      await delay(50);
      assert.equal(
        scenario.recordsOf('activate').filter(
          (record) => record.sessionId === sessionC
        ).length,
        0,
        'activation queue did not serialize user intent'
      );
      host.currentSessionId = sessionB;
      heldB[0].data(scenario.sessionResult(sessionB));
      await Promise.all([activateB, activateC]);
      assert.deepEqual(
        scenario.recordsOf('activate').map((record) => record.sessionId),
        [sessionB, sessionC]
      );
      assert.equal(store.getState().session?.id, sessionC);
      assert.equal(host.currentSessionId, sessionC);

      scenario.handlers.set('activate', (context) => {
        if (context.route.sessionId !== sessionB) return false;
        host.currentSessionId = sessionB;
        context.destroy();
        return true;
      });
      await store.getState().activateSession(sessionB);
      assert.equal(
        store.getState().session?.id,
        sessionC,
        'unknown activation outcome changed the visible session'
      );
      scenario.handlers.delete('activate');
      await store.getState().activateSession(sessionC);
      assert.deepEqual(
        scenario.recordsOf('activate').slice(-2).map(
          (record) => record.sessionId
        ),
        [sessionB, sessionC],
        'current UI session was not reasserted after an unknown outcome'
      );
      assert.equal(host.currentSessionId, sessionC);
      await cleanupStore(store);
    },
  },
  {
    id: 'bounded_progress_requests_abort_without_hanging_ui',
    async run(host) {
      const runSession = 'bounded-run';
      const activationSession = 'bounded-activation';
      const runScenario = new Scenario(this.id, [runSession]);
      const activationScenario = new Scenario(
        `${this.id}-activation`,
        [activationSession]
      );
      host.register(runScenario);
      host.register(activationScenario);
      const runStore = await freshStore(`${this.id}-run`);
      const activationStore = await freshStore(`${this.id}-activation`);
      await activate(runStore, runSession);
      runScenario.startStatus = 'running';

      const hangOnce = (scenario, kind, openSse = false) => {
        let first = true;
        scenario.handlers.set(kind, (context) => {
          if (!first) {
            context.error(503, `${kind} trailing refresh rejected`);
            return true;
          }
          first = false;
          if (openSse) context.sseOpen();
          return true;
        });
      };
      hangOnce(runScenario, 'timeline');
      hangOnce(runScenario, 'runGet');
      let firstTimelineStream = true;
      runScenario.handlers.set('timelineStream', (context) => {
        context.sseOpen();
        if (firstTimelineStream) {
          firstTimelineStream = false;
          context.response.end();
        }
        return true;
      });
      hangOnce(activationScenario, 'activate');

      const startedAt = Date.now();
      const send = runStore.getState().sendMessage('bounded progress');
      const activation =
        activationStore.getState().activateSession(activationSession);
      await waitFor(
        () => runScenario.recordsOf('timeline').length > 0
          && runScenario.recordsOf('runGet').length > 0
          && runScenario.recordsOf('timelineStream').length > 0
          && activationScenario.recordsOf('activate').length > 0,
        'all bounded Host requests'
      );
      await withTimeout(
        Promise.all([send, activation]),
        8_000,
        'bounded GUI operations'
      );
      const elapsed = Date.now() - startedAt;
      assert(
        elapsed >= 4_500 && elapsed < 8_000,
        `bounded operations settled outside the 5 second boundary: ${elapsed}ms`
      );
      await waitFor(
        () => [
          [runScenario, 'timeline'],
          [runScenario, 'runGet'],
          [activationScenario, 'activate'],
        ].every(([scenario, kind]) =>
          scenario.recordsOf(kind).some((record) => record.aborted)
        ),
        'server-side AbortSignal observations',
        1_500
      );
      for (const [scenario, kind] of [
        [runScenario, 'timeline'],
        [runScenario, 'runGet'],
        [activationScenario, 'activate'],
      ]) {
        assert(
          scenario.recordsOf(kind).some((record) => record.aborted),
          `${kind} request did not observe AbortSignal cancellation`
        );
      }
      assert(
        !runStore.getState().runningSessionIds.includes(runSession),
        'bounded Run failure left the GUI running'
      );
      assert.equal(
        activationStore.getState().loading,
        false,
        'bounded activation failure left the GUI loading'
      );
      await cleanupStore(runStore);
      await cleanupStore(activationStore);
    },
  },
  {
    id: 'mutation_completion_updates_origin_bookkeeping_without_switching_session',
    async run(host) {
      const sessionA = 'bookkeeping-a';
      const sessionB = 'bookkeeping-b';
      const scenario = new Scenario(this.id, [sessionA, sessionB]);
      scenario.setActiveRun(
        sessionA,
        'kernel-bookkeeping-a',
        'host-bookkeeping-a'
      );
      host.register(scenario);
      const store = await freshStore(this.id);
      await activate(store, sessionA);
      const heldGuidance = holdRequests(scenario, 'guidance');
      const mutation = store.getState().sendMessage('update A');
      await waitFor(() => heldGuidance.length === 1, 'held A mutation');
      await activate(store, sessionB);
      respondGuidance(heldGuidance[0], 'A bookkeeping updated');
      await mutation;

      const state = store.getState();
      assert.equal(state.session?.id, sessionB);
      assert.equal(
        state.sessions.find((session) => session.id === sessionA)?.title,
        'A bookkeeping updated',
        'origin Session bookkeeping was not retained'
      );
      assert(
        !state.runningSessionIds.includes(sessionA),
        'origin Session running bookkeeping was not settled'
      );
      assert.equal(state.timeline?.sessionId, sessionB);
      scenario.handlers.delete('guidance');
      await cleanupStore(store);
    },
  },
  {
    id: 'cancel_does_not_clear_unrelated_session_loading_or_identity',
    async run(host) {
      const sessionA = 'cancel-a';
      const sessionB = 'cancel-b';
      const sessionC = 'cancel-c';
      const scenario = new Scenario(
        this.id,
        [sessionA, sessionB, sessionC]
      );
      scenario.setActiveRun(sessionA, 'kernel-cancel-a', 'host-cancel-a');
      scenario.setActiveRun(sessionB, 'kernel-cancel-b', 'host-cancel-b');
      host.register(scenario);
      const store = await freshStore(this.id);
      await activate(store, sessionB);
      await activate(store, sessionA);
      assert(
        store.getState().activeRunSessionIds.includes(sessionB),
        'precondition: Session B identity was not observable'
      );

      const heldActivation = [];
      scenario.handlers.set('activate', (context) => {
        if (context.route.sessionId !== sessionC) return false;
        heldActivation.push(context);
        return true;
      });
      const activation = store.getState().activateSession(sessionC);
      await waitFor(
        () => heldActivation.length === 1,
        'unrelated Session C loading'
      );
      assert.equal(store.getState().loading, true);
      await store.getState().cancelCurrentRun();
      const stateAfterCancel = store.getState();
      assert.equal(
        stateAfterCancel.loading,
        true,
        'cancel cleared unrelated Session activation loading'
      );
      assert(
        stateAfterCancel.activeRunSessionIds.includes(sessionB),
        'cancel cleared unrelated Session B identity'
      );
      assert(
        !stateAfterCancel.activeRunSessionIds.includes(sessionA),
        'cancel did not clear the explicitly cancelled Session A identity'
      );
      assert.equal(
        scenario.recordsOf('cancel').at(-1)?.runId,
        'host-cancel-a'
      );

      host.currentSessionId = sessionC;
      heldActivation[0].data(scenario.sessionResult(sessionC));
      await activation;
      assert.equal(store.getState().session?.id, sessionC);
      assert.equal(store.getState().loading, false);
      scenario.handlers.delete('activate');
      await cleanupStore(store);
    },
  },
  {
    id: 'active_submission_warning_requires_ownerless_durable_request',
    async run(host) {
      const storageKey = 'deepcode.host.pending-submissions.v2';
      const previousLocalStorage = window.localStorage;
      const localStorageEntries = new Map();
      window.localStorage = {
        getItem(key) {
          return localStorageEntries.get(String(key)) ?? null;
        },
        setItem(key, value) {
          localStorageEntries.set(String(key), String(value));
        },
        removeItem(key) {
          localStorageEntries.delete(String(key));
        },
        clear() {
          localStorageEntries.clear();
        },
      };
      window.localStorage.clear();
      try {
        const successSessionId = 'submission-active-success-a';
        const successScenario = new Scenario(this.id, [successSessionId]);
        successScenario.timelines.set(
          successSessionId,
          emptyTimeline(successSessionId)
        );
        host.register(successScenario);
        const successStore = await freshStore(`${this.id}-success`);
        await activate(successStore, successSessionId);
        assert.equal(
          successStore.getState().selectionReady,
          true,
          `success Session activation was not ready: ${String(
            successStore.getState().errorMessage
          )}`
        );
        const heldStarts = holdRequests(successScenario, 'start');
        const visibleSuccessWarnings = [];
        const unsubscribeSuccess = successStore.subscribe((state) => {
          const warning = state.pendingSubmissionRetryView(successSessionId);
          if (warning) visibleSuccessWarnings.push(warning);
        });

        const sendSuccess = successStore.getState().sendMessage(
          'restore the clean development environment'
        );
        let earlySuccessResult;
        void sendSuccess.then((result) => {
          earlySuccessResult = result;
        });
        await waitFor(
          () => heldStarts.length === 1 || earlySuccessResult !== undefined,
          'the actively owned caller submission'
        );
        assert.equal(
          heldStarts.length,
          1,
          `submission settled before Host admission: ${String(
            successStore.getState().errorMessage
          )}`
        );
        const activeState = successStore.getState();
        assert.deepEqual(
          activeState.activeSubmissionSessionIds,
          [successSessionId],
          'the in-flight submission owner was not observable exactly once'
        );
        assert.deepEqual(
          activeState.pendingSubmissionSessionIds,
          [successSessionId],
          'the durable submission identity was not observable exactly once'
        );
        assert.equal(
          activeState.pendingSubmissionRetryView(successSessionId),
          null,
          'an actively owned submission was exposed as a recovery warning'
        );
        const storedWhileActive = JSON.parse(
          window.localStorage.getItem(storageKey)
        );
        assert.equal(storedWhileActive.submissions.length, 1);
        const successCallerRequestId =
          storedWhileActive.submissions[0].submission.callerRequestId;
        assert.equal(
          heldStarts[0].record.body.callerRequestId,
          successCallerRequestId,
          'the active request did not use its durable caller identity'
        );

        const successRunId = 'host-submission-active-success-a';
        successScenario.runRoutes.set(successRunId, {
          hostRunId: successRunId,
          status: 'waiting',
          sessionId: successSessionId,
        });
        successScenario.handlers.delete('start');
        heldStarts[0].data(successScenario.runResult(
          successSessionId,
          successRunId,
          'waiting'
        ));
        assert.equal(await sendSuccess, true);
        await waitFor(
          () => !successStore.getState().activeSubmissionSessionIds.includes(
            successSessionId
          ),
          'successful submission owner release'
        );
        assert.equal(
          successStore.getState().pendingSubmissionRetryView(successSessionId),
          null
        );
        assert.deepEqual(
          visibleSuccessWarnings,
          [],
          'successful admission briefly exposed a recovery warning'
        );
        assert.equal(
          JSON.parse(window.localStorage.getItem(storageKey)).submissions.length,
          0,
          'successful admission left a durable recovery identity'
        );
        unsubscribeSuccess();
        await cleanupStore(successStore);

        const recoverySessionId = 'submission-ownerless-recovery-a';
        const recoveryScenario = new Scenario(
          `${this.id}-recovery`,
          [recoverySessionId]
        );
        recoveryScenario.timelines.set(
          recoverySessionId,
          emptyTimeline(recoverySessionId)
        );
        host.register(recoveryScenario);
        let startMode = 'pending';
        recoveryScenario.handlers.set('start', (context) => {
          if (startMode === 'success') return false;
          if (startMode === 'indeterminate') {
            context.destroy();
            return true;
          }
          context.response.writeHead(200, {
            'content-type': 'application/json',
          });
          context.response.end(JSON.stringify({
            ok: false,
            error: 'caller_submission_pending',
            message: 'Caller submission is still reconciling.',
            data: {
              schemaVersion: 'deepcode.host.caller-mutation-error.v2',
              disposition: 'pending',
            },
          }));
          return true;
        });
        const recoveryStore = await freshStore(`${this.id}-recovery`);
        await activate(recoveryStore, recoverySessionId);
        assert.equal(
          await recoveryStore.getState().sendMessage('recover this request'),
          false
        );
        const pendingView = recoveryStore.getState()
          .pendingSubmissionRetryView(recoverySessionId);
        assert.equal(pendingView?.disposition, 'pending');
        assert(
          !recoveryStore.getState().activeSubmissionSessionIds.includes(
            recoverySessionId
          ),
          'the failed request retained a live submission owner'
        );
        assert.equal(
          recoveryStore.getState().pendingSubmissionSessionIds.filter(
            (sessionId) => sessionId === recoverySessionId
          ).length,
          1,
          'the ownerless pending identity was duplicated'
        );
        const recoveryCallerRequestId = pendingView?.callerRequestId;
        assert(recoveryCallerRequestId);

        startMode = 'indeterminate';
        assert.equal(
          await recoveryStore.getState().retryPendingSubmission(false),
          false
        );
        const indeterminateView = recoveryStore.getState()
          .pendingSubmissionRetryView(recoverySessionId);
        assert.equal(indeterminateView?.disposition, 'indeterminate');
        assert.equal(
          indeterminateView?.callerRequestId,
          recoveryCallerRequestId,
          'indeterminate reconciliation replaced the durable caller identity'
        );
        assert.equal(
          recoveryScenario.recordsOf('start').length,
          3,
          'network uncertainty did not perform exactly one replayable transport retry'
        );
        assert.deepEqual(
          [...new Set(recoveryScenario.recordsOf('start').map(
            (record) => record.body.callerRequestId
          ))],
          [recoveryCallerRequestId],
          'transport retry created a second logical caller identity'
        );
        const storedOwnerless = JSON.parse(
          window.localStorage.getItem(storageKey)
        );
        assert.equal(storedOwnerless.submissions.length, 1);
        assert.equal(
          storedOwnerless.submissions[0].submission.callerRequestId,
          recoveryCallerRequestId
        );
        await cleanupStore(recoveryStore);

        const restartedStore = await freshStore(`${this.id}-restart`);
        assert.deepEqual(
          restartedStore.getState().pendingSubmissionSessionIds,
          [recoverySessionId],
          'restart did not recover the ownerless durable request'
        );
        assert.equal(
          restartedStore.getState().pendingSubmissionRetryView(
            recoverySessionId
          )?.callerRequestId,
          recoveryCallerRequestId,
          'restart changed the durable caller identity'
        );
        await activate(restartedStore, recoverySessionId);
        const restartedWarnings = [];
        const unsubscribeRestarted = restartedStore.subscribe((state) => {
          const warning = state.pendingSubmissionRetryView(recoverySessionId);
          if (warning) restartedWarnings.push(warning);
        });
        startMode = 'success';
        assert.equal(
          await restartedStore.getState().retryPendingSubmission(false),
          true
        );
        assert.deepEqual(
          [...new Set(recoveryScenario.recordsOf('start').map(
            (record) => record.body.callerRequestId
          ))],
          [recoveryCallerRequestId],
          'restart recovery submitted a duplicate logical identity'
        );
        assert.deepEqual(
          restartedWarnings,
          [],
          'successful restart recovery flashed a warning while actively owned'
        );
        assert.equal(
          restartedStore.getState().pendingSubmissionRetryView(
            recoverySessionId
          ),
          null
        );
        assert.equal(
          JSON.parse(window.localStorage.getItem(storageKey)).submissions.length,
          0,
          'successful restart recovery did not settle durable identity'
        );
        unsubscribeRestarted();
        await cleanupStore(restartedStore);
      } finally {
        window.localStorage.clear();
        window.localStorage = previousLocalStorage;
      }
    },
  },
];

async function runContractCase(host, contractCase) {
  let timeout;
  const operation = Promise.resolve().then(() => contractCase.run(host));
  try {
    await Promise.race([
      operation,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(
            `${contractCase.id} exceeded ${CONTRACT_CASE_TIMEOUT_MS}ms.`
          ));
        }, CONTRACT_CASE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    windowTimers.clearAll();
    await host.close();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  try {
    readFileSync(STORE_MODULE);
  } catch {
    throw new Error(
      'GUI TypeScript output is missing; build @deepcode/client types before running contracts.'
    );
  }
  const host = new ControlledHost();
  await host.start();
  const localStorageEntries = new Map();
  globalThis.window = {
    location: {
      protocol: 'deepcode-gui:',
      hostname: 'localhost',
      origin: 'deepcode-gui://localhost',
    },
    __DEEPCODE_HOST_BOOT_V2__: {
      schemaVersion: 'deepcode.host-ui-bootstrap.v2',
      host: '127.0.0.1',
      port: String(host.port),
      proxyCapability: HOST_CAPABILITY,
    },
    localStorage: {
      getItem(key) {
        return localStorageEntries.get(String(key)) ?? null;
      },
      setItem(key, value) {
        localStorageEntries.set(String(key), String(value));
      },
      removeItem(key) {
        localStorageEntries.delete(String(key));
      },
      clear() {
        localStorageEntries.clear();
      },
    },
    setTimeout: (...args) => windowTimers.setTimeout(...args),
    clearTimeout: (timer) => windowTimers.clearTimeout(timer),
    dispatchEvent() {},
    close() {},
  };
  globalThis.document = {
    documentElement: {
      dataset: { product: 'deepcode-gui' },
    },
  };
  if (typeof globalThis.CustomEvent === 'undefined') {
    globalThis.CustomEvent = class CustomEvent {
      constructor(type, options = {}) {
        this.type = type;
        this.detail = options.detail;
      }
    };
  }

  console.log(
    `[INFO] ${SUITE_ID}: ${contractCases.length} GUI store contracts`
  );
  try {
    for (const contractCase of contractCases) {
      try {
        await runContractCase(host, contractCase);
        console.log(`[PASS] ${contractCase.id}`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[FAIL] ${contractCase.id}: ${detail}`);
        throw error;
      }
    }
  } finally {
    windowTimers.clearAll();
    await host.close();
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.stack ?? error.message : String(error)
  );
  process.exitCode = 1;
});
