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

**不是往 dshmarket 提 PR。** 市场实时读
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的产物；
那个仓库的**列表是数据驱动的**：`data/plugins/` 下**一个插件一个 yml**，
两份 README 由脚本生成 —— **改 README 会被 CI 直接判失败**（第一次就是这么被拒的）。

### 正确做法：只加一个文件

`data/plugins/<owner>__<repo>.yml`（注意是**两个下划线**）：

```yaml
url: https://github.com/Debuger-114514/dsh-bili-jar
name: Debuger-114514/dsh-bili-jar
category: fun          # 可选值：agi ui usage theme model identity session memory tools
                       # wsl browser vision voice docs skill workflow git notify dev
                       # security remote market fun
description:
  en: 'One line ending with a period. Quote it if it contains ": ".'
  zh: '中文一句，以句号结尾（选填，不写维护者会补）。'
```

- `url` 必须和仓库地址完全一致
- 只有 `description.en` 是必填
- **不要在 yml 里写 `npm:`**，npm 映射是自动采集的，手写会被拒
- 提 PR 时**只提交这一个文件**，README 由他们在 main 上重新生成

### 别做的事

- 不要手改 `README.md` / `README.zh.md`：CI 有一步「READMEs match data/plugins」，
  改了就红
- 不要贪快复制别人的条目再改名字：文件名和 yml 里的 `name` 都要对

### CI 大概跑多久

`pr-check.yml` 会装依赖、跑一堆结构检查、再重建整站，**十分钟上下**。
红了的注释会直接写在 Actions 页面上，通常能读出该改哪个文件。

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
