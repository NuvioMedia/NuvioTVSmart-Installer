const state = {
  os: null, // 'samsung' | 'lg' | 'multi'
  mode: null, // 'simple' | 'custom'
  view: 'os' // 'os' | 'mode' | 'installer'
};

// Elements
const views = {
  os: document.getElementById('view-os'),
  mode: document.getElementById('view-mode'),
  installer: document.getElementById('view-installer')
};

const navBack = document.getElementById('nav-back');
const osCards = document.querySelectorAll('#view-os .select-card');
const btnMultiOs = document.getElementById('btn-multi-os');
const modeCards = document.querySelectorAll('#view-mode .select-card');

// Installer Elements
const instTitle = document.getElementById('inst-title');
const instSubtitle = document.getElementById('inst-subtitle');
const instBadge = document.getElementById('inst-badge');
const lgFields = document.getElementById('lg-fields');
const customFields = document.getElementById('custom-fields');
const samsungCertOptions = document.getElementById('samsung-cert-options');
const autoGenerateCert = document.getElementById('autoGenerateCert');
const manualCertFields = document.getElementById('manual-cert-fields');
const osNotice = document.getElementById('os-notice');
const osNoticeText = document.getElementById('os-notice-text');
const btnBrowse = document.getElementById('btn-browse');
const btnBrowseAuthor = document.getElementById('btn-browse-author');
const btnBrowseDistributor = document.getElementById('btn-browse-distributor');
const btnInstall = document.getElementById('btn-install');
const btnCopyLog = document.getElementById('btn-copy-log');
const btnClearLog = document.getElementById('btn-clear-log');
const packagePathInput = document.getElementById('packagePath');
const authorCertPathInput = document.getElementById('authorCertPath');
const distributorCertPathInput = document.getElementById('distributorCertPath');
const certPasswordInput = document.getElementById('certPassword');
const certProfileNameInput = document.getElementById('certProfileName');
const logOutput = document.getElementById('log-output');
let localIps = [];
let showHostPcIp = false;
let actionInProgress = false;

async function loadLocalIps() {
  const config = await window.installer?.getConfig?.();
  localIps = config?.localIps || [];
  setupInstallerUI();
}

loadLocalIps();

// Navigation
function setView(newView) {
  Object.values(views).forEach(v => v.classList.remove('active'));
  views[newView].classList.add('active');
  state.view = newView;
  
  if (newView === 'os') {
    navBack.classList.add('hidden');
  } else {
    navBack.classList.remove('hidden');
  }
}

navBack.addEventListener('click', () => {
  if (state.view === 'installer') {
    if (state.os === 'multi') setView('os');
    else setView('mode');
  } else if (state.view === 'mode') {
    setView('os');
  }
});

// OS Selection
osCards.forEach(card => {
  card.addEventListener('click', () => {
    state.os = card.dataset.os;
    setView('mode');
  });
});

btnMultiOs.addEventListener('click', () => {
  state.os = 'multi';
  // If multi-os, maybe we just default to simple/custom mode and show a dropdown in the UI?
  // Let's go to mode selection, then in installer UI show a toggle.
  // Actually, let's keep it simple: go straight to installer, set mode custom?
  // User asked: "If you want to use more than one OS click this. Then once onboarding is done based on that it will show..."
  // For 'multi', we'll default to Custom mode and allow OS selection in the UI.
  state.mode = 'custom';
  setupInstallerUI();
  setView('installer');
});

// Mode Selection
modeCards.forEach(card => {
  card.addEventListener('click', () => {
    state.mode = card.dataset.mode;
    setupInstallerUI();
    setView('installer');
  });
});

