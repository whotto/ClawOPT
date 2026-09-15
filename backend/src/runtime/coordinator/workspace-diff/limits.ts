/**
 * 工作区 diff 的上限（spec 01 §2.22）。全部集中在这里，用例按名字引用，改一个数不用满仓库找。
 *
 * 这些上限的用途是**让每次运行结束时的 diff 有界**：运行结束要等检查点完成才发终态，
 * 一个巨型仓库或一个几十 GB 的数据目录不能把「对话结束」拖成几分钟，也不能把内存吃满。
 */
export const WORKSPACE_DIFF_LIMITS = {
  /** git 工作区：`git status` 里最多认多少个脏路径。 */
  gitMaxDirtyPaths: 20_000,
  /** 单个文件快照的上限；更大的只记大小与修改时间（改了就报「改了」，不给 patch）。 */
  maxSnapshotBytes: 512 * 1024,
  /** 非 git 目录：扫描最多进多少个目录、多深、多久。 */
  scanMaxDirs: 5_000,
  scanMaxDepth: 16,
  scanBudgetMs: 1_000,
  /** 非 git 目录：扫描最多认多少个文件（目录少而单层文件极多时兜底）。 */
  scanMaxFiles: 20_000,
  /** 一次检查点里所有快照内容的总预算。 */
  snapshotBudgetBytes: 64 * 1024 * 1024,
  /** 单个文件 patch 上限、全部 patch 总上限、最多记多少个文件。 */
  maxPatchBytesPerFile: 256 * 1024,
  maxPatchBytesTotal: 1024 * 1024,
  maxFiles: 80,
  /** 完成阶段逐个比对文件的总时间预算（超出后剩下的文件不再比对，变更集标 truncated）。 */
  completeBudgetMs: 3_000,
  /** 单条 git 命令的超时。 */
  gitCommandTimeoutMs: 3_000,
  /** 完成阶段最多从 git 对象库取多少个「运行前版本」（运行中才变脏的文件）。 */
  maxGitBlobReads: 500,
  /** 行 diff 的编辑距离上限：超过就把中间段整体按「删 + 加」给出（结果仍然正确，只是不再最短）。 */
  maxDiffEditDistance: 2_000,
} as const;

export type WorkspaceDiffLimits = { -readonly [K in keyof typeof WORKSPACE_DIFF_LIMITS]: number };

/** 这些目录整棵不看：版本库、依赖、构建产物、缓存、虚拟环境、IDE 目录、凭据目录。 */
export const IGNORED_DIR_NAMES: ReadonlySet<string> = new Set([
  '.git', '.hg', '.svn', '.bzr',
  'node_modules', 'bower_components', '.pnpm-store', '.yarn',
  'dist', 'build', 'out', 'target', '.next', '.nuxt', '.svelte-kit', '.turbo', '.vercel', '.output',
  '.cache', '.parcel-cache', '.webpack', 'coverage', '.nyc_output', '.gradle', '.terraform',
  '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox', '.venv', 'venv', '.eggs',
  '.idea', '.vscode', '.vs',
  '.ssh', '.aws', '.gnupg',
]);

/** 二进制 / 媒体 / 压缩包：非 git 扫描直接跳过（git 工作区里照样报「改了」，按二进制处理）。 */
export const IGNORED_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tif', 'tiff', 'heic', 'psd',
  'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'mp4', 'mov', 'avi', 'mkv', 'webm',
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'war', 'dmg', 'iso',
  'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'o', 'a', 'obj', 'pyc', 'wasm',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'pdf', 'db', 'sqlite', 'sqlite3',
]);

export function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(index + 1).toLowerCase() : '';
}
