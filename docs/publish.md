# 发布到 npm / 上架插件市场

两条路是分开的：**npm 决定别人能不能一键装**，**awesome-dsh-plugin 决定它在市场里搜不搜得到**。
两者可以只做前者（GitHub 直装也能用），但要做进市场，通常两个都做。

---

## 一、npm

包名 `dsh-bili-jar` 目前**没人占**（`https://registry.npmjs.org/dsh-bili-jar` 返回 404）。

### 发布

**方式一：推 tag，GitHub Actions 自动发**（推荐，一次配好终身省事）

1. 在 npm 建一个 **Automation** token（classic 或 granular 都行，权限要 `read and write` 到包）
2. 仓库 → Settings → Secrets and variables → Actions → 新建 secret（名字 `NPM_TOKEN`；
   如果已经叫 `DEEPSEEK_ONLY` 也不用改，工作流两个名字都认）
3. 发版：

```bash
pnpm check                    # 自检：文件齐不齐、有没有 NUL、体积是否异常
npm version patch             # 或 minor / major，会自动打 tag
git push --follow-tags        # 推 tag → 触发 .github/workflows/publish.yml
```

工作流会先跑自检、核对 `package.json` 的版本号和 tag 是否一致，再 `npm publish --provenance`。

> ⚠️ 推 `.github/workflows/*.yml` 需要 token 带 `workflow` 权限。当前这台机器的 gh 登录没有这个 scope，
> 所以这个文件**还没进仓库**（在 `.gitignore` 里）。两个办法二选一：
> `gh auth refresh -s workflow` 之后重新提交，或者直接在 GitHub 网页上新建这个文件。
>
> <details><summary>工作流内容（点开复制）</summary>
>
> ```yaml
> # 推 v* tag 就发 npm —— 需要仓库里有一个能直接发布的 npm token
> #
> # 仓库里已有的 secret 名字叫 DEEPSEEK_ONLY，下面两个名字都认，
> # 所以不用改名（以后想规范就再加一个叫 NPM_TOKEN 的，优先用那个）。
> name: publish
>
> on:
>   push:
>     tags: ['v*']
>
> jobs:
>   npm:
>     runs-on: ubuntu-latest
>     permissions:
>       contents: read
>       id-token: write      # npm provenance
>     steps:
>       - uses: actions/checkout@v4
>       - uses: actions/setup-node@v4
>         with:
>           node-version: '22'
>           registry-url: 'https://registry.npmjs.org'
>       - name: 自检
>         run: node tools/pack-check.mjs
>       - name: 版本号和 tag 对得上吗
>         run: |
>           PKG=$(node -p "require('./package.json').version")
>           TAG=${GITHUB_REF_NAME#v}
>           if [ "$PKG" != "$TAG" ]; then echo "package.json 是 $PKG，tag 是 $TAG"; exit 1; fi
>       - name: 发布
>         run: npm publish --access public --provenance
>         env:
>           NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN || secrets.DEEPSEEK_ONLY }}
> ```
>
> </details>

**方式二：本地直接发**

```bash
npm login                      # 一次性，token 存 ~/.npmrc
pnpm check                     # 自检（prepublishOnly 也会再跑一次）
npm publish --access public
```

`package.json` 已经备好：`files` 白名单（`index.js` / `client.js` / `cordis.patch.yml` / `lib` /
`assets` / `README.md`）、`repository` / `homepage` / `bugs` / `publishConfig.access=public`。

打包结果约 **1.1 MB / 24 个文件**（插画占大头）。`art-source/`（豆包原图）被 `.gitignore` 挡在外面，不会进包。

### 发完别人怎么装

```bash
dsh plugin --profile web add dsh-bili-jar        # 从 npm 装
```

> 桌面版（`desktop` profile）由 Electron 独占，CLI 会拒绝，只能改 `~/.dsh/profiles/desktop/package.json`
> 再 `pnpm install`。这一条是 DSH 的限制，不是包的。

### 版本号规则

改了要发新版，先 `npm version patch|minor`（顺带打 git tag），再 `publish`。
npm 不允许覆盖已发布的版本号，忘了改会直接 403。

---

## 二、上架插件市场（dshmarket）

**不是往 dshmarket 提 PR。** dshmarket 只是"市场 App"，插件目录来自
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)；市场每次打开都实时读
`awesome-dsh-plugin.com/plugins.json`，所以那边合并了，这边（通常一天内）就自动出现。

### 步骤

1. **先把包发到 npm**（见上）。目录里带 npm 映射的条目才有一键安装按钮；只有 GitHub 链接的条目照样列出，但装起来要粘贴地址。
2. **fork 并改 `README.md`**：在合适的分类下加**一行**，格式严格照抄邻居：

   ```markdown
   - [Debuger-114514/dsh-bili-jar](https://github.com/Debuger-114514/dsh-bili-jar) - 一句话说明。
   ```

   分类选 **Just for Fun**（那一栏是桌宠、挂件、小游戏）。条目在该分类内按 `owner/repo` 字母序排，
   所以位置在 `Crosery/...` 与 `Devin-AXIS/...` 之间。

   备用的一句话（挑一个，别超长）：

   > - A jar in the corner of the DSH Web UI that picks what to watch on Bilibili: it searches your own interest axes instead of the platform's feed, ranks by like/coin/favourite rate instead of view count, and has an LLM curate five picks with content-based reasons.

3. **开 PR**，标题写 `Add dsh-bili-jar`。评审会**照着源码核对描述**（"46 tools" 就真的去数），
   所以那一行里别写没做的东西。评审标准：`contributing.md`。

### 被拒/被删的常见原因

- 装不上（`dsh plugin add` 失败）→ 先在干净 profile 上试一遍
- 描述和实际不符
- 仓库半年没动、或仓库没了

---

## 三、发版检查清单

```bash
pnpm pack && tar -tzf dsh-bili-jar-*.tgz | head -20   # 确认 cordis.patch.yml 在包里
npm version patch -m "v%s"
git push --follow-tags
npm publish --access public
```

发完顺手做三件事：

- `gh release create v0.1.0 --notes "..."` —— 不然仓库右侧 Releases 是空的
- 在 README 顶部补一行安装方式
- 市场那条 PR 只改一行，之后每次发版不用再动它