function setupInstallerUI() {
  const isLg = state.os === 'lg';
  const isSamsung = state.os === 'samsung';
  const isMulti = state.os === 'multi';
  const isSimple = state.mode === 'simple';
  
  // Title / Subtitle
  if (isMulti) {
    instTitle.innerText = "Multi-OS Installation";
    instBadge.innerText = "CUSTOM";
  } else {
    instTitle.innerText = isSamsung ? "Samsung Tizen" : "LG WebOS";
    instBadge.innerText = isSimple ? "GITHUB" : "LOCAL";
  }
  
  instSubtitle.innerText = isSimple 
    ? "Automatically downloading latest release from GitHub."
    : "Using custom local package.";

  // Notice
  osNotice.style.display = 'block';
  
  const requiresSamsungSignIn = isSimple || autoGenerateCert.checked;
  const samsungDevModeNote = `For Tizen devices, ensure Developer Mode is enabled on your TV. While enabling Developer Mode, enter this computer's IP address as the Host PC IP.${renderHostPcIpToggle()}`;
  
  if (isMulti) {
    if (requiresSamsungSignIn) {
      osNoticeText.innerHTML = `<strong>Note:</strong> Provide the TV IP Address and the installer will attempt the chosen action. ${samsungDevModeNote} Samsung requires a Samsung account sign-in. LG requires a Developer Mode passphrase.`;
    } else {
      osNoticeText.innerHTML = `<strong>Note:</strong> Provide the TV IP Address and the installer will attempt the chosen action. ${samsungDevModeNote} LG requires a Developer Mode passphrase.`;
    }
  } else if (isSamsung) {
    if (requiresSamsungSignIn) {
      osNoticeText.innerHTML = `<strong>Note:</strong> ${samsungDevModeNote} You will also be prompted to sign in with your Samsung account during installation to automatically generate required developer certificates.`;
    } else {
      osNoticeText.innerHTML = `<strong>Note:</strong> ${samsungDevModeNote}`;
    }
  } else {
    osNoticeText.innerHTML = "<strong>Note:</strong> For WebOS devices, ensure Developer Mode is enabled and you have the Developer Mode Passphrase from the TV.";
  }

  // Fields
  lgFields.classList.toggle('hidden', isSamsung && !isMulti);
  customFields.classList.toggle('hidden', isSimple);
  
  // Custom Tizen options
  samsungCertOptions.classList.toggle('hidden', isSimple || !(isSamsung || isMulti));
}

function renderHostPcIpToggle() {
  const visibleIp = localIps.length ? localIps.join(' or ') : 'Unable to detect';
  const hiddenIp = localIps.length ? '*****' : 'Unable to detect';
  const eyeIcon = '<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"></path><circle cx="12" cy="12" r="3"></circle></svg>';

  return `<span class="host-ip-card"><span class="host-ip-label">Host PC IP:</span><span class="host-ip-value"><code>${showHostPcIp ? visibleIp : hiddenIp}</code><button type="button" class="ip-eye-button" id="btn-host-ip-eye" aria-label="${showHostPcIp ? 'Hide' : 'Show'} computer IP" aria-pressed="${showHostPcIp}">${eyeIcon}</button></span></span>`;
}

osNotice.addEventListener('click', (event) => {
  if (event.target?.id !== 'btn-host-ip-eye') return;
  showHostPcIp = !showHostPcIp;
  setupInstallerUI();
});

autoGenerateCert.addEventListener('change', (e) => {
  manualCertFields.classList.toggle('hidden', e.target.checked);
  setupInstallerUI();
});

btnBrowseAuthor.addEventListener('click', async () => {
  const file = await window.installer?.selectFile?.();
  if (file) authorCertPathInput.value = file;
});

btnBrowseDistributor.addEventListener('click', async () => {
  const file = await window.installer?.selectFile?.();
  if (file) distributorCertPathInput.value = file;
});

// Log formatting
function appendLog(text, type = 'info') {
  const div = document.createElement('div');
  div.className = `log-line log-${type}`;
  div.innerText = text;
  logOutput.appendChild(div);
  logOutput.scrollTop = logOutput.scrollHeight;
}

