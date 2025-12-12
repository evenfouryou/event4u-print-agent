const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const WebSocket = require('ws');
const Store = require('electron-store');

const store = new Store();

// HARDCODED SERVER URL
const SERVER_URL = 'https://manage.eventfouryou.com';
const WS_URL = 'wss://manage.eventfouryou.com/ws/print-agent';
const API_URL = 'https://manage.eventfouryou.com/api/printers/agents/connect';

let mainWindow;
let tray;
let ws;
let reconnectTimer;
let isConnected = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 500,
    height: 600,
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: path.join(__dirname, 'icon.png')
  });

  mainWindow.loadFile('index.html');
  
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Apri', click: () => mainWindow.show() },
    { label: 'Stato', sublabel: isConnected ? 'Connesso' : 'Disconnesso' },
    { type: 'separator' },
    { label: 'Esci', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  
  tray.setToolTip('Event4U Print Agent');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => mainWindow.show());
}

async function connectToServer() {
  const token = store.get('token');
  
  if (!token) {
    sendToRenderer('log', 'Token mancante');
    sendToRenderer('status', 'disconnected');
    return;
  }

  sendToRenderer('log', 'Connessione in corso...');
  
  try {
    // First verify credentials via HTTP - only send token, server returns companyId
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Errore sconosciuto' }));
      sendToRenderer('log', `Errore autenticazione: ${error.error || response.status}`);
      sendToRenderer('status', 'error');
      return;
    }
    
    const data = await response.json();
    sendToRenderer('log', `Autenticato come: ${data.deviceName || data.agentId}`);
    store.set('agentId', data.agentId);
    store.set('companyId', data.companyId); // Store from server (trusted)
    
    // Now connect via WebSocket
    connectWebSocket(token, data.companyId, data.agentId);
    
  } catch (error) {
    sendToRenderer('log', `Errore connessione: ${error.message}`);
    sendToRenderer('status', 'error');
    scheduleReconnect();
  }
}

function connectWebSocket(token, companyId, agentId) {
  if (ws) {
    ws.close();
  }
  
  ws = new WebSocket(WS_URL);
  
  ws.on('open', () => {
    sendToRenderer('log', 'WebSocket connesso, autenticazione...');
    
    ws.send(JSON.stringify({
      type: 'auth',
      payload: {
        token,
        companyId,
        agentId,
        deviceName: store.get('deviceName') || 'Print Agent'
      }
    }));
  });
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      handleMessage(message);
    } catch (e) {
      sendToRenderer('log', `Errore parsing messaggio: ${e.message}`);
    }
  });
  
  ws.on('close', () => {
    sendToRenderer('log', 'WebSocket disconnesso');
    sendToRenderer('status', 'disconnected');
    isConnected = false;
    scheduleReconnect();
  });
  
  ws.on('error', (error) => {
    sendToRenderer('log', `Errore WebSocket: ${error.message}`);
    sendToRenderer('status', 'error');
  });
}

function handleMessage(message) {
  switch (message.type) {
    case 'auth_success':
      sendToRenderer('log', `Registrato! Agent ID: ${message.agentId}`);
      sendToRenderer('status', 'connected');
      isConnected = true;
      break;
      
    case 'auth_error':
      sendToRenderer('log', `Errore autenticazione: ${message.error}`);
      sendToRenderer('status', 'error');
      break;
      
    case 'print_job':
      sendToRenderer('log', `Lavoro di stampa ricevuto: ${message.payload?.id}`);
      handlePrintJob(message.payload);
      break;
      
    default:
      sendToRenderer('log', `Messaggio: ${message.type}`);
  }
}

async function handlePrintJob(job) {
  const printerName = store.get('printerName');
  
  if (!printerName) {
    sendToRenderer('log', 'Nessuna stampante configurata');
    sendJobStatus(job.id, 'error', 'Nessuna stampante configurata');
    return;
  }
  
  sendToRenderer('log', `Stampa su: ${printerName}`);
  
  try {
    // Get list of printers
    const printers = await mainWindow.webContents.getPrintersAsync();
    const printer = printers.find(p => p.name === printerName);
    
    if (!printer) {
      sendToRenderer('log', `Stampante non trovata: ${printerName}`);
      sendJobStatus(job.id, 'error', 'Stampante non trovata');
      return;
    }
    
    // For thermal printers, we need to handle the payload
    // This is a simplified version - actual implementation depends on printer type
    if (job.type === 'ticket' || job.type === 'test') {
      // Create a hidden window to print
      const printWindow = new BrowserWindow({ show: false });
      
      const htmlContent = generatePrintHtml(job);
      await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);
      
      printWindow.webContents.print({
        silent: true,
        deviceName: printerName,
        printBackground: true
      }, (success, errorType) => {
        printWindow.close();
        
        if (success) {
          sendToRenderer('log', 'Stampa completata');
          sendJobStatus(job.id, 'completed');
        } else {
          sendToRenderer('log', `Errore stampa: ${errorType}`);
          sendJobStatus(job.id, 'error', errorType);
        }
      });
    }
  } catch (error) {
    sendToRenderer('log', `Errore stampa: ${error.message}`);
    sendJobStatus(job.id, 'error', error.message);
  }
}

function generatePrintHtml(job) {
  if (job.type === 'test') {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: monospace; font-size: 12px; margin: 0; padding: 10px; }
          h1 { font-size: 14px; margin: 0 0 10px 0; }
        </style>
      </head>
      <body>
        <h1>Event4U Print Agent - Test</h1>
        <p>Stampante: ${store.get('printerName')}</p>
        <p>Data: ${new Date().toLocaleString('it-IT')}</p>
        <p>Status: OK</p>
      </body>
      </html>
    `;
  }
  
  // For tickets, use the template from the job payload
  return job.html || `<html><body><pre>${JSON.stringify(job, null, 2)}</pre></body></html>`;
}

function sendJobStatus(jobId, status, errorMessage) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'job_status',
      payload: { jobId, status, errorMessage }
    }));
  }
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  
  reconnectTimer = setTimeout(() => {
    sendToRenderer('log', 'Riconnessione...');
    connectToServer();
  }, 5000);
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// IPC handlers
ipcMain.handle('save-config', (event, config) => {
  store.set('token', config.token);
  store.set('deviceName', config.deviceName);
  store.set('printerName', config.printerName);
  sendToRenderer('log', 'Configurazione salvata');
  return true;
});

ipcMain.handle('get-config', () => {
  return {
    token: store.get('token') || '',
    deviceName: store.get('deviceName') || '',
    printerName: store.get('printerName') || '',
    serverUrl: SERVER_URL
  };
});

ipcMain.handle('connect', () => {
  connectToServer();
});

ipcMain.handle('disconnect', () => {
  if (ws) ws.close();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  sendToRenderer('status', 'disconnected');
});

ipcMain.handle('get-printers', async () => {
  const printers = await mainWindow.webContents.getPrintersAsync();
  return printers.map(p => ({ name: p.name, isDefault: p.isDefault }));
});

ipcMain.handle('test-print', async () => {
  const printerName = store.get('printerName');
  if (!printerName) {
    sendToRenderer('log', 'Seleziona una stampante');
    return false;
  }
  
  handlePrintJob({ type: 'test', id: 'test-' + Date.now() });
  return true;
});

app.whenReady().then(() => {
  createWindow();
  createTray();
  
  // Auto-connect if config exists
  const token = store.get('token');
  const companyId = store.get('companyId');
  if (token && companyId) {
    setTimeout(connectToServer, 1000);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  if (ws) ws.close();
  if (reconnectTimer) clearTimeout(reconnectTimer);
});
