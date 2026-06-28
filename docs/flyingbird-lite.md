# FlyingBird Worker 维护说明

## 当前路线

```text
Clash Verge -> flyingbird.yuangod.cc.cd -> Cloudflare Worker
-> FlyingBird 登录 -> getSubscribe -> 远程订阅响应
-> 解码转换 -> Clash YAML
```

本仓库只保留 Cloudflare Worker 版本，不再保留旧的本地运行流程或中间文件。

## 线上入口

主入口：

```text
https://flyingbird.yuangod.cc.cd/flyingbird?token=<ACCESS_TOKEN>
```

备用入口：

```text
https://flyingbird-sub.yuanzaai.workers.dev/flyingbird?token=<ACCESS_TOKEN>
```

`<ACCESS_TOKEN>` 本地保存在项目根目录的 `access-token.txt`，并通过 Cloudflare secret `ACCESS_TOKEN` 在线上校验。

## Worker Secrets

Worker 需要三个 secret：

```text
FB_EMAIL
FB_PASSWORD
ACCESS_TOKEN
```

重设 secret：

```powershell
wrangler secret put FB_EMAIL
wrangler secret put FB_PASSWORD
wrangler secret put ACCESS_TOKEN
```

`FB_EMAIL`、`FB_PASSWORD`、`ACCESS_TOKEN` 是 Worker 变量名，命令中保持原样。运行命令后，再按提示输入实际邮箱、密码或访问 token。

只切换上游账号时，保持 `ACCESS_TOKEN` 不变，只更新：

```powershell
wrangler secret put FB_EMAIL
wrangler secret put FB_PASSWORD
```

这样 Clash Verge 里的订阅链接保持不变。需要多个账号同时在线时，建议使用多个 Worker 名称和多个子域名分别部署，而不是让同一个 URL 在多个账号之间切换。

## 部署

在项目根目录运行：

```powershell
wrangler deploy
```

部署后应看到：

```text
https://flyingbird-sub.yuanzaai.workers.dev
flyingbird.yuangod.cc.cd (custom domain)
```

## 实现要点

`worker.js` 的主要流程：

1. `/health` 返回健康检查 JSON。
2. `/flyingbird?token=...` 校验 `ACCESS_TOKEN`。
3. 使用 `FB_EMAIL` 和 `FB_PASSWORD` 调用 `/passport/auth/login`。
4. 使用登录返回的 `auth_data` 调用 `/user/getSubscribe`。
5. 用返回的 token 请求 `/client/subscribe?token=...`。
6. 使用 `wrangler.toml` 中的转换参数生成 YAML。

如果上游客户端更新后返回格式变化，需要同步更新 Worker 逻辑并重新部署。
