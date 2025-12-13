const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const WebSocket = require('ws');
const Store = require('electron-store');

// Simple HTTP request function that works on all platforms
function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;
    
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };
    
    const req = lib.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: () => Promise.resolve(JSON.parse(data)),
          text: () => Promise.resolve(data)
        });
      });
    });
    
    req.on('error', reject);
    
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

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
  const authToken = store.get('authToken');
  
  log.info('=== REGISTER AGENT START ===');
  log.info('Token configured:', authToken ? `${authToken.substring(0, 8)}...${authToken.substring(authToken.length - 8)}` : 'NONE');
  log.info('Token length:', authToken ? authToken.length : 0);
  
  if (!authToken) {
    log.warn('No auth token configured - generate one from the web portal first');
    return null;
  }

  const rawServerUrl = store.get('serverUrl');
  const serverUrl = rawServerUrl.replace('wss://', 'https://').replace('ws://', 'http://');
  
  log.info('Raw server URL from config:', rawServerUrl);
  log.info('HTTP server URL:', serverUrl);
  
  const fullUrl = `${serverUrl}/api/printers/agents/connect`;
  log.info('Full request URL:', fullUrl);
  
  try {
    log.info('Making HTTP request...');
    const requestBody = JSON.stringify({ token: authToken });
    log.info('Request body:', requestBody);
    
    const response = await httpRequest(fullUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody
    });

    log.info('Response received - Status:', response.status, 'OK:', response.ok);
    
    const responseText = await response.text();
    log.info('Response body:', responseText);

    if (!response.ok) {
      let errorData = {};
      try {
        errorData = JSON.parse(responseText);
      } catch (e) {
        log.error('Failed to parse error response as JSON');
      }
      throw new Error(errorData.error || `Connection failed: ${response.status}`);
    }

    let agent;
    try {
      agent = JSON.parse(responseText);
    } catch (e) {
      log.error('Failed to parse success response as JSON:', e.message);
      throw new Error('Invalid JSON response from server');
    }
    
    log.info('Agent connected successfully!');
    log.info('Agent ID:', agent.agentId);
    log.info('Company ID:', agent.companyId);
    log.info('Device Name:', agent.deviceName);
    
    agentId = agent.agentId;
    store.set('companyId', agent.companyId);
    
    log.info('=== REGISTER AGENT SUCCESS ===');
    return agent;
  } catch (error) {
    log.error('=== REGISTER AGENT FAILED ===');
    log.error('Error type:', error.constructor.name);
    log.error('Error message:', error.message);
    log.error('Error stack:', error.stack);
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

    // job is the payload directly, not job.payload
    const result = await printTicket(job);
    
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
  log.info('Job type:', payload.type);
  log.info('Paper size:', payload.paperWidthMm + 'x' + payload.paperHeightMm + 'mm');

  // Create a hidden window for printing
  let printWindow = null;
  
  try {
    printWindow = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    // Build the HTML content
    let htmlContent;
    
    if (payload.type === 'ticket' && payload.html) {
      // Use pre-rendered HTML from server
      htmlContent = payload.html;
    } else if (payload.type === 'test') {
      // Generate test print HTML
      const widthMm = payload.paperWidthMm || 80;
      const heightMm = payload.paperHeightMm || 120;
      htmlContent = '<!DOCTYPE html>' +
        '<html><head><meta charset="utf-8">' +
        '<style>' +
        '@page { size: ' + widthMm + 'mm ' + heightMm + 'mm; margin: 0; }' +
        '* { margin: 0; padding: 0; box-sizing: border-box; }' +
        'body { ' +
        '  width: ' + widthMm + 'mm; ' +
        '  height: ' + heightMm + 'mm; ' +
        '  font-family: Arial, sans-serif; ' +
        '  padding: 5mm; ' +
        '  -webkit-print-color-adjust: exact; ' +
        '  print-color-adjust: exact; ' +
        '}' +
        '.border { ' +
        '  border: 1px dashed #333; ' +
        '  width: calc(100% - 4mm); ' +
        '  height: calc(100% - 4mm); ' +
        '  margin: 2mm; ' +
        '  padding: 3mm; ' +
        '}' +
        'h1 { font-size: 14px; margin-bottom: 5mm; }' +
        'p { font-size: 11px; margin-bottom: 2mm; }' +
        '</style></head><body>' +
        '<div class="border">' +
        '<h1>Event4U Print Agent v1.4</h1>' +
        '<p>Stampante: ' + printerName + '</p>' +
        '<p>Data: ' + new Date().toLocaleString('it-IT') + '</p>' +
        '<p>Dimensioni: ' + widthMm + 'mm x ' + heightMm + 'mm</p>' +
        '<p style="margin-top:5mm;">Se vedi questo bordo tratteggiato vicino ai margini del foglio, la stampa funziona correttamente!</p>' +
        '</div></body></html>';
    } else {
      return { success: false, error: 'Unknown print job type: ' + payload.type };
    }

    // Load HTML content
    await printWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlContent));
    
    // Wait for images/QR codes to load (increased for external QR service)
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Calculate page size in microns (mm * 1000)
    const widthMicrons = (payload.paperWidthMm || 80) * 1000;
    const heightMicrons = (payload.paperHeightMm || 120) * 1000;

    log.info('Page size in microns:', widthMicrons + 'x' + heightMicrons);

    // Print with exact settings
    return new Promise((resolve) => {
      printWindow.webContents.print({
        silent: true,
        deviceName: printerName,
        printBackground: true,
        margins: {
          marginType: 'none'
        },
        pageSize: {
          width: widthMicrons,
          height: heightMicrons
        },
        scaleFactor: 100
      }, (success, failureReason) => {
        if (printWindow) {
          printWindow.close();
          printWindow = null;
        }
        
        if (success) {
          log.info('Print completed successfully');
          resolve({ success: true });
        } else {
          log.error('Print failed:', failureReason);
          resolve({ success: false, error: failureReason || 'Print failed' });
        }
      });
    });

  } catch (error) {
    log.error('Print error:', error.message);
    if (printWindow) {
      try { printWindow.close(); } catch (e) { }
    }
    return { success: false, error: error.message };
  }
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
  store.set('authToken', config.authToken);
  store.set('printerName', config.printerName);
  store.set('autoConnect', config.autoConnect);
  
  log.info('Configuration saved - Token:', config.authToken ? 'SET' : 'EMPTY');
  
  updateStatus({ printerName: config.printerName, printerReady: !!config.printerName });
  
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
  
  log.info('Local test print requested');
  
  // Use the same printTicket function with test type
  const result = await printTicket({
    type: 'test',
    paperWidthMm: 80,
    paperHeightMm: 120
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
