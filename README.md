# Loop · 小猫听歌室

Loop 是一个联机听歌网页。取个昵称就能加入朋友的音乐客厅，化身小猫在房间里走动、发预设表情，或上台轮流分享网易云音乐。

- 在大厅按房间是否有人在线进行筛选，通过数字房号链接邀请朋友。
- 创建昵称时会自动获得一间自己的客厅。房主可更换环境、设置舞台座位数和管理成员。
- 搜索歌曲、网易云用户或歌单。每个账号自带 3 个歌单，每个最多 100 首，支持批量导入和拖动排序。当前选中的歌单用于下一轮舞台播放。
- 点击地面或用 WASD / 方向键移动。可以为小猫换毛色和花纹，也可以边听歌边看原文和译文歌词。

## 本地运行

需要 **Node.js 22.12 或更新版本**和 npm。使用 nvm 时，可在项目根目录运行 `nvm install`，按 `.nvmrc` 选择 Node.js 24。

在仓库根目录安装依赖并启动开发服务。

```sh
npm ci
cp .env.example .env
npm run dev
```

打开 [http://localhost:5173](http://localhost:5173)，取个昵称进入房间。从「我的歌单」找到并添加喜欢的歌曲，然后点击舞台上的加号。台上的小猫从左到右轮流播放。

用普通窗口和无痕窗口可以扮演两个独立的用户。同一浏览器中的普通标签页会共享身份。临时身份依赖浏览器的 Cookie，清除 Cookie 后会失去该身份的歌单和房间管理权限。

## 自托管

安装依赖并准备好 `.env` 后，在项目根目录运行以下命令。

```sh
npm run build
npm start
```

默认监听 `3000` 端口。用 HTTPS 部署时，在 `.env` 设置 `COOKIE_SECURE=true`，反向代理需透传原始 `Host` 并支持 Socket.IO 的 WebSocket 升级。

| 配置项           | 用途                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `HOST`、`PORT`   | 服务端监听地址和端口。开发模式下修改端口后，也要更新 `vite.config.ts` 中的代理地址。            |
| `DATABASE_PATH`  | SQLite 路径，默认为 `data/loop.sqlite`。空库首次启动时自动初始化。                              |
| `LOOP_ADMIN_KEY` | 可选的管理员密钥，至少 32 字符。可用 `openssl rand -hex 32` 生成。                              |
| `NETEASE_COOKIE` | 可选的服务端网易云登录凭证。用管理员页面扫码时，也可用 `NETEASE_COOKIE_FILE` 指定凭证文件路径。 |

设置管理员密钥后，可打开 `/admin/emotes` 管理预设表情，或打开 `/admin/netease` 进行网易云扫码登录。扫码凭证默认保存在 `data/netease-cookie`。把 `.env`、数据库和凭证放在私有存储，部署时持久化并备份 `data/`。

### 用 PM2 常驻运行

在服务器安装 PM2（`npm install -g pm2`）后，从项目根目录运行下面两条命令。

```sh
npm run build
pm2 start ecosystem.config.cjs
```

PM2 会启动一个名为 `loop` 的进程并读取项目的 `.env`。更新代码后，运行 `npm run build` 和 `pm2 reload loop`。页面在启动、回到前台、浏览器恢复联网和房间成功重连时检查版本，发现新构建后刷新一次。一直停在前台大厅时，下一次切回页面或手动刷新会载入新版本。仅重启同一份构建时，页面继续按原流程重连。反向代理需让 HTML 和 `/api/version` 的 `Cache-Control: no-store` 生效。

需要开机自动恢复时，运行 `pm2 startup` 并按它的提示设置系统服务，再运行 `pm2 save`。

### Cloudflare Tunnel 和注册防护

1. 已经用同机的 Tunnel 发布时，进入 Cloudflare 的 **Networking → Tunnels → 当前 Tunnel → Routes**，确认 LOOP 的公网域名对应的 **Service URL** 是 `http://127.0.0.1:3003`。服务器上将 LOOP 绑定到同一个回环地址，并确保云防火墙没有放行公网访问 LOOP 端口。Tunnel 继续使用公网原始 `Host`。 [Tunnel 路由说明](https://developers.cloudflare.com/tunnel/get-started/)
2. 在 Cloudflare 帐户的 **Turnstile → Add widget** 创建组件。名称可用 `LOOP Signup`，普通全球版选 **Rest of World**，模式选 **Managed**，Hostname 填玩家访问的完整域名，例如 `loop.example.com`。保持 Pre-clearance 关闭。创建后复制 Site key 和 Secret key。 [Turnstile 控制台说明](https://developers.cloudflare.com/turnstile/get-started/widget-management/dashboard/)
3. 在服务器项目目录的 `.env` 中加入以下配置，替换域名和两把 key。Secret key 只保存在服务端。两把 key 和 hostname 要一起配置。建号配额默认是每个 IP 滚动一小时成功创建 5 个账号，计数由当前服务进程保存。

   ```dotenv
   HOST=127.0.0.1
   PORT=3003
   COOKIE_SECURE=true
   TRUST_CLOUDFLARE_TUNNEL=true
   SIGNUP_MAX_PER_HOUR=5
   TURNSTILE_SITE_KEY=替换为SiteKey
   TURNSTILE_SECRET_KEY=替换为SecretKey
   TURNSTILE_HOSTNAME=loop.example.com
   ```

   更新代码后运行 `npm run build` 和 `pm2 reload loop --update-env`。用无痕窗口从公网域名试一次新建身份，再用原窗口确认现有身份能进房。Linux 上可用 `ss -ltn 'sport = :3003'` 确认监听在 `127.0.0.1:3003`。接口 `/api/signup/config` 只返回公开 Site key，便于确认配置已生效。

4. 在根域名站点的 **Security rules → Create rule → Rate limiting rules** 创建注册限流规则。规则建在 Zone 内，匹配的主机名是玩家访问的公网子域名。Pro 及以上套餐可在表达式中加 `http.host`，将下面的域名替换成自己的 LOOP 子域名。 [主机名字段](https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/http.host/) · [套餐限制](https://developers.cloudflare.com/waf/rate-limiting-rules/#availability)

   ```text
   http.host eq "loop.example.com" and
   http.request.uri.path in {"/api/guest" "/api/guest/from-netease"}
   ```

   Free 套餐的限流表达式只能用路径等受支持字段。下面的表达式会匹配 Zone 内各子域上的这两个路径。

   ```text
   http.request.uri.path in {"/api/guest" "/api/guest/from-netease"}
   ```

   Free 套餐若要严格限定到 LOOP 子域，先在同一 Zone 的 **Create rule → Custom rules** 创建以下规则。动作选 **Skip**，只勾选 **All rate limiting rules**。这会跳过其他子域上这两个路径的限流阶段。 [自定义规则套餐](https://developers.cloudflare.com/waf/custom-rules/#availability) · [Skip 选项](https://developers.cloudflare.com/waf/custom-rules/skip/options/#skip-phases)

   ```text
   http.host ne "loop.example.com" and
   http.request.uri.path in {"/api/guest" "/api/guest/from-netease"}
   ```

   限流规则的 **With the same characteristics** 选 **IP**，频率填 **5 requests per 10 seconds**，动作选 **Block**，持续 **10 seconds**，点击 **Deploy**。应用另行统计成功创建的账号。 [限流设置步骤](https://developers.cloudflare.com/waf/rate-limiting-rules/create-zone-dashboard/)

5. 如需给管理页加一层登录，在 **Zero Trust → Access controls → Applications → Create new application → Self-hosted and private** 中添加两个 Public hostname 路径。都使用 LOOP 的公网域名，Path 分别填 `/admin/*` 和 `/api/admin/*`。添加 **Allow → Include → Emails**，填管理员自己的邮箱，选择可用的登录方式并保存。打开相应管理页面验证 Access，然后用现有的 LOOP 管理密钥操作。 [Access 应用设置](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) · [路径匹配](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)

### 文本审核

将词库放在已被 Git 忽略的 `data/sensitive-words.txt`，或将 `LOOP_SENSITIVE_WORDS_FILE` 指向部署环境中的私有文件。文件用 UTF-8 编码，每行一条词或短语，空行和以 `#` 开头的行会被忽略。服务在启动时读取词库，更新文件后需要重启。默认文件不存在时，词库检查关闭。显式配置的文件必须可读。

注册、改名、导入网易云昵称和修改房间资料时，服务端会检查新保存的昵称、房间名和房间简介。纯英文字母或数字的词条按完整单词匹配，其余词条按字面匹配。匹配会统一大小写和全半角，并忽略不可见格式字符。原文通过后照常保存。

配置好词库后，可运行 `npm run scan:text` 扫描现有数据库。命令以只读方式打开 `DATABASE_PATH`，每条命中仅列出字段和内部记录 ID，便于人工处理。

### 关于音乐播放

Loop 在服务端查询网易云音乐资料和播放地址，由浏览器直接加载音频。部分歌曲可能只能试听或暂时没有可用地址，能搜索到歌曲不代表它能播放。遇到无法播放的歌曲时，可以换一首再试。扫码是否成功也取决于网易云当前的登录策略。

如果旧部署可以解析同一首歌，在新版的部署目录用该歌曲的网易云 ID 运行定向检查。它对比新版的 `standard/mp3` 和旧版的 `exhigh/flac`，使用服务端配置的登录凭证，并在有凭证时额外用游客身份对比。输出只包含状态和是否拿到地址。

```sh
LOOP_LIVE_MUSIC=1 LOOP_LIVE_MUSIC_TRACK_ID=3450116895 \
  node --env-file-if-exists=.env --import tsx test/live-music.test.ts
```

`identity=anonymous` 表示当前配置未提供网易云账号或游客凭证。两种音质都返回 `songCode=404` 和 `hasUrl=false` 时，可以在服务端 `.env` 配置旧部署使用的同一个网易云 `MUSIC_U`，再用上面的命令对照。已存在的扫码凭证文件优先于 `.env` 中的 `NETEASE_COOKIE`。

需要排查出口差异时，可以测试 `.env` 的 `HTTPS_PROXY` 出站 HTTP 代理配置。旧版的 `NETEASE_MUSIC_API_REALIP` 也是可选项，只设置网易云音乐接口的请求头，实际出口 IP 由服务器网络决定。修改服务端配置后重启服务，在房间里验证浏览器能否实际播放。

## 开发与测试

客户端使用 Vue 3 和 PixiJS，服务端使用 Fastify 和 Socket.IO，数据存储使用 SQLite。数据库初始化和后续改表的 SQL 放在 `migrations/`。

```sh
npm run check
npm test
npm run build
```

默认测试使用受控音乐响应。可选浏览器测试需要安装 Chromium 并先构建项目，再运行 `npm test -- --browser`。`npm test -- --live` 可检查真实网易云接口，结果取决于网络和曲目可用性。

## 致谢

- 小猫角色使用 [Shadow28144 的 Pixel Cat](https://shadow28144.itch.io/pixel-cat)。运行用图和原始编辑文件位于 `public/Cat/`。
- 界面图标来自 [Lucide](https://lucide.dev/)。
- 网易云请求实现参考了 NeteaseCloudMusicApiBackup，来源和许可见 [第三方声明](THIRD_PARTY_NOTICES.md)。
