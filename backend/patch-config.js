const fs = require('fs');
const os = require('os');
const path = require('path');

const openclawConfigPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');

if (!fs.existsSync(openclawConfigPath)) {
  console.log('No openclaw.json found. Skipping auth patch.');
  process.exit(0);
}

try {
  let config = JSON.parse(fs.readFileSync(openclawConfigPath, 'utf8'));

  if (!config.gateway) {
    config.gateway = {};
  }
  
  if (!config.gateway.controlUi) {
    config.gateway.controlUi = {};
  }

  let changed = false;
  // 这两个键是 2026.7 之前让浏览器控制台免设备配对的开关。2026.8 把
  // `dangerouslyDisableDeviceAuth` 标为 retired、`allowInsecureAuth` 直接判为
  // Unrecognized key——每次部署写回去，`openclaw gateway restart` 就报
  // 「config is invalid」。v1.5.1 起 ClawOPT 以 backend 模式连网关，
  // 根本不走控制台那条路，这两个键已经没有存在的理由：有就删，不再加。
  for (const retiredKey of ['dangerouslyDisableDeviceAuth', 'allowInsecureAuth']) {
    if (retiredKey in config.gateway.controlUi) {
      delete config.gateway.controlUi[retiredKey];
      changed = true;
    }
  }
  if (Object.keys(config.gateway.controlUi).length === 0) {
    delete config.gateway.controlUi;
  }

  // Ensure commands.bash is enabled (required by OpenClaw 2026.3.12+)
  if (!config.commands) config.commands = {};
  if (!config.commands.bash) {
    config.commands.bash = true;
    config.commands.restart = true;
    config.commands.native = 'auto';
    config.commands.nativeSkills = 'auto';
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(openclawConfigPath, JSON.stringify(config, null, 2));
    console.log('Patched openclaw.json: removed retired controlUi keys / ensured commands.*.');
  } else {
    console.log('openclaw.json already clean.');
  }
} catch (error) {
  console.error('Failed to patch openclaw.json:', error.message);
  process.exit(1);
}

// Also patch exec-approvals.json to disable exec approval prompts
const execApprovalsPath = path.join(os.homedir(), '.openclaw', 'exec-approvals.json');
if (fs.existsSync(execApprovalsPath)) {
  try {
    const approvals = JSON.parse(fs.readFileSync(execApprovalsPath, 'utf8'));
    let approvalChanged = false;
    if (!approvals.defaults) approvals.defaults = {};
    if (approvals.defaults.ask !== 'off') {
      approvals.defaults.ask = 'off';
      approvalChanged = true;
    }
    if (approvals.defaults.security !== 'full') {
      approvals.defaults.security = 'full';
      approvalChanged = true;
    }
    
    // Add explicitly wildcard allowlist to bypass the allowlist miss error
    if (!approvals.agents) {
      approvals.agents = { '*': { allowlist: [{ pattern: '*' }] } };
      approvalChanged = true;
    } else if (!approvals.agents['*'] || !approvals.agents['*'].allowlist) {
      approvals.agents['*'] = { allowlist: [{ pattern: '*' }] };
      approvalChanged = true;
    }

    if (approvalChanged) {
      fs.writeFileSync(execApprovalsPath, JSON.stringify(approvals, null, 2));
      console.log('Patched exec-approvals.json: set ask=off, security=full.');
    } else {
      console.log('exec-approvals.json already configured.');
    }
  } catch (e) {
    console.error('Failed to patch exec-approvals.json:', e.message);
  }
}
