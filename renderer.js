document.addEventListener('DOMContentLoaded', async () => {
  const tabs = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');
  const statusIndicator = document.getElementById('statusIndicator');
  
  const statusServer = document.getElementById('statusServer');
  const statusPrinter = document.getElementById('statusPrinter');
  const statusHeartbeat = document.getElementById('statusHeartbeat');
  const statusJobs = document.getElementById('statusJobs');
  
  const btnConnect = document.getElementById('btnConnect');
  const btnDisconnect = document.getElementById('btnDisconnect');
  const btnTestPrint = document.getElementById('btnTestPrint');
  
  const configForm = document.getElementById('configForm');
  const serverUrlInput = document.getElementById('serverUrl');
  const companyIdInput = document.getElementById('companyId');
  const printerNameInput = document.getElementById('printerName');
  const autoConnectInput = document.getElementById('autoConnect');
  
  const logContainer = document.getElementById('logContainer');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      tabContents.forEach(content => {
        content.classList.toggle('hidden', content.id !== `tab-${tab.dataset.tab}`);
      });
    });
  });

  async function loadConfig() {
    const config = await window.printAgent.getConfig();
    serverUrlInput.value = config.serverUrl || '';
    companyIdInput.value = config.companyId || '';
    printerNameInput.value = config.printerName || '';
    autoConnectInput.checked = config.autoConnect !== false;
  }

  function updateStatusUI(status) {
    if (status.connected) {
      statusIndicator.className = 'status-indicator connected';
      statusIndicator.querySelector('.status-text').textContent = 'Connesso';
      statusServer.textContent = 'Connesso';
      statusServer.style.color = '#10b981';
    } else {
      statusIndicator.className = 'status-indicator';
      statusIndicator.querySelector('.status-text').textContent = 'Disconnesso';
      statusServer.textContent = 'Disconnesso';
      statusServer.style.color = '#ef4444';
    }

    if (status.printerName) {
      statusPrinter.textContent = status.printerName;
      statusPrinter.style.color = status.printerReady ? '#10b981' : '#f59e0b';
    } else {
      statusPrinter.textContent = 'Non configurata';
      statusPrinter.style.color = '#a0a0a0';
    }

    if (status.lastHeartbeat) {
      statusHeartbeat.textContent = new Date(status.lastHeartbeat).toLocaleTimeString('it-IT');
    } else {
      statusHeartbeat.textContent = '-';
    }

    statusJobs.textContent = status.pendingJobs || 0;

    btnConnect.disabled = status.connected;
    btnDisconnect.disabled = !status.connected;
  }

  function addLogEntry(entry) {
    const emptyMsg = logContainer.querySelector('.log-empty');
    if (emptyMsg) emptyMsg.remove();

    const div = document.createElement('div');
    div.className = `log-entry ${entry.level}`;
    
    const time = new Date(entry.timestamp).toLocaleTimeString('it-IT');
    div.innerHTML = `<span class="log-timestamp">[${time}]</span>${escapeHtml(entry.message)}`;
    
    logContainer.appendChild(div);
    logContainer.scrollTop = logContainer.scrollHeight;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  async function loadLogs() {
    const logs = await window.printAgent.getLogs();
    logs.forEach(addLogEntry);
  }

  window.printAgent.onStatusUpdate(updateStatusUI);
  window.printAgent.onLogEntry(addLogEntry);

  btnConnect.addEventListener('click', async () => {
    btnConnect.disabled = true;
    btnConnect.textContent = 'Connessione...';
    
    const result = await window.printAgent.connect();
    
    if (!result.success) {
      alert('Connessione fallita: ' + (result.error || 'Errore sconosciuto'));
    }
    
    btnConnect.textContent = 'Connetti';
    const status = await window.printAgent.getStatus();
    updateStatusUI(status);
  });

  btnDisconnect.addEventListener('click', async () => {
    await window.printAgent.disconnect();
    const status = await window.printAgent.getStatus();
    updateStatusUI(status);
  });

  btnTestPrint.addEventListener('click', async () => {
    btnTestPrint.disabled = true;
    btnTestPrint.textContent = 'Stampa in corso...';
    
    const result = await window.printAgent.testPrint();
    
    if (result.success) {
      alert('Stampa di test completata!');
    } else {
      alert('Errore stampa: ' + (result.error || 'Errore sconosciuto'));
    }
    
    btnTestPrint.disabled = false;
    btnTestPrint.textContent = 'Stampa Test';
  });

  configForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const config = {
      serverUrl: serverUrlInput.value.trim(),
      companyId: companyIdInput.value.trim(),
      printerName: printerNameInput.value.trim(),
      autoConnect: autoConnectInput.checked
    };
    
    const result = await window.printAgent.saveConfig(config);
    
    if (result.success) {
      alert('Configurazione salvata!');
    }
    
    const status = await window.printAgent.getStatus();
    updateStatusUI(status);
  });

  await loadConfig();
  const initialStatus = await window.printAgent.getStatus();
  updateStatusUI(initialStatus);
  await loadLogs();
});
