# v1.2.5 —— 补上 v1.2.4 漏掉的名册接线

**v1.2.4 有缺陷，请直接升到这一版。**

## 出了什么事

v1.2.4 的发布说明写着「名册读写统一走一层门面」。**门面的代码确实发布了，
但没有任何地方调用它**——`agent-provisioner.ts` 仍在直接操作 `agents.list`。

后果：**升级 OpenClaw 到 2026.8 之后，通过 ClawOPT 新建的 Agent 引擎看不见。**
它被写进 `agents.list`，而引擎读的是 `agents.entries`。
已有的 Agent 不受影响（`openclaw doctor` 已经把它们迁到 `entries` 了）。

另有一个副作用：ClawOPT 每次启动都会重建一个只含 `main` 的 `agents.list`，
在配置里留下一个与 `entries` 并存的废弃键。

## 为什么没被测试挡住

移植代码时 `git apply` 报告成功、退出码 0，实际没有写入。
而那条本该抓住它的端到端用例，住在**同一个被修改的文件**里——
补丁没落地，用例也就不存在了。**守卫和被守卫的代码一起消失，测试套件全绿。**

这一版因此加了一道住在**独立文件**里的机械守卫：它不断言行为，
只用最粗的方式断言接线本身存在（源码里不得有裸的 `agents.list` 操作）。
一个粗到不可能被误删的检查，胜过一个精确但会跟着代码一起消失的检查。

## 如果你已经装了 v1.2.4

升到这一版之后，检查一下配置里有没有多出来的 `agents.list`：

```bash
python3 -c "
import json; d = json.load(open('$HOME/.openclaw/openclaw.json'))
a = d['agents']
print('list:', a.get('list')); print('entries:', sorted(a.get('entries', {})))
"
```

若 `list` 里只有 `main`（或其它已经在 `entries` 里的 id），那是 v1.2.4 留下的
重复条目，跑一次 `openclaw doctor --fix` 即可清掉。
若 `list` 里有 **`entries` 中没有的 id**，那是 v1.2.4 期间新建、引擎看不见的 Agent——
同样跑一次 doctor 就会被迁进去。

## 验证

- `npm test`：**172 passed**（v1.2.4 为 158；新增的都是接线守卫与端到端用例）
- 接线守卫红证：把 `agent-provisioner.ts` 换回 v1.2.4 那一份，
  它逐行报出六处会在 2026.8 上静默失效的裸操作
- `npm run build`：退出码 0；`presets:check`：186 项一致；三语键集一致
