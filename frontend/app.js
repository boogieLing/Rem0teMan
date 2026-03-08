const STATUS_TEXT = {
  unknown: '未知',
  checking: '检测中',
  unstable: '不稳定',
  online: '已连接',
  offline: '离线',
};

const POLL_INTERVAL_MS = 180000;
const STATS_POLL_INTERVAL_MS = 120000;
const STATS_HISTORY_LIMIT = 60;
const STATS_STORAGE_KEY = 'rsm.server.stats.v1';
const STATS_STORAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SCRIPT_HISTORY_LIMIT = 80;
const SCRIPT_HISTORY_STORAGE_KEY = 'rsm.project.script-history.v1';

const state = {
  config: { version: '1.0', servers: [] },
  layoutTab: 'servers',
  currentView: {
    type: 'server',
    serverId: null,
    projectId: null,
  },
  openServerMenuId: null,
  connectionStatus: {},
  passwordVisible: {},
  scriptCollapsed: {},
  scriptRuntime: {},
  scriptHistory: {},
  serverStats: {},
  statsHistory: {},
  consoleCollapsed: true,
  noteModalOpen: false,
  noteModalServerId: null,
  pollingTimer: null,
  statsPollingTimer: null,
  pollingRunning: false,
  statsPollingRunning: false,
};

const dom = {
  workspaceTabs: Array.from(document.querySelectorAll('[data-layout-tab]')),
  serverList: document.getElementById('server-list'),
  sidebarKicker: document.getElementById('sidebar-kicker'),
  sidebarTitle: document.getElementById('sidebar-title'),
  sidebarMeta: document.getElementById('sidebar-meta'),
  contentBody: document.getElementById('content-body'),
  contentTitle: document.getElementById('content-title'),
  contentSubtitle: document.getElementById('content-subtitle'),
  consoleOutput: document.getElementById('console-output'),
  consolePanel: document.getElementById('console-panel'),
  toggleConsoleBtn: document.getElementById('toggle-console-btn'),
  addServerBtn: document.getElementById('add-server-btn'),
  saveConfigBtn: document.getElementById('save-config-btn'),
  contentTestBtn: document.getElementById('content-test-btn'),
  clearConsoleBtn: document.getElementById('clear-console-btn'),
  noteModal: document.getElementById('note-modal'),
  noteModalTitle: document.getElementById('note-modal-title'),
  noteModalInput: document.getElementById('note-modal-input'),
  noteModalCloseBtn: document.getElementById('note-modal-close-btn'),
  noteModalSaveBtn: document.getElementById('note-modal-save-btn'),
};

// generateId：负责当前模块对应的状态、渲染或事件逻辑。
function generateId(prefix) {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return `${prefix}-${window.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}`;
}

// escapeAttr：负责当前模块对应的状态、渲染或事件逻辑。
function escapeAttr(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// logMessage：负责当前模块对应的状态、渲染或事件逻辑。
function logMessage(message, level = 'info') {
  const now = new Date();
  const timestamp = now.toLocaleTimeString();
  const prefix = level === 'error' ? '[ERROR]' : '[INFO]';
  dom.consoleOutput.textContent += `${timestamp} ${prefix} ${message}\n`;
  dom.consoleOutput.scrollTop = dom.consoleOutput.scrollHeight;
}

// normalizeServer：负责当前模块对应的状态、渲染或事件逻辑。
function normalizeServer(server) {
  return {
    ...server,
    extra_ipv4: server.extra_ipv4 ?? 'None',
    ram: server.ram ?? '',
    cpu_cores: server.cpu_cores ?? '',
    operating_system: server.operating_system ?? '',
    location: server.location ?? '',
    notes: server.notes ?? '',
    tags: Array.isArray(server.tags) ? server.tags : [],
    projects: Array.isArray(server.projects) ? server.projects : [],
    auth: {
      auth_type: server.auth?.auth_type ?? 'key',
      password: server.auth?.password ?? '',
      key_path: server.auth?.key_path ?? '',
      passphrase: server.auth?.passphrase ?? '',
    },
  };
}

// normalizeProject：负责当前模块对应的状态、渲染或事件逻辑。
function normalizeProject(project) {
  return {
    ...project,
    description: project.description ?? '',
    scripts: Array.isArray(project.scripts) ? project.scripts : [],
  };
}

// normalizeScript：负责当前模块对应的状态、渲染或事件逻辑。
function normalizeScript(script) {
  return {
    ...script,
    runner: script.runner === 'local' ? 'local' : 'remote',
    args: script.args ?? '',
  };
}

// 汇总所有项目，供侧栏不同视图与统计复用。
function getAllProjects() {
  return state.config.servers.flatMap((server) =>
    server.projects.map((project) => ({
      server,
      project,
    })),
  );
}

// 取当前最合适的项目选择，保证 Projects/Activity 视图始终有落点。
function getPreferredProjectSelection() {
  const activeServer = getActiveServer();
  const activeProject = getActiveProject();
  if (activeServer && activeProject) {
    return { server: activeServer, project: activeProject };
  }
  if (activeServer && activeServer.projects.length > 0) {
    return { server: activeServer, project: activeServer.projects[0] };
  }
  return getAllProjects()[0] ?? null;
}

// 统一切换顶部分栏，避免各入口各自维护视图同步逻辑。
function setLayoutTab(layoutTab) {
  state.layoutTab = layoutTab;

  if (layoutTab === 'servers') {
    if (!getActiveServer() && state.config.servers.length > 0) {
      state.currentView = {
        type: 'server',
        serverId: state.config.servers[0].id,
        projectId: null,
      };
    }
    return;
  }

  const preferredSelection = getPreferredProjectSelection();
  if (preferredSelection) {
    state.currentView = {
      type: 'project',
      serverId: preferredSelection.server.id,
      projectId: preferredSelection.project.id,
    };
  }

  if (layoutTab === 'activity') {
    setConsoleCollapsed(false);
  }
}

// getServerById：负责当前模块对应的状态、渲染或事件逻辑。
function getServerById(serverId) {
  return state.config.servers.find((item) => item.id === serverId) ?? null;
}

// getProjectById：负责当前模块对应的状态、渲染或事件逻辑。
function getProjectById(server, projectId) {
  return server.projects.find((item) => item.id === projectId) ?? null;
}

// getActiveServer：负责当前模块对应的状态、渲染或事件逻辑。
function getActiveServer() {
  if (!state.currentView.serverId) {
    return null;
  }
  return getServerById(state.currentView.serverId);
}

// getActiveProject：负责当前模块对应的状态、渲染或事件逻辑。
function getActiveProject() {
  const server = getActiveServer();
  if (!server || !state.currentView.projectId) {
    return null;
  }
  return getProjectById(server, state.currentView.projectId);
}

// ensureViewSelection：负责当前模块对应的状态、渲染或事件逻辑。
function ensureViewSelection() {
  if (state.config.servers.length === 0) {
    state.currentView = { type: 'server', serverId: null, projectId: null };
    return;
  }

  const currentServer = getServerById(state.currentView.serverId);
  if (!currentServer) {
    state.currentView = {
      type: 'server',
      serverId: state.config.servers[0].id,
      projectId: null,
    };
    return;
  }

  if (state.currentView.type === 'project') {
    const currentProject = getProjectById(currentServer, state.currentView.projectId);
    if (!currentProject) {
      state.currentView.type = 'server';
      state.currentView.projectId = null;
    }
  }

  if (state.layoutTab !== 'servers' && state.currentView.type !== 'project') {
    const preferredSelection = getPreferredProjectSelection();
    if (preferredSelection) {
      state.currentView = {
        type: 'project',
        serverId: preferredSelection.server.id,
        projectId: preferredSelection.project.id,
      };
    }
  }
}

// getStatus：负责当前模块对应的状态、渲染或事件逻辑。
function getStatus(serverId) {
  return (
    state.connectionStatus[serverId] ?? {
      state: 'unknown',
      message: '尚未检测',
      failCount: 0,
      lastSuccessAt: null,
    }
  );
}

// setStatus：负责当前模块对应的状态、渲染或事件逻辑。
function setStatus(serverId, status, message, extra = {}) {
  const prev = getStatus(serverId);
  state.connectionStatus[serverId] = {
    ...prev,
    state: status,
    message,
    checkedAt: new Date().toISOString(),
    ...extra,
  };
}

// setConsoleCollapsed：负责当前模块对应的状态、渲染或事件逻辑。
function setConsoleCollapsed(collapsed) {
  state.consoleCollapsed = collapsed;
  dom.consolePanel.classList.toggle('collapsed', collapsed);
  dom.toggleConsoleBtn.textContent = collapsed ? '展开' : '收起';
}

// applyContentTitleMode：负责当前模块对应的状态、渲染或事件逻辑。
function applyContentTitleMode() {
  const isServerView = state.currentView.type === 'server' && Boolean(getActiveServer());
  dom.contentTitle.classList.toggle('note-title-action', isServerView);
  if (isServerView) {
    dom.contentTitle.title = '点击打开 Notes 浮窗';
  } else {
    dom.contentTitle.removeAttribute('title');
  }
}

// closeNoteModal：负责当前模块对应的状态、渲染或事件逻辑。
function closeNoteModal() {
  state.noteModalOpen = false;
  state.noteModalServerId = null;
  dom.noteModal.classList.add('hidden');
  dom.noteModal.setAttribute('aria-hidden', 'true');
}

// openNoteModal：负责当前模块对应的状态、渲染或事件逻辑。
function openNoteModal() {
  const server = getActiveServer();
  if (!server || state.currentView.type !== 'server') {
    return;
  }
  state.noteModalOpen = true;
  state.noteModalServerId = server.id;
  dom.noteModalTitle.textContent = `${server.name} · Notes`;
  dom.noteModalInput.value = server.notes ?? '';
  dom.noteModal.classList.remove('hidden');
  dom.noteModal.setAttribute('aria-hidden', 'false');
  window.setTimeout(() => dom.noteModalInput.focus(), 0);
}

// saveNoteModal：负责当前模块对应的状态、渲染或事件逻辑。
function saveNoteModal() {
  if (!state.noteModalOpen || !state.noteModalServerId) {
    return;
  }
  const server = getServerById(state.noteModalServerId);
  if (!server) {
    closeNoteModal();
    return;
  }
  server.notes = dom.noteModalInput.value;
  logMessage(`${server.name}: Notes 已更新（记得保存配置）。`);
  closeNoteModal();
}

// getStatsSnapshot：负责当前模块对应的状态、渲染或事件逻辑。
function getStatsSnapshot(serverId) {
  return state.serverStats[serverId] ?? null;
}

// getStatsHistory：负责当前模块对应的状态、渲染或事件逻辑。
function getStatsHistory(serverId) {
  if (!Array.isArray(state.statsHistory[serverId])) {
    state.statsHistory[serverId] = [];
  }
  return state.statsHistory[serverId];
}

// resetServerStatsCache：负责当前模块对应的状态、渲染或事件逻辑。
function resetServerStatsCache(serverId) {
  delete state.serverStats[serverId];
  delete state.statsHistory[serverId];
  persistStatsCache();
}

// getProjectScriptHistory：负责当前模块对应的状态、渲染或事件逻辑。
function getProjectScriptHistory(projectId) {
  if (!Array.isArray(state.scriptHistory[projectId])) {
    state.scriptHistory[projectId] = [];
  }
  return state.scriptHistory[projectId];
}

// resetProjectScriptHistory：负责当前模块对应的状态、渲染或事件逻辑。
function resetProjectScriptHistory(projectId) {
  delete state.scriptHistory[projectId];
  persistScriptHistoryCache();
}

// canUseLocalStorage：负责当前模块对应的状态、渲染或事件逻辑。
function canUseLocalStorage() {
  try {
    return typeof window !== 'undefined' && Boolean(window.localStorage);
  } catch (_error) {
    return false;
  }
}

// persistStatsCache：负责当前模块对应的状态、渲染或事件逻辑。
function persistStatsCache() {
  if (!canUseLocalStorage()) {
    return;
  }
  try {
    const statsHistory = {};
    for (const [serverId, history] of Object.entries(state.statsHistory)) {
      if (!Array.isArray(history) || history.length === 0) {
        continue;
      }
      statsHistory[serverId] = history.slice(-STATS_HISTORY_LIMIT);
    }
    const payload = {
      version: 1,
      saved_at: new Date().toISOString(),
      statsHistory,
    };
    window.localStorage.setItem(STATS_STORAGE_KEY, JSON.stringify(payload));
  } catch (_error) {
    // localStorage 写入失败不影响主流程。
  }
}

// persistScriptHistoryCache：负责当前模块对应的状态、渲染或事件逻辑。
function persistScriptHistoryCache() {
  if (!canUseLocalStorage()) {
    return;
  }
  try {
    const scriptHistory = {};
    for (const [projectId, history] of Object.entries(state.scriptHistory)) {
      if (!Array.isArray(history) || history.length === 0) {
        continue;
      }
      scriptHistory[projectId] = history.slice(0, SCRIPT_HISTORY_LIMIT);
    }
    const payload = {
      version: 1,
      saved_at: new Date().toISOString(),
      scriptHistory,
    };
    window.localStorage.setItem(SCRIPT_HISTORY_STORAGE_KEY, JSON.stringify(payload));
  } catch (_error) {
    // localStorage 写入失败不影响主流程。
  }
}

// restoreStatsCache：负责当前模块对应的状态、渲染或事件逻辑。
function restoreStatsCache(validServerIds) {
  if (!canUseLocalStorage()) {
    return;
  }
  try {
    const raw = window.localStorage.getItem(STATS_STORAGE_KEY);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.statsHistory !== 'object') {
      return;
    }

    const now = Date.now();
    for (const [serverId, history] of Object.entries(parsed.statsHistory)) {
      if (!validServerIds.has(serverId) || !Array.isArray(history)) {
        continue;
      }

      const normalized = history
        .map((sample) => {
          if (!sample || typeof sample !== 'object') {
            return null;
          }
          const sampledAtMs = Number(sample.sampledAtMs || Date.parse(sample.sampled_at || ''));
          if (!Number.isFinite(sampledAtMs)) {
            return null;
          }
          if (now - sampledAtMs > STATS_STORAGE_MAX_AGE_MS) {
            return null;
          }
          return {
            ...sample,
            sampledAtMs,
          };
        })
        .filter((sample) => sample !== null)
        .sort((a, b) => a.sampledAtMs - b.sampledAtMs)
        .slice(-STATS_HISTORY_LIMIT);

      if (normalized.length === 0) {
        continue;
      }
      state.statsHistory[serverId] = normalized;
      state.serverStats[serverId] = normalized[normalized.length - 1];
    }
  } catch (_error) {
    // localStorage 读取失败不影响主流程。
  }
}

