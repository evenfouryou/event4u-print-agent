const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');
const Store = require('electron-store');

const log = require('electron-log');
log.transports.file.resolvePathFn = () => path.join(app.getPath('userData'), 'event4u-print-agent.log');
log.transports.file.level = 'debug';
log.transports.console.level = 'debug';

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  log.info('Another instance is already running. Quitting...');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

log.info('='.repeat(60));
log.info('Event4U Print Agent starting at', new Date().toISOString());
log.info('App version:', app.getVersion());
log.info('Platform:', process.platform, process.arch);
log.info('='.repeat(60));

const store = new Store({
  defaults: {
    serverUrl: 'wss://manage.eventfouryou.com',
    companyId: '',
    authToken: '',
    printerName: '',
    autoConnect: true
  }
});

let mainWindow = null;
let relayWs = null;
let relayReconnectTimer = null;
let heartbeatTimer = null;
let agentId = null;

const HEARTBEAT_INTERVAL = 30000;
const RECONNECT_DELAY = 5000;

let currentStatus = {
  connected: false,
  printerReady: false,
  printerName: null,
  lastHeartbeat: null,
  pendingJobs: 0
};

let logBuffer = [];
const MAX_LOG_BUFFER = 200;

function addLog(level, message) {
  const entry = { timestamp: new Date().toISOString(), level, message };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift();
  if (mainWindow?.webContents) {
    mainWindow.webContents.send('log:entry', entry);
  }
}

const originalInfo = log.info.bind(log);
const originalWarn = log.warn.bind(log);
const originalError = log.error.bind(log);

log.info = (...args) => {
  originalInfo(...args);
  addLog('info', args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
};
log.warn = (...args) => {
  originalWarn(...args);
  addLog('warn', args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
};
log.error = (...args) => {
  originalError(...args);
  addLog('error', args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 700,
    minHeight: 500,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'icon.png'),
    title: 'Event4U Print Agent'
  });

  mainWindow.loadFile('index.html');
  
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function getDeviceName() {
  return os.hostname();
}

async function registerAgent() {
  const companyId = store.get('companyId');
  const printerName = store.get('printerName');
  
  if (!companyId) {
    log.warn('No company ID configured');
    return null;
  }

  const serverUrl = store.get('serverUrl').replace('wss://', 'https://').replace('ws://', 'http://');
  
  try {
    const response = await fetch(`${serverUrl}/api/printers/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        companyId,
        deviceName: getDeviceName(),
        printerName,
        capabilities: {
          thermalPrint: true,
          paperWidth: 80
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Registration failed: ${response.status}`);
    }

    const agent = await response.json();
    log.info('Agent registered:', agent.id);
    
    store.set('authToken', agent.authToken);
    agentId = agent.id;
    
    return agent;
  } catch (error) {
    log.error('Registration error:', error.message);
    return null;
  }
}

function connectToRelay() {
  const serverUrl = store.get('serverUrl');
  const authToken = store.get('authToken');
  const companyId = store.get('companyId');
  
  if (!companyId) {
    log.warn('Cannot connect: no company ID configured');
    updateStatus({ connected: false });
    return;
  }

  if (relayWs) {
    try { relayWs.close(); } catch (e) { }
    relayWs = null;
  }

  log.info('Connecting to relay server:', serverUrl);

  try {
    relayWs = new WebSocket(`${serverUrl}/ws/print-agent`);

    relayWs.on('open', () => {
      log.info('Connected to relay server');
      
      relayWs.send(JSON.stringify({
        type: 'auth',
        payload: {
          token: authToken,
          companyId,
          agentId,
          deviceName: getDeviceName()
        }
      }));

      updateStatus({ connected: true });
      startHeartbeat();
    });

    relayWs.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        handleRelayMessage(message);
      } catch (error) {
        log.error('Failed to parse relay message:', error.message);
      }
    });

    relayWs.on('close', () => {
      log.warn('Relay connection closed');
      updateStatus({ connected: false });
      stopHeartbeat();
      scheduleReconnect();
    });

    relayWs.on('error', (error) => {
      log.error('Relay connection error:', error.message);
      updateStatus({ connected: false });
    });
  } catch (error) {
    log.error('Failed to connect to relay:', error.message);
    scheduleReconnect();
  }
}

