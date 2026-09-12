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

// exec 审批**不在这里处理**。
//
// 这里原来每次部署都无条件写 ask='off' / security='full' / agents['*'] 通配
// allowlist，而后端在 setImmediate 里已经按「最高权限」开关收敛同一个文件
// （开着就放宽、关着就把这三个键删掉）。两个写入者朝相反方向写同一份文件。
//
// deploy-release.sh 的顺序让这件事变得具体：
//   patch-config（写成全开）→ restart-openclaw-runtime（**网关带着全开的审批重启**）
//   → service-restart（后端启动，收敛回去）
// 文件最终看起来是安全的，但网关是在全开的那一刻重启的；而且后端一旦启动失败，
// 收敛那一步压根不会跑。
//
// 判据只实现一次，就在后端那条跟随开关的路径上（index.ts 的 patchExecApprovals）。