// restoreScriptHistoryCache：负责当前模块对应的状态、渲染或事件逻辑。
function restoreScriptHistoryCache(validProjectIds) {
  if (!canUseLocalStorage()) {
    return;
  }
  try {
    const raw = window.localStorage.getItem(SCRIPT_HISTORY_STORAGE_KEY);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.scriptHistory !== 'object') {
      return;
    }

    for (const [projectId, history] of Object.entries(parsed.scriptHistory)) {
      if (!validProjectIds.has(projectId) || !Array.isArray(history)) {
        continue;
      }
      const normalized = history
        .map((entry) => {
          if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') {
            return null;
          }
          return {
            id: entry.id,
            serverId: entry.serverId ?? '',
            serverName: entry.serverName ?? '',
            projectId,
            projectName: entry.projectName ?? '',
            scriptId: entry.scriptId ?? '',
            scriptName: entry.scriptName ?? '未命名脚本',
            runner: entry.runner === 'local' ? 'local' : 'remote',
            command: entry.command ?? '',
            working_dir: entry.working_dir ?? '',
            args: entry.args ?? '',
            status: entry.status === 'running' ? 'running' : entry.status === 'success' ? 'success' : 'failed',
            message: entry.message ?? '',
            exitCode: Number.isFinite(Number(entry.exitCode)) ? Number(entry.exitCode) : null,
            startedAt: entry.startedAt ?? null,
            finishedAt: entry.finishedAt ?? null,
            durationMs: Number.isFinite(Number(entry.durationMs)) ? Number(entry.durationMs) : null,
          };
        })
        .filter((entry) => entry !== null)
        .slice(0, SCRIPT_HISTORY_LIMIT);

      if (normalized.length === 0) {
        continue;
      }
      state.scriptHistory[projectId] = normalized;
    }
  } catch (_error) {
    // localStorage 读取失败不影响主流程。
  }
}

// pruneStatsCache：负责当前模块对应的状态、渲染或事件逻辑。
function pruneStatsCache(validServerIds) {
  for (const serverId of Object.keys(state.serverStats)) {
    if (!validServerIds.has(serverId)) {
      delete state.serverStats[serverId];
    }
  }
  for (const serverId of Object.keys(state.statsHistory)) {
    if (!validServerIds.has(serverId)) {
      delete state.statsHistory[serverId];
    }
  }
}

// pruneScriptHistoryCache：负责当前模块对应的状态、渲染或事件逻辑。
function pruneScriptHistoryCache(validProjectIds) {
  for (const projectId of Object.keys(state.scriptHistory)) {
    if (!validProjectIds.has(projectId)) {
      delete state.scriptHistory[projectId];
    }
  }
}

// toFiniteNumber：负责当前模块对应的状态、渲染或事件逻辑。
function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

// formatCount：负责当前模块对应的状态、渲染或事件逻辑。
function formatCount(value) {
  return Math.round(toFiniteNumber(value, 0)).toLocaleString();
}

// formatMib：负责当前模块对应的状态、渲染或事件逻辑。
function formatMib(value) {
  return `${Math.round(toFiniteNumber(value, 0)).toLocaleString()} MiB`;
}

// formatPercent：负责当前模块对应的状态、渲染或事件逻辑。
function formatPercent(value) {
  return `${Math.round(toFiniteNumber(value, 0))}%`;
}

// formatRateKiB：负责当前模块对应的状态、渲染或事件逻辑。
function formatRateKiB(value) {
  return `${toFiniteNumber(value, 0).toFixed(1)} KiB/s`;
}

// formatSampleTime：负责当前模块对应的状态、渲染或事件逻辑。
function formatSampleTime(isoString) {
  if (!isoString) {
    return '尚未采集';
  }
  const parsed = Date.parse(isoString);
  if (!Number.isFinite(parsed)) {
    return '尚未采集';
  }
  return new Date(parsed).toLocaleTimeString();
}

// formatDateTime：负责当前模块对应的状态、渲染或事件逻辑。
function formatDateTime(isoString) {
  if (!isoString) {
    return '--';
  }
  const parsed = Date.parse(isoString);
  if (!Number.isFinite(parsed)) {
    return '--';
  }
  return new Date(parsed).toLocaleString();
}