function setActionInProgress(inProgress, action = 'install') {
  actionInProgress = inProgress;
  btnInstall.disabled = inProgress;
  document.getElementById('btn-launch').disabled = inProgress;
  document.getElementById('btn-uninstall').disabled = inProgress;
  btnInstall.classList.toggle('is-loading', inProgress);
  btnInstall.setAttribute('aria-busy', String(inProgress));
  const loadingLabel = action === 'uninstall' ? 'Uninstalling...' : action === 'launch' ? 'Launching...' : 'Installing...';
  btnInstall.innerHTML = inProgress
    ? `<span class="button-spinner" aria-hidden="true"></span><span>${loadingLabel}</span>`
    : 'Install';
}

window.installer?.onLog((payload) => {
  let type = 'info';
  if (payload.type === 'error' || payload.type === 'stderr') type = 'error';
  if (payload.type === 'success') type = 'success';
  if (payload.type === 'command') type = 'command';
  appendLog(payload.text, type);
});

btnCopyLog.addEventListener('click', async () => {
  const logText = Array.from(logOutput.querySelectorAll('.log-line'))
    .map((line) => line.innerText)
    .join('\n');
  if (!logText.trim()) return;

  try {
    await window.installer?.copyText?.(logText);
  } catch (error) {
    appendLog(`Failed to copy installation log: ${error?.message || error}`, 'error');
    return;
  }

  const originalLabel = btnCopyLog.getAttribute('aria-label');
  btnCopyLog.classList.add('copied');
  btnCopyLog.setAttribute('aria-label', 'Log copied');
  btnCopyLog.setAttribute('title', 'Copied');
  setTimeout(() => {
    btnCopyLog.classList.remove('copied');
    btnCopyLog.setAttribute('aria-label', originalLabel || 'Copy installation log');
    btnCopyLog.setAttribute('title', 'Copy log');
  }, 1400);
});

btnClearLog.addEventListener('click', () => {
  logOutput.innerHTML = '<div class="log-line log-info">Log cleared.</div>';
});

// API interactions
btnBrowse?.addEventListener('click', async () => {
  if (window.installer?.selectFile) {
    const file = await window.installer.selectFile();
    if (file) packagePathInput.value = file;
  } else {
    // Mock for local dev
    packagePathInput.value = '/path/to/custom/app.wgt';
  }
});

async function runAction(action) {
  if (actionInProgress) {
    return;
  }

  const ip = document.getElementById('ip').value;
  const deviceName = document.getElementById('deviceName').value;
  const lgPassphrase = document.getElementById('lgPassphrase').value;
  const packagePath = packagePathInput.value;

  if (!ip) {
    appendLog("Error: TV IP Address is required.", "error");
    return;
  }

  // Determine target OS based on state or heuristics if multi
  let targetOs = state.os;
  if (targetOs === 'multi') {
    // Very simple heuristic: if passphrase is provided, assume LG
    targetOs = lgPassphrase ? 'lg' : 'samsung';
  }

  if (state.mode === 'custom' && action === 'install' && !packagePath) {
    appendLog("Error: Package file is required in Custom mode.", "error");
    return;
  }

  const options = {
    ip,
    mode: state.mode,
    deviceName,
    lgPassphrase,
    packagePath,
    samsungCert: {
      auto: autoGenerateCert.checked,
      authorPath: authorCertPathInput.value,
      distributorPath: distributorCertPathInput.value,
      password: certPasswordInput.value,
      profileName: certProfileNameInput.value
    }
  };

  if (window.installer?.run) {
    appendLog(`Starting ${action} on ${targetOs}...`, 'info');
    setActionInProgress(true, action);
    try {
      const res = await window.installer.run(targetOs, action, options);
      if (!res.ok) {
        appendLog(`Failed: ${res.error}`, 'error');
      }
    } finally {
      setActionInProgress(false);
    }
  } else {
    appendLog(`[MOCK] Running ${action} on ${targetOs} with IP ${ip}`, 'command');
  }
}

btnInstall.addEventListener('click', () => runAction('install'));
document.getElementById('btn-launch').addEventListener('click', () => runAction('launch'));
document.getElementById('btn-uninstall').addEventListener('click', () => runAction('uninstall'));