function handleRelayMessage(message) {
  log.info('Relay message:', message.type);

  switch (message.type) {
    case 'auth_success':
      log.info('Authentication successful');
      break;

    case 'auth_error':
      log.error('Authentication failed:', message.error);
      break;

    case 'print_job':
      handlePrintJob(message.payload);
      break;

    case 'ping':
      relayWs?.send(JSON.stringify({ type: 'pong' }));
      break;

    default:
      log.warn('Unknown message type:', message.type);
  }
}

async function handlePrintJob(job) {
  log.info('Received print job:', job.id);
  updateStatus({ pendingJobs: currentStatus.pendingJobs + 1 });

  try {
    sendJobStatus(job.id, 'printing');

    const result = await printTicket(job.payload);
    
    if (result.success) {
      sendJobStatus(job.id, 'completed');
      log.info('Print job completed:', job.id);
    } else {
      sendJobStatus(job.id, 'failed', result.error);
      log.error('Print job failed:', job.id, result.error);
    }
  } catch (error) {
    sendJobStatus(job.id, 'failed', error.message);
    log.error('Print job error:', error.message);
  }

  updateStatus({ pendingJobs: Math.max(0, currentStatus.pendingJobs - 1) });
}

async function printTicket(payload) {
  const printerName = store.get('printerName');
  
  if (!printerName) {
    return { success: false, error: 'No printer configured' };
  }

  log.info('Printing to:', printerName);
  log.info('Payload:', JSON.stringify(payload).substring(0, 200));

  await new Promise(resolve => setTimeout(resolve, 1000));

  return { success: true };
}

function sendJobStatus(jobId, status, errorMessage = null) {
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) return;

  relayWs.send(JSON.stringify({
    type: 'job_status',
    payload: {
      jobId,
      status,
      errorMessage
    }
  }));
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (relayWs?.readyState === WebSocket.OPEN) {
      relayWs.send(JSON.stringify({
        type: 'heartbeat',
        payload: {
          agentId,
          status: currentStatus.printerReady ? 'online' : 'error',
          printerName: currentStatus.printerName
        }
      }));
      updateStatus({ lastHeartbeat: new Date().toISOString() });
    }
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function scheduleReconnect() {
  if (relayReconnectTimer) return;
  
  log.info(`Reconnecting in ${RECONNECT_DELAY / 1000}s...`);
  relayReconnectTimer = setTimeout(() => {
    relayReconnectTimer = null;
    connectToRelay();
  }, RECONNECT_DELAY);
}

function updateStatus(updates) {
  Object.assign(currentStatus, updates);
  if (mainWindow?.webContents) {
    mainWindow.webContents.send('status:update', currentStatus);
  }
}

ipcMain.handle('get-config', () => {
  return {
    serverUrl: store.get('serverUrl'),
    companyId: store.get('companyId'),
    printerName: store.get('printerName'),
    autoConnect: store.get('autoConnect')
  };
});

ipcMain.handle('save-config', async (event, config) => {
  store.set('serverUrl', config.serverUrl);
  store.set('companyId', config.companyId);
  store.set('printerName', config.printerName);
  store.set('autoConnect', config.autoConnect);
  
  updateStatus({ printerName: config.printerName, printerReady: !!config.printerName });
  
  log.info('Configuration saved');
  return { success: true };
});

ipcMain.handle('get-status', () => currentStatus);

ipcMain.handle('get-logs', () => logBuffer);

ipcMain.handle('connect', async () => {
  const agent = await registerAgent();
  if (agent) {
    connectToRelay();
    return { success: true };
  }
  return { success: false, error: 'Registration failed' };
});

ipcMain.handle('disconnect', () => {
  if (relayWs) {
    relayWs.close();
    relayWs = null;
  }
  stopHeartbeat();
  updateStatus({ connected: false });
  return { success: true };
});

ipcMain.handle('test-print', async () => {
  const printerName = store.get('printerName');
  if (!printerName) {
    return { success: false, error: 'No printer configured' };
  }
  
  log.info('Test print requested');
  
  const result = await printTicket({
    type: 'test',
    text: 'Event4U Print Agent - Test\n\nPrinter: ' + printerName + '\nDate: ' + new Date().toLocaleString()
  });
  
  return result;
});

app.whenReady().then(async () => {
  createWindow();

  const config = store.store;
  updateStatus({
    printerName: config.printerName,
    printerReady: !!config.printerName
  });

  if (config.autoConnect && config.companyId) {
    log.info('Auto-connecting...');
    const agent = await registerAgent();
    if (agent) {
      connectToRelay();
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (relayWs) {
    relayWs.close();
  }
  stopHeartbeat();
});