// formatDuration：负责当前模块对应的状态、渲染或事件逻辑。
function formatDuration(durationMs) {
  const ms = Number(durationMs);
  if (!Number.isFinite(ms) || ms < 0) {
    return '--';
  }
  if (ms < 1000) {
    return '<1s';
  }

  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

// formatRelativeDateLabel：负责当前模块对应的状态、渲染或事件逻辑。
function formatRelativeDateLabel(isoString) {
  if (!isoString) {
    return '--';
  }
  const parsed = Date.parse(isoString);
  if (!Number.isFinite(parsed)) {
    return '--';
  }

  const now = new Date();
  const value = new Date(parsed);
  const sameDay =
    now.getFullYear() === value.getFullYear() &&
    now.getMonth() === value.getMonth() &&
    now.getDate() === value.getDate();

  if (sameDay) {
    return value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return value.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// 汇总所有项目历史，供 Activity 侧栏展示全局执行流。
function getAllHistoryEntries() {
  return getAllProjects()
    .flatMap(({ server, project }) =>
      getProjectScriptHistory(project.id).map((entry) => ({
        ...entry,
        server,
        project,
      })),
    )
    .sort((left, right) => Date.parse(right.startedAt || '') - Date.parse(left.startedAt || ''));
}

// getProjectExecutionStats：负责当前模块对应的状态、渲染或事件逻辑。
function getProjectExecutionStats(project) {
  const history = getProjectScriptHistory(project.id);
  const finishedEntries = history.filter((entry) => Number.isFinite(entry.durationMs));
  const successCount = history.filter((entry) => entry.status === 'success').length;
  const failedCount = history.filter((entry) => entry.status === 'failed').length;
  const runningCount = history.filter((entry) => entry.status === 'running').length;
  const lastFinished = finishedEntries[0] ?? null;
  const averageDurationMs =
    finishedEntries.length === 0
      ? null
      : finishedEntries.reduce((sum, entry) => sum + entry.durationMs, 0) / finishedEntries.length;
  const maxDurationMs =
    finishedEntries.length === 0
      ? null
      : Math.max(...finishedEntries.map((entry) => entry.durationMs));

  return {
    totalRuns: history.length,
    successCount,
    failedCount,
    runningCount,
    averageDurationMs,
    maxDurationMs,
    lastDurationMs: lastFinished?.durationMs ?? null,
  };
}

// addProjectScriptHistoryEntry：负责当前模块对应的状态、渲染或事件逻辑。
function addProjectScriptHistoryEntry(server, project, script, startedAt) {
  const history = getProjectScriptHistory(project.id);
  const entry = {
    id: generateId('script-run'),
    serverId: server.id,
    serverName: server.name,
    projectId: project.id,
    projectName: project.name,
    scriptId: script.id,
    scriptName: script.name,
    runner: script.runner === 'local' ? 'local' : 'remote',
    command: script.command,
    working_dir: script.working_dir,
    args: script.args ?? '',
    status: 'running',
    message: '执行中',
    exitCode: null,
    startedAt,
    finishedAt: null,
    durationMs: null,
  };
  history.unshift(entry);
  if (history.length > SCRIPT_HISTORY_LIMIT) {
    history.splice(SCRIPT_HISTORY_LIMIT);
  }
  persistScriptHistoryCache();
  return entry.id;
}

// updateProjectScriptHistoryEntry：负责当前模块对应的状态、渲染或事件逻辑。
function updateProjectScriptHistoryEntry(projectId, entryId, patch) {
  if (!entryId) {
    return;
  }
  const history = getProjectScriptHistory(projectId);
  const target = history.find((entry) => entry.id === entryId);
  if (!target) {
    return;
  }
  Object.assign(target, patch);
  persistScriptHistoryCache();
}

// finalizeScriptRuntime：负责当前模块对应的状态、渲染或事件逻辑。
function finalizeScriptRuntime(project, script, status, message, exitCode) {
  const previous = getScriptRuntime(project.id, script.id) ?? {};
  const finishedAt = new Date().toISOString();
  const startedAt = previous.startedAt ?? finishedAt;
  const durationDelta = Date.parse(finishedAt) - Date.parse(startedAt);
  const durationMs = Number.isFinite(durationDelta) ? Math.max(durationDelta, 0) : null;
  const runtime = {
    ...previous,
    status,
    message,
    exitCode,
    finishedAt,
    durationMs,
  };
  setScriptRuntime(project.id, script.id, runtime);
  updateProjectScriptHistoryEntry(project.id, previous.historyEntryId, {
    status,
    message,
    exitCode,
    finishedAt,
    durationMs,
  });
  return runtime;
}

// buildLinePoints：负责当前模块对应的状态、渲染或事件逻辑。
function buildLinePoints(values, minValue, maxValue) {
  const width = 320;
  const height = 112;
  const padding = 12;
  if (values.length === 0) {
    return '';
  }
  const range = Math.max(maxValue - minValue, 1e-6);
  if (values.length === 1) {
    const onlyY = height - padding;
    return `${padding},${onlyY} ${width - padding},${onlyY}`;
  }

  return values
    .map((value, index) => {
      const x = padding + (index / (values.length - 1)) * (width - padding * 2);
      const y = padding + ((maxValue - value) / range) * (height - padding * 2);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}

// renderSingleLineChart：负责当前模块对应的状态、渲染或事件逻辑。
function renderSingleLineChart(title, values, valueFormatter) {
  if (values.length === 0) {
    return `
      <article class="stats-chart-card">
        <div class="stats-chart-head">
          <h4>${title}</h4>
          <span>暂无</span>
        </div>
        <div class="stats-chart-empty">暂无数据</div>
      </article>
    `;
  }

  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const points = buildLinePoints(values, minValue, maxValue);
  const latest = values[values.length - 1];

  return `
    <article class="stats-chart-card">
      <div class="stats-chart-head">
        <h4>${title}</h4>
        <span>${valueFormatter(latest)}</span>
      </div>
      <div class="stats-chart-wrap">
        <svg viewBox="0 0 320 112" class="stats-chart-svg" preserveAspectRatio="none" aria-hidden="true">
          <polyline points="12,100 308,100" class="stats-grid-line"></polyline>
          <polyline points="${points}" class="stats-line-primary"></polyline>
        </svg>
      </div>
      <div class="stats-chart-meta">
        <span>min ${valueFormatter(minValue)}</span>
        <span>max ${valueFormatter(maxValue)}</span>
      </div>
    </article>
  `;
}

// renderDualLineChart：负责当前模块对应的状态、渲染或事件逻辑。
function renderDualLineChart(title, seriesA, seriesB, seriesALabel, seriesBLabel, valueFormatter) {
  if (seriesA.length === 0 || seriesB.length === 0) {
    return `
      <article class="stats-chart-card">
        <div class="stats-chart-head">
          <h4>${title}</h4>
          <span>暂无</span>
        </div>
        <div class="stats-chart-empty">暂无数据</div>
      </article>
    `;
  }

  const allValues = [...seriesA, ...seriesB];
  const minValue = Math.min(...allValues);
  const maxValue = Math.max(...allValues);
  const pointsA = buildLinePoints(seriesA, minValue, maxValue);
  const pointsB = buildLinePoints(seriesB, minValue, maxValue);
  const latestA = seriesA[seriesA.length - 1];
  const latestB = seriesB[seriesB.length - 1];

  return `
    <article class="stats-chart-card">
      <div class="stats-chart-head">
        <h4>${title}</h4>
        <span>${seriesALabel} ${valueFormatter(latestA)} / ${seriesBLabel} ${valueFormatter(latestB)}</span>
      </div>
      <div class="stats-chart-wrap">
        <svg viewBox="0 0 320 112" class="stats-chart-svg" preserveAspectRatio="none" aria-hidden="true">
          <polyline points="12,100 308,100" class="stats-grid-line"></polyline>
          <polyline points="${pointsA}" class="stats-line-rx"></polyline>
          <polyline points="${pointsB}" class="stats-line-tx"></polyline>
        </svg>
      </div>
      <div class="stats-chart-meta">
        <span>${seriesALabel} ${valueFormatter(latestA)}</span>
        <span>${seriesBLabel} ${valueFormatter(latestB)}</span>
      </div>
    </article>
  `;
}

// renderStatsPanel：负责当前模块对应的状态、渲染或事件逻辑。
function renderStatsPanel(server) {
  const snapshot = getStatsSnapshot(server.id);
  const history = getStatsHistory(server.id);
  const status = getStatus(server.id);
  const memorySeries = history.map((item) => toFiniteNumber(item.mem_used_pct, 0));
  const tcpSeries = history.map((item) => toFiniteNumber(item.tcp_established, 0));
  const rxSeries = history.map((item) => toFiniteNumber(item.net_rx_kib_s, 0));
  const txSeries = history.map((item) => toFiniteNumber(item.net_tx_kib_s, 0));

  let body = '<div class="stats-empty">暂无监控数据，点击“刷新监控”或等待定时采集。</div>';
  if (snapshot) {
    body = `
      <div class="stats-kpi-grid">
        <div class="stats-kpi-card">
          <div class="stats-kpi-label">内存使用</div>
          <div class="stats-kpi-value">${formatMib(snapshot.mem_used_mb)} / ${formatMib(snapshot.mem_total_mb)} (${formatPercent(snapshot.mem_used_pct)})</div>
        </div>
        <div class="stats-kpi-card">
          <div class="stats-kpi-label">TCP 已建立</div>
          <div class="stats-kpi-value">${formatCount(snapshot.tcp_established)}</div>
        </div>
        <div class="stats-kpi-card">
          <div class="stats-kpi-label">Socket inuse</div>
          <div class="stats-kpi-value">TCP ${formatCount(snapshot.tcp_inuse)} / UDP ${formatCount(snapshot.udp_inuse)}</div>
        </div>
        <div class="stats-kpi-card">
          <div class="stats-kpi-label">Load Avg</div>
          <div class="stats-kpi-value">${toFiniteNumber(snapshot.load1, 0).toFixed(2)} / ${toFiniteNumber(snapshot.load5, 0).toFixed(2)} / ${toFiniteNumber(snapshot.load15, 0).toFixed(2)}</div>
        </div>
      </div>

      <div class="stats-charts-grid">
        ${renderSingleLineChart('内存使用率', memorySeries, (value) => `${toFiniteNumber(value, 0).toFixed(0)}%`)}
        ${renderSingleLineChart('TCP 已建立连接', tcpSeries, (value) => formatCount(value))}
        ${renderDualLineChart('网络吞吐', rxSeries, txSeries, 'RX', 'TX', (value) => formatRateKiB(value))}
      </div>
    `;
  }

  return `
    <section class="stats-panel panel-sub">
      <div class="section-head">
        <h3>基础监控（轻量）</h3>
        <div class="inline-actions">
          <span class="stats-sample-time">状态: ${STATUS_TEXT[status.state] || '未知'} · 最近采集 ${formatSampleTime(snapshot?.sampled_at)}</span>
          <button class="btn btn-secondary" data-action="refresh-stats" data-server-id="${escapeAttr(server.id)}">刷新监控</button>
        </div>
      </div>
      ${body}
    </section>
  `;
}

// 渲染顶部文件夹页签，保持 UI 状态与内部视图同步。
function renderWorkspaceTabs() {
  for (const tab of dom.workspaceTabs) {
    const isActive = tab.dataset.layoutTab === state.layoutTab;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  }
}

// 侧栏标题随顶部分栏切换，避免用户在不同视图里失去上下文。
function renderSidebarChrome() {
  const serverCount = state.config.servers.length;
  const projectCount = getAllProjects().length;
  const historyCount = getAllHistoryEntries().length;

  if (state.layoutTab === 'projects') {
    dom.sidebarKicker.textContent = 'Cross Server Index';
    dom.sidebarTitle.textContent = 'Projects';
    dom.sidebarMeta.textContent = `${projectCount} projects across ${serverCount} servers`;
    return;
  }

  if (state.layoutTab === 'activity') {
    dom.sidebarKicker.textContent = 'Execution Feed';
    dom.sidebarTitle.textContent = 'Activity';
    dom.sidebarMeta.textContent = `${historyCount} recent script runs`;
    return;
  }

  dom.sidebarKicker.textContent = 'Workspace';
  dom.sidebarTitle.textContent = 'Servers';
  dom.sidebarMeta.textContent = `${serverCount} servers · ${projectCount} projects`;
}

// Projects 视图使用跨服务器扁平索引，降低多机多项目时的导航层级。
function renderProjectsSidebar() {
  const projectRows = getAllProjects()
    .map(({ server, project }) => {
      const isActive =
        state.currentView.type === 'project' &&
        state.currentView.serverId === server.id &&
        state.currentView.projectId === project.id;
      return `
        <article class="browser-row ${isActive ? 'active' : ''}">
          <button class="browser-link" data-action="open-project" data-server-id="${escapeAttr(server.id)}" data-project-id="${escapeAttr(project.id)}">
            <div class="browser-meta">
              <span>${escapeAttr(server.name)}</span>
              <span>${escapeAttr(String(project.scripts.length))} scripts</span>
            </div>
            <div class="browser-title">${escapeAttr(project.name)}</div>
            <div class="browser-preview">${escapeAttr(project.path || project.description || '--')}</div>
          </button>
          <button class="browser-delete" data-action="delete-project" data-server-id="${escapeAttr(server.id)}" data-project-id="${escapeAttr(project.id)}">×</button>
        </article>
      `;
    })
    .join('');

  dom.serverList.innerHTML =
    projectRows || '<div class="empty">暂无项目，先在 Servers 视图里创建。</div>';
}

// Activity 视图聚合所有脚本执行记录，让日志入口从底部抽屉提升为主导航。
function renderActivitySidebar() {
  const historyRows = getAllHistoryEntries()
    .slice(0, 18)
    .map((entry) => {
      const statusText =
        entry.status === 'running' ? '执行中' : entry.status === 'success' ? '成功' : '失败';
      const isActive =
        state.currentView.type === 'project' &&
        state.currentView.serverId === entry.server.id &&
        state.currentView.projectId === entry.project.id;
      return `
        <article class="browser-row activity-row ${isActive ? 'active' : ''}">
          <button class="browser-link" data-action="open-project" data-server-id="${escapeAttr(entry.server.id)}" data-project-id="${escapeAttr(entry.project.id)}">
            <div class="browser-meta">
              <span>${escapeAttr(formatRelativeDateLabel(entry.startedAt))}</span>
              <span class="mini-badge ${escapeAttr(entry.status)}">${escapeAttr(statusText)}</span>
            </div>
            <div class="browser-title">${escapeAttr(entry.project.name)} / ${escapeAttr(entry.scriptName)}</div>
            <div class="browser-preview">${escapeAttr(entry.message || entry.command || '--')}</div>
          </button>
        </article>
      `;
    })
    .join('');

  dom.serverList.innerHTML =
    historyRows || '<div class="empty">暂无脚本执行记录，运行任意 Script 后会出现在这里。</div>';
}

// renderServerList：负责当前模块对应的状态、渲染或事件逻辑。
function renderServerList() {
  if (state.config.servers.length === 0) {
    dom.serverList.innerHTML = '<div class="empty">暂无服务器，点击右上角 + 新建。</div>';
    return;
  }

  if (state.layoutTab === 'projects') {
    renderProjectsSidebar();
    return;
  }

  if (state.layoutTab === 'activity') {
    renderActivitySidebar();
    return;
  }

  dom.serverList.innerHTML = state.config.servers
    .map((server) => {
      const serverActive = state.currentView.serverId === server.id;
      const status = getStatus(server.id);
      const isProjectActive =
        state.currentView.type === 'project' && state.currentView.serverId === server.id;
      const isMenuOpen = state.openServerMenuId === server.id;

      const projectNav = server.projects
        .map((project) => {
          const activeClass =
            isProjectActive && state.currentView.projectId === project.id ? 'active' : '';
          return `
            <div class="project-nav-item">
              <button class="project-link ${activeClass}" data-action="open-project" data-server-id="${escapeAttr(server.id)}" data-project-id="${escapeAttr(project.id)}">${escapeAttr(project.name)}</button>
              <button class="project-delete" data-action="delete-project" data-server-id="${escapeAttr(server.id)}" data-project-id="${escapeAttr(project.id)}">×</button>
            </div>
          `;
        })
        .join('');

      return `
        <article class="server-card ${serverActive ? 'active' : ''}">
          <div class="server-top">
            <div class="server-head" data-action="open-server" data-server-id="${escapeAttr(server.id)}">
              <div>
                <div class="server-title">${escapeAttr(server.name)}</div>
                <div class="server-meta">${escapeAttr(server.username)}@${escapeAttr(server.host)}:${escapeAttr(server.port)}</div>
                ${server.location ? `<div class="server-meta">${escapeAttr(server.location)}</div>` : ''}
              </div>
              <span class="status-pill ${escapeAttr(status.state)}">${escapeAttr(STATUS_TEXT[status.state] || '未知')}</span>
            </div>

            <div class="server-menu">
              <button class="menu-trigger" data-action="toggle-server-menu" data-server-id="${escapeAttr(server.id)}" aria-label="Server Actions">···</button>
              <div class="server-menu-panel ${isMenuOpen ? 'open' : ''}">
                <button class="menu-item" data-action="open-server" data-server-id="${escapeAttr(server.id)}">配置</button>
                <button class="menu-item" data-action="add-project" data-server-id="${escapeAttr(server.id)}">+项目</button>
                <button class="menu-item gradient" data-action="test-server" data-server-id="${escapeAttr(server.id)}">测试</button>
                <button class="menu-item danger" data-action="delete-server" data-server-id="${escapeAttr(server.id)}">删除</button>
              </div>
            </div>
          </div>

          <div class="project-nav">
            ${projectNav || '<div class="server-meta">暂无项目</div>'}
          </div>
        </article>
      `;
    })
    .join('');
}

// renderServerPanel：负责当前模块对应的状态、渲染或事件逻辑。
function renderServerPanel(server) {
  const isPasswordVisible = Boolean(state.passwordVisible[server.id]);

  const authFields =
    server.auth.auth_type === 'key'
      ? `
        <div class="field">
          <label>Auth Type</label>
          <select class="server-auth-field" data-field="auth_type">
            <option value="key" ${server.auth.auth_type === 'key' ? 'selected' : ''}>SSH Key</option>
            <option value="password" ${server.auth.auth_type === 'password' ? 'selected' : ''}>Password</option>
          </select>
        </div>
        <div class="field span-2">
          <label>Key Path</label>
          <input class="server-auth-field" data-field="key_path" value="${escapeAttr(server.auth.key_path)}" />
        </div>
        <div class="field span-2">
          <label>Passphrase (可选)</label>
          <input type="password" class="server-auth-field" data-field="passphrase" value="${escapeAttr(server.auth.passphrase)}" />
        </div>
      `
      : `
        <div class="field">
          <label>Auth Type</label>
          <select class="server-auth-field" data-field="auth_type">
            <option value="key" ${server.auth.auth_type === 'key' ? 'selected' : ''}>SSH Key</option>
            <option value="password" ${server.auth.auth_type === 'password' ? 'selected' : ''}>Password</option>
          </select>
        </div>
        <div class="field span-2">
          <label>Password</label>
          <div class="password-input-wrap">
            <input type="${isPasswordVisible ? 'text' : 'password'}" class="server-auth-field" data-field="password" value="${escapeAttr(server.auth.password)}" />
            <button class="toggle-pass-btn" data-action="toggle-password" data-server-id="${escapeAttr(server.id)}">${isPasswordVisible ? '隐藏' : '查看'}</button>
          </div>
        </div>
      `;

  return `
    <div class="form-grid">
      <div class="field"><label>Server Name</label><input class="server-field" data-field="name" value="${escapeAttr(server.name)}" /></div>
      <div class="field"><label>Host</label><input class="server-field" data-field="host" value="${escapeAttr(server.host)}" /></div>
      <div class="field"><label>Port</label><input class="server-field" type="number" data-field="port" value="${escapeAttr(server.port)}" /></div>

      <div class="field"><label>Username</label><input class="server-field" data-field="username" value="${escapeAttr(server.username)}" /></div>
      <div class="field"><label>Extra IPv4</label><input class="server-field" data-field="extra_ipv4" value="${escapeAttr(server.extra_ipv4)}" /></div>
      <div class="field"><label>RAM</label><input class="server-field" data-field="ram" value="${escapeAttr(server.ram)}" /></div>

      <div class="field"><label>CPU Cores</label><input class="server-field" data-field="cpu_cores" value="${escapeAttr(server.cpu_cores)}" /></div>
      <div class="field"><label>Operating System</label><input class="server-field" data-field="operating_system" value="${escapeAttr(server.operating_system)}" /></div>
      <div class="field"><label>Location</label><input class="server-field" data-field="location" value="${escapeAttr(server.location)}" /></div>

      ${authFields}
    </div>
    ${renderStatsPanel(server)}
  `;
}

// getNextScriptName：负责当前模块对应的状态、渲染或事件逻辑。
function getNextScriptName(project) {
  const existing = new Set(project.scripts.map((item) => item.name.trim().toLowerCase()));
  let index = project.scripts.length + 1;
  while (existing.has(`script-${index}`.toLowerCase())) {
    index += 1;
  }
  return `script-${index}`;
}

// createDefaultScript：负责当前模块对应的状态、渲染或事件逻辑。
function createDefaultScript(project) {
  return {
    id: generateId('script'),
    name: getNextScriptName(project),
    runner: 'remote',
    command: './start.sh',
    working_dir: project.path || '/srv/app',
    args: '',
  };
}

// getScriptCollapseKey：负责当前模块对应的状态、渲染或事件逻辑。
function getScriptCollapseKey(projectId, scriptId) {
  return `${projectId}::${scriptId}`;
}

// isScriptCollapsed：负责当前模块对应的状态、渲染或事件逻辑。
function isScriptCollapsed(projectId, scriptId) {
  const key = getScriptCollapseKey(projectId, scriptId);
  if (!(key in state.scriptCollapsed)) {
    return true;
  }
  return Boolean(state.scriptCollapsed[key]);
}

// clearScriptCollapseForProject：负责当前模块对应的状态、渲染或事件逻辑。
function clearScriptCollapseForProject(project) {
  for (const script of project.scripts) {
    delete state.scriptCollapsed[getScriptCollapseKey(project.id, script.id)];
  }
}

// getScriptRuntimeKey：负责当前模块对应的状态、渲染或事件逻辑。
function getScriptRuntimeKey(projectId, scriptId) {
  return `${projectId}::${scriptId}`;
}

// getScriptRuntime：负责当前模块对应的状态、渲染或事件逻辑。
function getScriptRuntime(projectId, scriptId) {
  return state.scriptRuntime[getScriptRuntimeKey(projectId, scriptId)] ?? null;
}

// setScriptRuntime：负责当前模块对应的状态、渲染或事件逻辑。
function setScriptRuntime(projectId, scriptId, runtime) {
  state.scriptRuntime[getScriptRuntimeKey(projectId, scriptId)] = runtime;
}

// clearScriptRuntime：负责当前模块对应的状态、渲染或事件逻辑。
function clearScriptRuntime(projectId, scriptId) {
  delete state.scriptRuntime[getScriptRuntimeKey(projectId, scriptId)];
}

// clearScriptRuntimeForProject：负责当前模块对应的状态、渲染或事件逻辑。
function clearScriptRuntimeForProject(project) {
  for (const script of project.scripts) {
    clearScriptRuntime(project.id, script.id);
  }
}

// pruneScriptRuntimeByConfig：负责当前模块对应的状态、渲染或事件逻辑。
function pruneScriptRuntimeByConfig() {
  const validKeys = new Set();
  for (const server of state.config.servers) {
    for (const project of server.projects) {
      for (const script of project.scripts) {
        validKeys.add(getScriptRuntimeKey(project.id, script.id));
      }
    }
  }
  for (const key of Object.keys(state.scriptRuntime)) {
    if (!validKeys.has(key)) {
      delete state.scriptRuntime[key];
    }
  }
}

// getScriptRuntimeLabel：负责当前模块对应的状态、渲染或事件逻辑。
function getScriptRuntimeLabel(runtime) {
  if (!runtime) {
    return '';
  }
  if (runtime.status === 'running') {
    return '执行中';
  }
  if (runtime.status === 'success') {
    return '成功';
  }
  if (runtime.status === 'failed') {
    return '失败';
  }
  return '';
}

// renderProjectHistory：负责当前模块对应的状态、渲染或事件逻辑。
function renderProjectHistory(project) {
  const history = getProjectScriptHistory(project.id);
  const stats = getProjectExecutionStats(project);
  const historyRows = history
    .slice(0, 10)
    .map((entry) => {
      const statusText =
        entry.status === 'running' ? '执行中' : entry.status === 'success' ? '成功' : '失败';
      return `
        <div class="history-row">
          <div class="history-main">
            <div class="history-title">
              <strong>${escapeAttr(entry.scriptName)}</strong>
              <span class="history-badge ${escapeAttr(entry.status)}">${escapeAttr(statusText)}</span>
              <span class="history-runner">${entry.runner === 'local' ? 'Local' : 'Remote'}</span>
            </div>
            <div class="history-meta">
              <span>开始: ${escapeAttr(formatDateTime(entry.startedAt))}</span>
              <span>时长: ${escapeAttr(entry.status === 'running' ? '进行中...' : formatDuration(entry.durationMs))}</span>
              <span>Exit: ${escapeAttr(entry.exitCode ?? '--')}</span>
            </div>
          </div>
          <div class="history-side">
            <div>${escapeAttr(entry.command || '--')}</div>
            <div>${escapeAttr(entry.message || '--')}</div>
          </div>
        </div>
      `;
    })
    .join('');

  return `
    <section class="project-history panel-sub">
      <div class="section-head">
        <h3>Script 执行历史</h3>
        <span class="history-caption">最近 ${Math.min(history.length, 10)} / ${history.length} 条</span>
      </div>

      <div class="history-stats-grid">
        <article class="history-stat-card">
          <div class="history-stat-label">总执行次数</div>
          <div class="history-stat-value">${escapeAttr(String(stats.totalRuns))}</div>
        </article>
        <article class="history-stat-card">
          <div class="history-stat-label">最近一次耗时</div>
          <div class="history-stat-value">${escapeAttr(formatDuration(stats.lastDurationMs))}</div>
        </article>
        <article class="history-stat-card">
          <div class="history-stat-label">平均耗时</div>
          <div class="history-stat-value">${escapeAttr(formatDuration(stats.averageDurationMs))}</div>
        </article>
        <article class="history-stat-card">
          <div class="history-stat-label">最长耗时</div>
          <div class="history-stat-value">${escapeAttr(formatDuration(stats.maxDurationMs))}</div>
        </article>
      </div>

      <div class="history-summary">
        成功 ${escapeAttr(String(stats.successCount))} 次 / 失败 ${escapeAttr(String(stats.failedCount))} 次 / 执行中 ${escapeAttr(String(stats.runningCount))} 次
      </div>

      <div class="history-list">
        ${historyRows || '<div class="empty">暂无执行历史，运行任意 Script 后会自动记录。</div>'}
      </div>
    </section>
  `;
}

// renderProjectPanel：负责当前模块对应的状态、渲染或事件逻辑。
function renderProjectPanel(server, project) {
  const hasRunningScripts = project.scripts.some(
    (item) => getScriptRuntime(project.id, item.id)?.status === 'running',
  );
  const scriptCards = project.scripts
    .map((script, index) => {
      const collapsed = isScriptCollapsed(project.id, script.id);
      const runtime = getScriptRuntime(project.id, script.id);
      const runtimeLabel = getScriptRuntimeLabel(runtime);
      const isRunning = runtime?.status === 'running';
      const runLabel = isRunning ? 'Running...' : 'Run';
      return `
      <div class="script-card ${collapsed ? 'collapsed' : ''}" data-script-id="${escapeAttr(script.id)}">
        <div class="script-card-head" data-action="toggle-script-collapse" data-project-id="${escapeAttr(project.id)}" data-script-id="${escapeAttr(script.id)}">
          <div class="script-title-wrap" data-action="toggle-script-collapse" data-project-id="${escapeAttr(project.id)}" data-script-id="${escapeAttr(script.id)}">
            <button class="script-collapse-btn" data-action="toggle-script-collapse" data-project-id="${escapeAttr(project.id)}" data-script-id="${escapeAttr(script.id)}" aria-expanded="${collapsed ? 'false' : 'true'}">${collapsed ? '▶' : '▼'}</button>
            <strong>${escapeAttr(script.name)}</strong>
            ${runtimeLabel ? `<span class="script-run-badge ${escapeAttr(runtime.status)}">${escapeAttr(runtimeLabel)}</span>` : ''}
          </div>
          <div class="inline-actions">
            <button class="btn btn-secondary" data-action="move-script-up" data-project-id="${escapeAttr(project.id)}" data-script-id="${escapeAttr(script.id)}" ${index === 0 || isRunning ? 'disabled' : ''}>↑</button>
            <button class="btn btn-secondary" data-action="move-script-down" data-project-id="${escapeAttr(project.id)}" data-script-id="${escapeAttr(script.id)}" ${index === project.scripts.length - 1 || isRunning ? 'disabled' : ''}>↓</button>
            <button class="btn btn-secondary" data-action="duplicate-script" data-project-id="${escapeAttr(project.id)}" data-script-id="${escapeAttr(script.id)}" ${isRunning ? 'disabled' : ''}>Duplicate</button>
            <button class="btn btn-secondary" data-action="run-script" data-server-id="${escapeAttr(server.id)}" data-project-id="${escapeAttr(project.id)}" data-script-id="${escapeAttr(script.id)}" ${isRunning ? 'disabled' : ''}>${runLabel}</button>
            <button class="btn btn-danger" data-action="delete-script" data-server-id="${escapeAttr(server.id)}" data-project-id="${escapeAttr(project.id)}" data-script-id="${escapeAttr(script.id)}" ${isRunning ? 'disabled' : ''}>Delete</button>
          </div>
        </div>

        <div class="form-grid script-card-content">
          <div class="field"><label>Script Name</label><input class="script-field" data-project-id="${escapeAttr(project.id)}" data-script-id="${escapeAttr(script.id)}" data-field="name" value="${escapeAttr(script.name)}" ${isRunning ? 'disabled' : ''} /></div>
          <div class="field">
            <label>Runner</label>
            <select class="script-field" data-project-id="${escapeAttr(project.id)}" data-script-id="${escapeAttr(script.id)}" data-field="runner" ${isRunning ? 'disabled' : ''}>
              <option value="remote" ${script.runner === 'remote' ? 'selected' : ''}>远端 SSH</option>
              <option value="local" ${script.runner === 'local' ? 'selected' : ''}>本地执行</option>
            </select>
          </div>
          <div class="field span-2"><label>Command / File Path</label><input class="script-field" data-project-id="${escapeAttr(project.id)}" data-script-id="${escapeAttr(script.id)}" data-field="command" value="${escapeAttr(script.command)}" ${isRunning ? 'disabled' : ''} /></div>
          <div class="field span-2"><label>Working Dir</label><input class="script-field" data-project-id="${escapeAttr(project.id)}" data-script-id="${escapeAttr(script.id)}" data-field="working_dir" value="${escapeAttr(script.working_dir)}" ${isRunning ? 'disabled' : ''} /></div>
          <div class="field"><label>Args (可选)</label><input class="script-field" data-project-id="${escapeAttr(project.id)}" data-script-id="${escapeAttr(script.id)}" data-field="args" value="${escapeAttr(script.args)}" ${isRunning ? 'disabled' : ''} /></div>
        </div>
      </div>
    `;
    })
    .join('');

  return `
    <div class="project-panel-head">
      <h3>Project Settings · Scripts (${project.scripts.length})</h3>
      <div class="inline-actions">
        <button class="btn btn-secondary" data-action="add-script" data-project-id="${escapeAttr(project.id)}">+ Script</button>
        <button class="btn btn-secondary" data-action="collapse-all-scripts" data-project-id="${escapeAttr(project.id)}" ${project.scripts.length === 0 ? 'disabled' : ''}>全部收起</button>
        <button class="btn btn-secondary" data-action="expand-all-scripts" data-project-id="${escapeAttr(project.id)}" ${project.scripts.length === 0 ? 'disabled' : ''}>全部展开</button>
        <button class="btn btn-secondary" data-action="run-all-scripts" data-project-id="${escapeAttr(project.id)}" ${project.scripts.length === 0 || hasRunningScripts ? 'disabled' : ''}>Run All</button>
      </div>
    </div>

    <div class="form-grid">
      <div class="field"><label>Project Name</label><input class="project-field" data-project-id="${escapeAttr(project.id)}" data-field="name" value="${escapeAttr(project.name)}" /></div>
      <div class="field span-2"><label>Project Path</label><input class="project-field" data-project-id="${escapeAttr(project.id)}" data-field="path" value="${escapeAttr(project.path)}" /></div>
      <div class="field span-3"><label>Description</label><textarea class="project-field" data-project-id="${escapeAttr(project.id)}" data-field="description">${escapeAttr(project.description)}</textarea></div>
    </div>

    <div class="script-list">
      ${scriptCards || '<div class="empty">暂无脚本，点击 + Script 创建。</div>'}
    </div>

    ${renderProjectHistory(project)}
  `;
}

// renderContent：负责当前模块对应的状态、渲染或事件逻辑。
function renderContent() {
  ensureViewSelection();
  const server = getActiveServer();
  if (!server) {
    dom.contentTitle.textContent = '未选择服务器';
    dom.contentSubtitle.textContent = '请选择左侧服务器或项目';
    applyContentTitleMode();
    dom.contentBody.innerHTML = '<div class="empty">暂无服务器配置。</div>';
    dom.contentTestBtn.disabled = true;
    return;
  }

  const status = getStatus(server.id);
  dom.contentTestBtn.disabled = false;

  if (state.currentView.type === 'project') {
    const project = getActiveProject();
    if (project) {
      dom.contentTitle.textContent = `${server.name} / ${project.name}`;
      dom.contentSubtitle.textContent = `项目管理 · 连接状态: ${STATUS_TEXT[status.state] || '未知'}`;
      applyContentTitleMode();
      dom.contentBody.innerHTML = renderProjectPanel(server, project);
      return;
    }
  }

  dom.contentTitle.textContent = server.name;
  dom.contentSubtitle.textContent = `服务器配置 · 连接状态: ${STATUS_TEXT[status.state] || '未知'}`;
  applyContentTitleMode();
  dom.contentBody.innerHTML = renderServerPanel(server);
}

// 仅刷新标题区域，避免输入时整块内容重绘造成焦点丢失。
function refreshContentHeaderOnly() {
  const server = getActiveServer();
  if (!server) {
    dom.contentTitle.textContent = '未选择服务器';
    dom.contentSubtitle.textContent = '请选择左侧服务器或项目';
    applyContentTitleMode();
    return;
  }

  const status = getStatus(server.id);
  if (state.currentView.type === 'project') {
    const project = getActiveProject();
    if (project) {
      dom.contentTitle.textContent = `${server.name} / ${project.name}`;
      dom.contentSubtitle.textContent = `项目管理 · 连接状态: ${STATUS_TEXT[status.state] || '未知'}`;
      applyContentTitleMode();
      return;
    }
  }

  dom.contentTitle.textContent = server.name;
  dom.contentSubtitle.textContent = `服务器配置 · 连接状态: ${STATUS_TEXT[status.state] || '未知'}`;
  applyContentTitleMode();
}

// renderAll：负责当前模块对应的状态、渲染或事件逻辑。
function renderAll() {
  renderWorkspaceTabs();
  renderSidebarChrome();
  renderServerList();
  renderContent();
}

// loadConfig：负责当前模块对应的状态、渲染或事件逻辑。
async function loadConfig() {
  const response = await fetch('/api/config');
  if (!response.ok) {
    throw new Error('加载配置失败');
  }

  const payload = await response.json();
  state.config = {
    version: payload.version ?? '1.0',
    servers: (Array.isArray(payload.servers) ? payload.servers : []).map((server) => {
      const normalizedServer = normalizeServer(server);
      normalizedServer.projects = normalizedServer.projects.map((project) => {
        const normalizedProject = normalizeProject(project);
        normalizedProject.scripts = normalizedProject.scripts.map((script) => normalizeScript(script));
        return normalizedProject;
      });
      return normalizedServer;
    }),
  };

  const validServerIds = new Set(state.config.servers.map((server) => server.id));
  const validProjectIds = new Set(
    state.config.servers.flatMap((server) => server.projects.map((project) => project.id)),
  );
  restoreStatsCache(validServerIds);
  restoreScriptHistoryCache(validProjectIds);
  for (const serverId of Object.keys(state.connectionStatus)) {
    if (!validServerIds.has(serverId)) {
      delete state.connectionStatus[serverId];
    }
  }
  for (const serverId of Object.keys(state.passwordVisible)) {
    if (!validServerIds.has(serverId)) {
      delete state.passwordVisible[serverId];
    }
  }
  pruneStatsCache(validServerIds);
  pruneScriptHistoryCache(validProjectIds);
  pruneScriptRuntimeByConfig();
  if (state.noteModalServerId && !validServerIds.has(state.noteModalServerId)) {
    closeNoteModal();
  }
  persistStatsCache();
  persistScriptHistoryCache();

  ensureViewSelection();
  renderAll();
}

// saveConfig：负责当前模块对应的状态、渲染或事件逻辑。
async function saveConfig() {
  const response = await fetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state.config),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`保存失败: ${detail}`);
  }

  const payload = await response.json();
  state.config.servers = payload.servers.map((item) => normalizeServer(item));
  pruneStatsCache(new Set(state.config.servers.map((server) => server.id)));
  pruneScriptHistoryCache(
    new Set(state.config.servers.flatMap((server) => server.projects.map((project) => project.id))),
  );
  pruneScriptRuntimeByConfig();
  persistStatsCache();
  persistScriptHistoryCache();
  ensureViewSelection();
  renderAll();
}

// testConnection：负责当前模块对应的状态、渲染或事件逻辑。
async function testConnection(serverId, silent = false, rerender = true) {
  const server = getServerById(serverId);
  if (!server) {
    return;
  }

  setStatus(serverId, 'checking', '连接检测中');
  if (rerender) {
    renderAll();
  } else {
    renderServerList();
  }

  try {
    const response = await fetch(`/api/servers/${encodeURIComponent(server.id)}/test-connection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeout_seconds: 25 }),
    });

    const data = await response.json();
    if (response.ok && data.success) {
      setStatus(serverId, 'online', data.message || 'SSH 连接成功', {
        failCount: 0,
        lastSuccessAt: new Date().toISOString(),
      });
      await fetchServerStats(serverId, { silent: true, rerender: false });
      if (!silent) {
        logMessage(`${server.name}: ${data.message || 'SSH 连接成功'}`);
      }
    } else {
      const previous = getStatus(serverId);
      const failCount = (previous.failCount ?? 0) + 1;
      if (silent && previous.state === 'online' && failCount < 3) {
        setStatus(serverId, 'unstable', data.message || 'SSH 连接不稳定', {
          failCount,
          lastSuccessAt: previous.lastSuccessAt ?? null,
        });
      } else {
        setStatus(serverId, 'offline', data.message || 'SSH 连接失败', {
          failCount,
          lastSuccessAt: previous.lastSuccessAt ?? null,
        });
      }
      if (!silent) {
        logMessage(`${server.name}: ${data.message || 'SSH 连接失败'}`, 'error');
      }
    }
  } catch (error) {
    const previous = getStatus(serverId);
    const failCount = (previous.failCount ?? 0) + 1;
    if (silent && previous.state === 'online' && failCount < 3) {
      setStatus(serverId, 'unstable', error.message || '连接请求不稳定', {
        failCount,
        lastSuccessAt: previous.lastSuccessAt ?? null,
      });
    } else {
      setStatus(serverId, 'offline', error.message || '连接请求失败', {
        failCount,
        lastSuccessAt: previous.lastSuccessAt ?? null,
      });
    }
    if (!silent) {
      logMessage(`${server.name}: ${error.message || '连接请求失败'}`, 'error');
    }
  }

  if (rerender) {
    renderAll();
  } else {
    renderServerList();
  }
}

// shouldAvoidContentRerender：负责当前模块对应的状态、渲染或事件逻辑。
function shouldAvoidContentRerender() {
  const activeElement = document.activeElement;
  if (!activeElement) {
    return false;
  }
  if (!dom.contentBody.contains(activeElement)) {
    return false;
  }
  return activeElement.matches('input, textarea, select');
}

// appendStatsSample：负责当前模块对应的状态、渲染或事件逻辑。
function appendStatsSample(serverId, statsData) {
  const history = getStatsHistory(serverId);
  const sampledAtMs = Date.parse(statsData.sampled_at || '') || Date.now();
  const prev = history.length > 0 ? history[history.length - 1] : null;

  let netRxKiBS = 0;
  let netTxKiBS = 0;
  if (prev) {
    const deltaSeconds = (sampledAtMs - prev.sampledAtMs) / 1000;
    if (deltaSeconds > 0) {
      netRxKiBS = Math.max((statsData.net_rx_bytes - prev.net_rx_bytes) / deltaSeconds / 1024, 0);
      netTxKiBS = Math.max((statsData.net_tx_bytes - prev.net_tx_bytes) / deltaSeconds / 1024, 0);
    }
  }

  const sample = {
    ...statsData,
    sampledAtMs,
    net_rx_kib_s: netRxKiBS,
    net_tx_kib_s: netTxKiBS,
  };
  history.push(sample);
  if (history.length > STATS_HISTORY_LIMIT) {
    history.splice(0, history.length - STATS_HISTORY_LIMIT);
  }
  state.serverStats[serverId] = sample;
  persistStatsCache();
}

// fetchServerStats：负责当前模块对应的状态、渲染或事件逻辑。
async function fetchServerStats(serverId, { silent = true, rerender = false } = {}) {
  const server = getServerById(serverId);
  if (!server) {
    return;
  }

  try {
    const response = await fetch(
      `/api/servers/${encodeURIComponent(server.id)}/stats?timeout_seconds=8`,
    );
    const data = await response.json();
    if (response.ok && data.success && data.data) {
      appendStatsSample(serverId, data.data);
      if (!silent) {
        logMessage(`${server.name}: 监控采集成功`);
      }
      if (
        rerender &&
        state.currentView.type === 'server' &&
        state.currentView.serverId === serverId &&
        !shouldAvoidContentRerender()
      ) {
        renderContent();
      }
      return;
    }
    if (!silent) {
      logMessage(`${server.name}: ${data.message || '监控采集失败'}`, 'error');
    }
  } catch (error) {
    if (!silent) {
      logMessage(`${server.name}: ${error.message || '监控采集失败'}`, 'error');
    }
  }
}

// refreshAllConnectionStatuses：负责当前模块对应的状态、渲染或事件逻辑。
async function refreshAllConnectionStatuses() {
  if (state.pollingRunning) {
    return;
  }
  if (state.config.servers.length === 0) {
    return;
  }

  state.pollingRunning = true;
  try {
    for (const server of state.config.servers) {
      await testConnection(server.id, true, false);
    }
    renderAll();
  } finally {
    state.pollingRunning = false;
  }
}

// refreshAllServerStats：负责当前模块对应的状态、渲染或事件逻辑。
async function refreshAllServerStats() {
  if (state.statsPollingRunning) {
    return;
  }
  if (state.config.servers.length === 0) {
    return;
  }

  state.statsPollingRunning = true;
  try {
    for (const server of state.config.servers) {
      const status = getStatus(server.id);
      if (status.state !== 'online' && status.state !== 'unstable') {
        continue;
      }
      await fetchServerStats(server.id, { silent: true, rerender: false });
    }
    if (
      state.currentView.type === 'server' &&
      state.currentView.serverId &&
      !shouldAvoidContentRerender()
    ) {
      renderContent();
    }
  } finally {
    state.statsPollingRunning = false;
  }
}

// startStatusPolling：负责当前模块对应的状态、渲染或事件逻辑。
function startStatusPolling() {
  if (state.pollingTimer) {
    clearInterval(state.pollingTimer);
  }
  state.pollingTimer = window.setInterval(() => {
    refreshAllConnectionStatuses().catch((error) => {
      logMessage(`定时连接检测失败: ${error.message}`, 'error');
    });
  }, POLL_INTERVAL_MS);
}

// startStatsPolling：负责当前模块对应的状态、渲染或事件逻辑。
function startStatsPolling() {
  if (state.statsPollingTimer) {
    clearInterval(state.statsPollingTimer);
  }
  state.statsPollingTimer = window.setInterval(() => {
    refreshAllServerStats().catch((error) => {
      logMessage(`定时监控采集失败: ${error.message}`, 'error');
    });
  }, STATS_POLL_INTERVAL_MS);
}

// shouldRenderActiveProject：负责当前模块对应的状态、渲染或事件逻辑。
function shouldRenderActiveProject(projectId) {
  return state.currentView.type === 'project' && state.currentView.projectId === projectId;
}

// renderProjectIfActive：负责当前模块对应的状态、渲染或事件逻辑。
function renderProjectIfActive(projectId) {
  if (shouldRenderActiveProject(projectId)) {
    renderContent();
  }
}

// logScriptStreamChunk：负责当前模块对应的状态、渲染或事件逻辑。
function logScriptStreamChunk(projectName, scriptName, stream, text) {
  const chunk = String(text ?? '');
  if (!chunk.trim()) {
    return;
  }
  const level = stream === 'stderr' ? 'error' : 'info';
  logMessage(`[${projectName}/${scriptName}] ${stream}:\n${chunk}`, level);
}

// handleScriptStreamEvent：负责当前模块对应的状态、渲染或事件逻辑。
function handleScriptStreamEvent(server, project, script, event) {
  if (event.type === 'state') {
    if (event.message) {
      logMessage(`${project.name}/${script.name}: ${event.message}`);
    }
    return { done: false, success: null };
  }

  if (event.type === 'stdout' || event.type === 'stderr') {
    logScriptStreamChunk(project.name, script.name, event.type, event.text ?? '');
    return { done: false, success: null };
  }

  if (event.type === 'done') {
    const success = Boolean(event.success);
    const exitCode = Number.isFinite(Number(event.exit_code)) ? Number(event.exit_code) : null;
    const runtime = finalizeScriptRuntime(
      project,
      script,
      success ? 'success' : 'failed',
      event.message || (success ? '执行成功' : '执行失败'),
      exitCode,
    );
    renderProjectIfActive(project.id);
    logMessage(
      `${project.name}/${script.name}: ${event.message || (success ? '执行成功' : '执行失败')} (exit ${event.exit_code ?? 'N/A'}, duration ${formatDuration(runtime.durationMs)})`,
      success ? 'info' : 'error',
    );
    return { done: true, success };
  }

  return { done: false, success: null };
}

// runScript：负责当前模块对应的状态、渲染或事件逻辑。
async function runScript(serverId, projectId, scriptId) {
  const server = getServerById(serverId);
  if (!server) {
    return false;
  }
  const project = getProjectById(server, projectId);
  if (!project) {
    return false;
  }
  const script = project.scripts.find((item) => item.id === scriptId);
  if (!script) {
    return false;
  }

  const existingRuntime = getScriptRuntime(projectId, scriptId);
  if (existingRuntime?.status === 'running') {
    logMessage(`${project.name}/${script.name}: 已在执行中。`);
    return false;
  }

  setScriptRuntime(projectId, scriptId, {
    status: 'running',
    message: '执行中',
    startedAt: new Date().toISOString(),
  });
  const startedAt = getScriptRuntime(projectId, scriptId)?.startedAt ?? new Date().toISOString();
  const historyEntryId = addProjectScriptHistoryEntry(server, project, script, startedAt);
  setScriptRuntime(projectId, scriptId, {
    ...getScriptRuntime(projectId, scriptId),
    historyEntryId,
    startedAt,
  });
  setConsoleCollapsed(false);
  renderProjectIfActive(projectId);
  logMessage(`${project.name}/${script.name}: 开始执行。`);

  let completed = false;
  let finalSuccess = false;
  try {
    const response = await fetch(
      `/api/servers/${encodeURIComponent(serverId)}/projects/${encodeURIComponent(projectId)}/scripts/${encodeURIComponent(scriptId)}/run-stream`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeout_seconds: 1800 }),
      },
    );

    if (!response.ok || !response.body) {
      const detail = await response.text();
      throw new Error(detail || '执行请求失败');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          try {
            const event = JSON.parse(line);
            const result = handleScriptStreamEvent(server, project, script, event);
            if (result.done) {
              completed = true;
              finalSuccess = Boolean(result.success);
            }
          } catch (error) {
            logMessage(`${project.name}/${script.name}: 日志解析失败 ${error.message}`, 'error');
          }
        }
        newlineIndex = buffer.indexOf('\n');
      }
    }

    const remaining = `${buffer}${decoder.decode()}`.trim();
    if (remaining) {
      try {
        const event = JSON.parse(remaining);
        const result = handleScriptStreamEvent(server, project, script, event);
        if (result.done) {
          completed = true;
          finalSuccess = Boolean(result.success);
        }
      } catch (error) {
        logMessage(`${project.name}/${script.name}: 日志解析失败 ${error.message}`, 'error');
      }
    }
  } catch (error) {
    finalizeScriptRuntime(project, script, 'failed', `执行请求失败: ${error.message}`, null);
    renderProjectIfActive(projectId);
    logMessage(`${project.name}/${script.name}: 执行请求失败: ${error.message}`, 'error');
  } finally {
    const runtime = getScriptRuntime(projectId, scriptId);
    if (!completed && runtime?.status === 'running') {
      const finalRuntime = finalizeScriptRuntime(
        project,
        script,
        'failed',
        '执行中断（未收到完成事件）',
        null,
      );
      logMessage(
        `${project.name}/${script.name}: 执行中断 (duration ${formatDuration(finalRuntime.durationMs)})。`,
        'error',
      );
    }
    renderProjectIfActive(projectId);
  }

  return finalSuccess;
}

// runAllScripts：负责当前模块对应的状态、渲染或事件逻辑。
async function runAllScripts(server, project) {
  if (project.scripts.length === 0) {
    logMessage(`${project.name}: 没有可执行脚本。`, 'error');
    return;
  }
  logMessage(`${project.name}: 开始批量执行 ${project.scripts.length} 个脚本。`);
  for (const script of project.scripts) {
    logMessage(`${project.name}: 执行 ${script.name}`);
    await runScript(server.id, project.id, script.id);
  }
  logMessage(`${project.name}: 批量执行完成。`);
}

// 使用统一入口保存配置，供按钮与快捷键复用。
async function persistCurrentConfig() {
  try {
    await saveConfig();
    logMessage('配置保存成功。');
  } catch (error) {
    logMessage(error.message, 'error');
  }
}

// bindSidebarEvents：负责当前模块对应的状态、渲染或事件逻辑。
function bindSidebarEvents() {
  dom.serverList.addEventListener('click', async (event) => {
    const actionTarget = event.target.closest('[data-action]');
    if (!actionTarget) {
      return;
    }

    const action = actionTarget.dataset.action;
    const serverId = actionTarget.dataset.serverId;
    const projectId = actionTarget.dataset.projectId;

    if (!action || !serverId) {
      return;
    }

    if (action === 'toggle-server-menu') {
      state.openServerMenuId = state.openServerMenuId === serverId ? null : serverId;
      renderServerList();
      return;
    }

    const server = getServerById(serverId);
    if (!server) {
      return;
    }

    if (action === 'open-server') {
      state.layoutTab = 'servers';
      state.currentView = { type: 'server', serverId, projectId: null };
      state.openServerMenuId = null;
      renderAll();
      const status = getStatus(serverId);
      if ((status.state === 'online' || status.state === 'unstable') && !getStatsSnapshot(serverId)) {
        fetchServerStats(serverId, { silent: true, rerender: true }).catch(() => {});
      }
      return;
    }

    if (action === 'add-project') {
      const newProject = {
        id: generateId('project'),
        name: `project-${server.projects.length + 1}`,
        path: '/srv/app',
        description: '',
        scripts: [],
      };
      server.projects.push(newProject);
      clearScriptCollapseForProject(newProject);
      state.layoutTab = 'projects';
      state.currentView = { type: 'project', serverId, projectId: newProject.id };
      state.openServerMenuId = null;
      renderAll();
      logMessage(`${server.name}: 新增项目 ${newProject.name}`);
      return;
    }

    if (action === 'test-server') {
      state.openServerMenuId = null;
      await testConnection(serverId, false, true);
      return;
    }

    if (action === 'delete-server') {
      if (!window.confirm(`确定删除服务器 ${server.name} 吗？`)) {
        return;
      }
      for (const project of server.projects) {
        clearScriptCollapseForProject(project);
        clearScriptRuntimeForProject(project);
        resetProjectScriptHistory(project.id);
      }
      state.config.servers = state.config.servers.filter((item) => item.id !== serverId);
      state.openServerMenuId = null;
      delete state.connectionStatus[serverId];
      delete state.passwordVisible[serverId];
      resetServerStatsCache(serverId);
      if (state.noteModalServerId === serverId) {
        closeNoteModal();
      }
      ensureViewSelection();
      renderAll();
      logMessage(`已删除服务器 ${server.name}`);
      return;
    }

    if (action === 'open-project') {
      if (!projectId) {
        return;
      }
      const targetProject = getProjectById(server, projectId);
      if (targetProject) {
        clearScriptCollapseForProject(targetProject);
      }
      if (state.layoutTab !== 'activity') {
        state.layoutTab = 'projects';
      }
      state.openServerMenuId = null;
      state.currentView = { type: 'project', serverId, projectId };
      renderAll();
      return;
    }

    if (action === 'delete-project') {
      if (!projectId) {
        return;
      }
      const project = getProjectById(server, projectId);
      if (!project) {
        return;
      }
      if (!window.confirm(`确定删除项目 ${project.name} 吗？`)) {
        return;
      }
      clearScriptCollapseForProject(project);
      clearScriptRuntimeForProject(project);
      resetProjectScriptHistory(project.id);
      server.projects = server.projects.filter((item) => item.id !== projectId);
      if (state.currentView.projectId === projectId) {
        const nextProject = server.projects[0] ?? null;
        if (nextProject && state.layoutTab !== 'servers') {
          state.currentView = { type: 'project', serverId, projectId: nextProject.id };
        } else {
          state.layoutTab = 'servers';
          state.currentView = { type: 'server', serverId, projectId: null };
        }
      }
      state.openServerMenuId = null;
      renderAll();
      logMessage(`${server.name}: 已删除项目 ${project.name}`);
    }
  });

  document.addEventListener('click', (event) => {
    if (state.openServerMenuId === null) {
      return;
    }
    if (event.target.closest('.server-menu')) {
      return;
    }
    state.openServerMenuId = null;
    renderServerList();
  });
}

// bindContentEvents：负责当前模块对应的状态、渲染或事件逻辑。
function bindContentEvents() {
  dom.contentBody.addEventListener('input', (event) => {
    const inputTarget = event.target;
    const server = getActiveServer();
    if (!server) {
      return;
    }

    if (inputTarget.classList.contains('server-field')) {
      const field = inputTarget.dataset.field;
      if (!field) {
        return;
      }
      server[field] = field === 'port' ? Number(inputTarget.value || 22) : inputTarget.value;
      if (field === 'name' || field === 'host' || field === 'username' || field === 'port' || field === 'location') {
        renderServerList();
        refreshContentHeaderOnly();
      }
      return;
    }

    if (inputTarget.classList.contains('server-auth-field')) {
      const field = inputTarget.dataset.field;
      if (!field) {
        return;
      }
      server.auth[field] = inputTarget.value;
      if (field === 'auth_type') {
        if (inputTarget.value === 'key') {
          server.auth.password = '';
          server.auth.key_path = server.auth.key_path || '~/.ssh/id_rsa';
          server.auth.passphrase = server.auth.passphrase || '';
        } else {
          server.auth.key_path = '';
          server.auth.passphrase = '';
        }
        renderContent();
      }
      return;
    }

    if (inputTarget.classList.contains('project-field')) {
      const projectId = inputTarget.dataset.projectId;
      const field = inputTarget.dataset.field;
      if (!projectId || !field) {
        return;
      }
      const project = getProjectById(server, projectId);
      if (!project) {
        return;
      }
      project[field] = inputTarget.value;
      if (field === 'name') {
        renderServerList();
        refreshContentHeaderOnly();
      }
      return;
    }

    if (inputTarget.classList.contains('script-field')) {
      const projectId = inputTarget.dataset.projectId;
      const scriptId = inputTarget.dataset.scriptId;
      const field = inputTarget.dataset.field;
      if (!projectId || !scriptId || !field) {
        return;
      }
      const project = getProjectById(server, projectId);
      if (!project) {
        return;
      }
      const script = project.scripts.find((item) => item.id === scriptId);
      if (!script) {
        return;
      }
      script[field] = inputTarget.value;
    }
  });

  dom.contentBody.addEventListener('click', async (event) => {
    const actionTarget = event.target.closest('[data-action]');
    if (!actionTarget) {
      return;
    }

    const action = actionTarget.dataset.action;
    const server = getActiveServer();
    if (!action || !server) {
      return;
    }

    if (action === 'toggle-password') {
      state.passwordVisible[server.id] = !state.passwordVisible[server.id];
      renderContent();
      return;
    }

    if (action === 'refresh-stats') {
      await fetchServerStats(server.id, { silent: false, rerender: true });
      return;
    }

    if (action === 'add-script') {
      const projectId = actionTarget.dataset.projectId;
      if (!projectId) {
        return;
      }
      const project = getProjectById(server, projectId);
      if (!project) {
        return;
      }
      const newScript = createDefaultScript(project);
      project.scripts.push(newScript);
      state.scriptCollapsed[getScriptCollapseKey(projectId, newScript.id)] = true;
      renderContent();
      return;
    }

    if (action === 'toggle-script-collapse') {
      const projectId = actionTarget.dataset.projectId;
      const scriptId = actionTarget.dataset.scriptId;
      if (!projectId || !scriptId) {
        return;
      }
      const key = getScriptCollapseKey(projectId, scriptId);
      state.scriptCollapsed[key] = !isScriptCollapsed(projectId, scriptId);
      renderContent();
      return;
    }

    if (action === 'collapse-all-scripts' || action === 'expand-all-scripts') {
      const projectId = actionTarget.dataset.projectId;
      if (!projectId) {
        return;
      }
      const project = getProjectById(server, projectId);
      if (!project) {
        return;
      }
      const nextCollapsed = action === 'collapse-all-scripts';
      for (const item of project.scripts) {
        const key = getScriptCollapseKey(projectId, item.id);
        state.scriptCollapsed[key] = nextCollapsed;
      }
      renderContent();
      return;
    }

    if (action === 'run-all-scripts') {
      const projectId = actionTarget.dataset.projectId;
      if (!projectId) {
        return;
      }
      const project = getProjectById(server, projectId);
      if (!project) {
        return;
      }
      await runAllScripts(server, project);
      return;
    }

    if (action === 'delete-script') {
      const projectId = actionTarget.dataset.projectId;
      const scriptId = actionTarget.dataset.scriptId;
      if (!projectId || !scriptId) {
        return;
      }
      const project = getProjectById(server, projectId);
      if (!project) {
        return;
      }
      const runtime = getScriptRuntime(projectId, scriptId);
      if (runtime?.status === 'running') {
        logMessage(`${project.name}: 脚本正在执行中，暂不允许删除。`, 'error');
        return;
      }
      delete state.scriptCollapsed[getScriptCollapseKey(projectId, scriptId)];
      clearScriptRuntime(projectId, scriptId);
      project.scripts = project.scripts.filter((item) => item.id !== scriptId);
      renderContent();
      return;
    }

    if (action === 'duplicate-script') {
      const projectId = actionTarget.dataset.projectId;
      const scriptId = actionTarget.dataset.scriptId;
      if (!projectId || !scriptId) {
        return;
      }
      const project = getProjectById(server, projectId);
      if (!project) {
        return;
      }
      const script = project.scripts.find((item) => item.id === scriptId);
      if (!script) {
        return;
      }
      const existingNames = new Set(project.scripts.map((item) => item.name.trim().toLowerCase()));
      let cloneName = `${script.name}-copy`;
      let suffix = 2;
      while (existingNames.has(cloneName.toLowerCase())) {
        cloneName = `${script.name}-copy-${suffix}`;
        suffix += 1;
      }
      project.scripts.push({
        id: generateId('script'),
        name: cloneName,
        runner: script.runner === 'local' ? 'local' : 'remote',
        command: script.command,
        working_dir: script.working_dir,
        args: script.args,
      });
      const clonedScript = project.scripts[project.scripts.length - 1];
      state.scriptCollapsed[getScriptCollapseKey(projectId, clonedScript.id)] = true;
      renderContent();
      return;
    }

    if (action === 'move-script-up' || action === 'move-script-down') {
      const projectId = actionTarget.dataset.projectId;
      const scriptId = actionTarget.dataset.scriptId;
      if (!projectId || !scriptId) {
        return;
      }
      const project = getProjectById(server, projectId);
      if (!project) {
        return;
      }
      const index = project.scripts.findIndex((item) => item.id === scriptId);
      if (index < 0) {
        return;
      }
      const targetIndex = action === 'move-script-up' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= project.scripts.length) {
        return;
      }
      const [moved] = project.scripts.splice(index, 1);
      project.scripts.splice(targetIndex, 0, moved);
      renderContent();
      return;
    }

    if (action === 'run-script') {
      const projectId = actionTarget.dataset.projectId;
      const scriptId = actionTarget.dataset.scriptId;
      if (!projectId || !scriptId) {
        return;
      }
      await runScript(server.id, projectId, scriptId);
    }
  });
}

// bindStaticEvents：负责当前模块对应的状态、渲染或事件逻辑。
function bindStaticEvents() {
  setConsoleCollapsed(state.consoleCollapsed);

  for (const tab of dom.workspaceTabs) {
    tab.addEventListener('click', () => {
      const layoutTab = tab.dataset.layoutTab;
      if (!layoutTab || layoutTab === state.layoutTab) {
        return;
      }
      setLayoutTab(layoutTab);
      renderAll();
    });
  }

  dom.addServerBtn.addEventListener('click', () => {
    const newServer = normalizeServer({
      id: generateId('server'),
      name: `server-${state.config.servers.length + 1}`,
      host: '127.0.0.1',
      port: 22,
      username: 'root',
      extra_ipv4: 'None',
      ram: '1 GB RAM (Included)',
      cpu_cores: '1 CPU Core (Included)',
      operating_system: 'Ubuntu 24.04 64 Bit',
      location: '',
      notes: '',
      tags: [],
      auth: {
        auth_type: 'key',
        password: '',
        key_path: '~/.ssh/id_rsa',
        passphrase: '',
      },
      projects: [],
    });

    state.config.servers.push(newServer);
    setStatus(newServer.id, 'unknown', '尚未检测');
    state.layoutTab = 'servers';
    state.currentView = { type: 'server', serverId: newServer.id, projectId: null };
    renderAll();
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    await persistCurrentConfig();
  });

  // 劫持 Cmd/Ctrl + S，改为保存当前配置，避免触发浏览器“保存网页”。
  document.addEventListener('keydown', async (event) => {
    if (event.isComposing || event.repeat || event.altKey) {
      return;
    }
    if (event.key === 'Escape' && state.noteModalOpen) {
      event.preventDefault();
      closeNoteModal();
      return;
    }
    const isSaveKey = event.key.toLowerCase() === 's';
    const hasCommandKey = event.metaKey || event.ctrlKey;
    if (!isSaveKey || !hasCommandKey) {
      return;
    }
    event.preventDefault();
    await persistCurrentConfig();
  });

  dom.contentTestBtn.addEventListener('click', async () => {
    const server = getActiveServer();
    if (!server) {
      logMessage('请先选择服务器。', 'error');
      return;
    }
    await testConnection(server.id, false, true);
  });

  dom.clearConsoleBtn.addEventListener('click', () => {
    dom.consoleOutput.textContent = '';
  });

  dom.toggleConsoleBtn.addEventListener('click', () => {
    setConsoleCollapsed(!state.consoleCollapsed);
  });

  const consoleHeader = dom.consolePanel.querySelector('.section-head');
  if (consoleHeader) {
    consoleHeader.addEventListener('click', (event) => {
      if (event.target instanceof HTMLElement && event.target.closest('button')) {
        return;
      }
      setConsoleCollapsed(!state.consoleCollapsed);
    });
  }

  dom.contentTitle.addEventListener('click', () => {
    openNoteModal();
  });

  dom.noteModalCloseBtn.addEventListener('click', () => {
    closeNoteModal();
  });

  dom.noteModalSaveBtn.addEventListener('click', () => {
    saveNoteModal();
  });

  dom.noteModal.addEventListener('click', (event) => {
    if (event.target === dom.noteModal) {
      closeNoteModal();
    }
  });
}

// boot：负责当前模块对应的状态、渲染或事件逻辑。
async function boot() {
  bindStaticEvents();
  bindSidebarEvents();
  bindContentEvents();

  try {
    await loadConfig();
    logMessage('配置加载完成。');
  } catch (error) {
    logMessage(error.message, 'error');
    return;
  }

  startStatusPolling();
  startStatsPolling();
  await refreshAllConnectionStatuses();
  await refreshAllServerStats();
}

boot();
