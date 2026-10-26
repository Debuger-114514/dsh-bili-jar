/**
 * tools/make-test-build.mjs —— 从仓库产出一份「可并排安装」的测试插件
 * ============================================================================
 * 为什么要复制而不是软链：同一个插件装两份会撞车 ——
 *   路由前缀写死 /api/bili-jar、数据目录写死 ~/.dsh/bili-jar，
 *   第二份一启动就会去抢同一套接口和同一个池子。
 *
 * 所以测试包换一整套身份：id / 路由 / 数据目录 / 面板标题。
 * 两份可以同时跑，各用各的数据，互不影响。
 *
 * 用法：
 *   node tools/make-test-build.mjs              # 产出到 ..\电子榨菜罐-test
 *   node tools/make-test-build.mjs D:\other     # 指定目录
 *
 * 之后在 profile 里加：
 *   "dsh-bili-jar-test": "link:D:/电子榨菜罐-test"
 * 并把它加进 dsh.profile.bundles，然后 pnpm install + 重启 dsh。
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const TARGET = resolve(process.argv[2] || join(REPO, '..', '电子榨菜罐-test'))

const SRC_ID = 'dsh-bili-jar'
const TST_ID = 'dsh-bili-jar-test'

/** 把一份文本里的身份换掉：id / 路由前缀 / 数据目录 / 标题 */
function rebrand(text) {
  // 顺序要紧：先把 /api/bili-jar 换掉（它不含 dsh- 前缀，不会被下面的整体替换覆盖），
  // 再整体换 id，最后换数据目录与标题。都不做二次替换，避免出现 xxx-test-test。
  return text
    // 注意：不能叫 /api/bili-jar-test —— 路由是前缀匹配，
    // /api/bili-jar 会把 /api/bili-jar-test/xxx 也接走（剩下的 -test/xxx 就 404 了）。
    // 所以测试版用一条完全不相交的路径。
    .replaceAll('/api/bili-jar', '/api/bjtest')
    // 正则里是转义写法 \/api\/bili-jar，上面那条匹配不到，单独换
    .replaceAll(String.raw`\/api\/bili-jar`, String.raw`\/api\/bjtest`)
    .replaceAll(SRC_ID, TST_ID)
    .replaceAll("p('bili-jar')", "p('bili-jar-test')")
    .replaceAll("join(p, 'bili-jar')", "join(p, 'bili-jar-test')")
    // 兜底那行（没有 host 路径时）：join(homedir(), '.dsh'), 'bili-jar'
    .replaceAll("'.dsh'), 'bili-jar')", "'.dsh'), 'bili-jar-test')")
    .replaceAll("'电子榨菜罐'", "'电子榨菜罐·测试'")
}

function copyTree(from, to) {
  cpSync(from, to, {
    recursive: true,
    filter: (src) => !/[\\/](\.git|node_modules|__pycache__|out|\.tools)([\\/]|$)/.test(src),
  })
}

function walkFiles(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walkFiles(p, out)
    else out.push(p)
  }
  return out
}

console.log('仓库   :', REPO)
console.log('测试包 :', TARGET)

if (existsSync(TARGET)) {
  rmSync(TARGET, { recursive: true, force: true })
  console.log('（旧测试包已删除，重新生成）')
}
mkdirSync(TARGET, { recursive: true })

// 1. 代码 + 素材 + 补丁文件
for (const f of ['index.js', 'client.js', 'cordis.patch.yml', 'NOTICE', 'LICENSE', 'README.md']) {
  const p = join(REPO, f)
  if (existsSync(p)) writeFileSync(join(TARGET, f), rebrand(readFileSync(p, 'utf8')), 'utf8')
}
for (const d of ['lib', 'assets']) {
  copyTree(join(REPO, d), join(TARGET, d))
  for (const f of walkFiles(join(TARGET, d))) {
    if (/\.(mjs|js)$/.test(f)) writeFileSync(f, rebrand(readFileSync(f, 'utf8')), 'utf8')
  }
}

// 2. package.json：改名字、改版本号（一眼看出是测试包）
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
pkg.name = TST_ID
pkg.version = '0.0.0-test'
pkg.description = `【测试版】${pkg.description || ''}`
delete pkg.repository
delete pkg.homepage
delete pkg.bugs
pkg.files = ['index.js', 'client.js', 'cordis.patch.yml', 'lib', 'assets']
writeFileSync(join(TARGET, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8')

console.log('\n生成完成。接下来：')
console.log('  1. 关掉 dsh')
console.log(`  2. profile 的 package.json 里加："${TST_ID}": "link:${TARGET.replaceAll('\\', '/')}"`)
console.log('     并把它加进 dsh.profile.bundles')
console.log('  3. cd ~/.dsh/profiles/desktop && pnpm install')
console.log('  4. 重开 dsh —— 会出现第二个罐子，标题是「电子榨菜罐·测试」')
console.log('     它用的是独立的 ~/.dsh/bili-jar-test 目录，不碰正式那份数据')
