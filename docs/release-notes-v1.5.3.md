# v1.5.3 —— 部署脚本不再往 openclaw.json 写 2026.8 已废弃的键

升 v1.5.2 时看到的：

```
openclaw gateway restart --json failed: OpenClaw config is invalid
  - openclaw.json:133 — gateway.controlUi: Unrecognized key: "allowInsecureAuth"
  - gateway.controlUi.dangerouslyDisableDeviceAuth is retired and ignored
```

来源是 `backend/patch-config.js`：每次部署都把这两个键写回去。它们是 2026.7 之前
让浏览器控制台免设备配对的开关；v1.5.1 起 ClawOPT 以 backend 模式连网关，
根本不走那条路。现在有就删、不再加，并加了测试（先在旧脚本上跑红）。

这次是靠后续 reinstall 流程把配置修好才没出事，下次未必。
