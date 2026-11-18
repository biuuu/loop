# Loop · 小猫听歌室

Loop 是一个联机听歌网页。取个昵称就能加入朋友的音乐客厅，化身小猫在房间里走动、发预设表情，或上台轮流分享网易云音乐。

- 在大厅按播放状态和在线人数筛选房间，通过数字房号链接邀请朋友。
- 创建昵称时会自动获得一间自己的客厅。房主可更换环境、设置舞台座位数和管理成员。
- 搜索歌曲、网易云用户或歌单，创建自己的播放队列。个人歌单最多 50 首，支持批量导入和拖动排序。
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

PM2 会启动一个名为 `loop` 的进程并读取项目的 `.env`。更新代码并重新构建后，用 `pm2 restart loop` 重启。需要开机自动恢复时，运行 `pm2 startup` 并按它的提示设置系统服务，再运行 `pm2 save`。

### 关于音乐播放

Loop 在服务端查询网易云音乐资料和播放地址，由浏览器直接加载音频。部分歌曲可能只能试听或暂时没有可用地址，能搜索到歌曲不代表它能播放。遇到无法播放的歌曲时，可以换一首再试。扫码是否成功也取决于网易云当前的登录策略。

如果多首歌曲在海外服务器上都无法解析，可以在服务端 `.env` 将 `NETEASE_MUSIC_API_REALIP` 设为一个中国大陆公网 IP 地址并重启服务，试用旧版 LOOP 的兼容方式。只填写 IP。此配置只设置网易云音乐接口的请求头，实际出口 IP 由服务器网络决定。

如果网易云仍拒绝该出口，可将 `.env` 中的 `HTTPS_PROXY` 指向你有权使用的、能访问网易云的出站 HTTP 代理，再重启服务。在目标服务器上用 `npm test -- --live` 检查搜索和播放地址解析，再到房间里验证浏览器能否实际播放。浏览器仍直接请求网易云音频地址。

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
