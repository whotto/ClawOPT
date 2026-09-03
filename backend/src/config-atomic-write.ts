/**
 * 原子地写 `~/.openclaw/openclaw.json`（以及同目录下的其它配置文件）。
 *
 * ## 为什么这个模块存在
 *
 * 全仓库原来有六处 `fs.writeFileSync(configPath, JSON.stringify(...))`。
 * `writeFileSync` **先把文件截断成 0 字节，再写内容**——这中间存在一个窗口，
 * 窗口里文件是空的。对抗测试实测：在 7 次写入过程中，一个并发的读者
 * **三次**观察到 `openclaw.json` 长度为 0。
 *
 * 后果不是「读到半截配置」这么轻。这是用户主机上**唯一一份** OpenClaw 配置：
 * 里面有 gateway 凭据、所有模型的 apiKey、全部 Agent 的定义。
 * 进程在那个窗口里被杀（OOM、`systemctl restart`、断电、`Restart=always` 的崩溃循环），
 * 用户就永久失去它，而 ClawOPT 没有为它做过任何备份。
 *
 * ## 为什么是「同目录临时文件 + rename」
 *
 * `rename(2)` 在同一个文件系统内是原子的：读者要么看到旧的完整内容，
 * 要么看到新的完整内容，**不存在第三种状态**。
 * 临时文件必须落在**同一个目录**，跨文件系统的 rename 会退化成拷贝，原子性就没了。
 *
 * `fsync` 在 rename 之前：不 fsync 的话，元数据可能先于数据落盘，
 * 断电后会得到一个长度正确但内容是零的文件——比截断窗口更难排查。
 *
 * ## 为什么保留权限位
 *
 * `openclaw.json` 常被设为 `600`。新建的临时文件默认是 `644`，
 * 直接 rename 过去会**悄悄放宽**这份含凭据文件的权限。
 */
import fs from 'fs';
import path from 'path';

/**
 * 原子写入。失败一律抛，**不做「最佳努力」**——写配置失败而调用方以为成功，
 * 正是本仓库红线 C 反对的形状。
 */
export function writeFileAtomicSync(targetPath: string, contents: string): void {
  // 符号链接要**穿透**，不能替换。
  //
  // `rename()` 替换的是路径本身：目标若是一条软链，rename 过去会把软链变成一个
  // 普通文件，链接关系**静默消失**。用户如果把 openclaw.json 软链到别处
  // （多机共享、或放在同步盘里），我们会在他毫不知情的情况下把那个安排拆掉——
  // 而且只有下次他去改「真正那份」时才会发现改动没生效。
  //
  // 解析到真实路径再写：软链保持是软链，被原子替换的是它指向的那个文件。
  // 目标不存在时 `realpathSync` 会抛，那属于正常情形（首次写入），沿用原路径。
  let resolvedTarget = targetPath;
  try {
    resolvedTarget = fs.realpathSync(targetPath);
  } catch {
    // 目标还不存在——首次写入，用原路径。这里不出声：它不是失败。
  }
  targetPath = resolvedTarget;

  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}`);

  // 目标已存在就沿用它的权限位；不存在则用 600——配置文件默认不该是世界可读的。
  let mode = 0o600;
  try {
    mode = fs.statSync(targetPath).mode & 0o777;
  } catch {
    // 目标不存在是正常情形（首次写入），用上面的默认值。
    // 这里不出声：它不是失败，是「还没有这个文件」。
  }

  let fd: number | undefined;
  try {
    fd = fs.openSync(tmpPath, 'w', mode);
    fs.writeFileSync(fd, contents, 'utf-8');
    // 数据必须先落盘，再 rename。顺序反了会在断电后留下一个长度对、内容为零的文件。
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(tmpPath, mode);
    fs.renameSync(tmpPath, targetPath);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (closeErr) { console.warn('[atomic-write] 关闭临时文件失败：', closeErr); }
    }
    try { fs.rmSync(tmpPath, { force: true }); } catch (rmErr) { console.warn('[atomic-write] 清理临时文件失败：', rmErr); }
    throw error;
  }
}

/** `JSON.stringify(value, null, 2)` + 原子写。全仓库写配置的统一入口。 */
export function writeJsonAtomicSync(targetPath: string, value: unknown): void {
  writeFileAtomicSync(targetPath, JSON.stringify(value, null, 2));
}
