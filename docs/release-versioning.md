# 版本发布说明

## 唯一版本来源
- 唯一版本号来源是仓库根 `package.json` 的 `version`。
- 前后端显示、`/api/version`、构建产物元数据、Git tag、GitHub Release 都必须与这个值一致。
- `package-lock.json` 如果被 `npm version` 一并更新，属于派生文件；不要把它当作人工维护的版本真值源。

## 1. 修改版本号
在仓库根目录执行：

```bash
npm version 1.0.1 --no-git-tag-version
```

说明：
- 这会把根 `package.json` 更新到目标版本。
- 如果仓库里存在 `package-lock.json`，它可能会被同步改写；这是派生结果。
- 不要手写多个版本号，也不要分别在前端、后端再改一份。

## 2. 创建或推送 tag
只创建本地 tag：

```bash
npm run release:tag
```

创建并推送到 `origin`：

```bash
npm run release:publish
```

说明：
- tag 格式会自动按根版本号生成，例如 `v1.0.1`。
- 如果根 `package.json.version` 是 `1.0.1`，tag 也必须是 `v1.0.1`。

## 3. 发布 GitHub Release
先准备 `GITHUB_TOKEN` 或 `GH_TOKEN`，然后执行：

```bash
npm run release:sync
```

说明：
- 该命令会基于根版本号自动创建本地 tag、推送 tag，并创建或更新对应的 GitHub Release。
- Release 的 tag / name / version 会与根 `package.json.version` 对齐。
- 如需自定义发布说明，可设置 `GITHUB_RELEASE_NOTES_FILE=相对路径或绝对路径`。

## 4. 验证“关于系统”里的检查新版本
发布后至少验证一次“关于系统”页面：

1. 先确认当前实例的“当前版本”与根 `package.json.version` 一致。
2. 点击“检查新版本”。
3. 如果当前实例版本落后于 GitHub Release，按钮应显示：
   `发现新版本: x.y.z，点击进行更新`
4. 如果当前实例版本已与最新 Release 一致，按钮应显示：
   `当前已是最新版本，无需更新`
5. 如检查失败，按钮会显示重试文案，应先排查 GitHub Release / 网络 / token 配置。

## 5. 发布前最小检查
建议在根目录执行：

```bash
npm run test
npm run build
```

这样可以同时验证：
- 前后端类型检查通过
- 构建时会重新写入版本相关 build meta
