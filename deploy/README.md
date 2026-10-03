# 部署到自己的服务器

知识书架在服务器上以「公开服务模式」运行：访客要先用 GitHub 登录，每个账号有自己独立的书架和额度。网站通过 Cloudflare Tunnel 对外，服务器不需要开放任何端口，也不占用 80/443。

## 服务器上的布局

| 位置 | 内容 |
|---|---|
| `/opt/vibe-shelf/current` | 当前运行的代码（指向 `releases/` 里的某个版本，保留最近 3 个） |
| `/opt/node` | Node.js |
| `/var/lib/vibe-shelf` | 全部资料：账户、会话、每个人的项目、书、旁注和探索 |
| `/etc/vibe-shelf/vibe-shelf.env` | 配置：模型接口与 Key、GitHub 登录、白名单、额度（仅 root 可读） |
| `/etc/vibe-shelf/tunnel.env` | Cloudflare Tunnel 的令牌（仅 root 可读） |
| `/var/backups/vibe-shelf` | 每天一份资料备份，保留 7 天 |

两个服务：`vibe-shelf`（网站本身，以 `shelf` 用户运行）和 `vibe-shelf-tunnel`（隧道）。都开机自启，崩溃后自动重启。

## 配置项（vibe-shelf.env）

```ini
SHELF_MODE=public
PORT=8899
SHELF_DATA_DIR=/var/lib/vibe-shelf
SHELF_PUBLIC_ORIGIN=https://你的域名
SHELF_TRUST_PROXY=loopback

GITHUB_CLIENT_ID=…
GITHUB_CLIENT_SECRET=…
# 只允许这些 GitHub 账号登录（数字 ID，逗号分隔）；删掉这一行就对所有 GitHub 账号开放
SHELF_ALLOWED_GITHUB_IDS=…

# 每个账号每月能写几本主书、每天能调用几次 AI
SHELF_GENERATION_LIMIT=20
SHELF_DAILY_MODEL_LIMIT=300

SHELF_API_URL=…
SHELF_API_KEY=…
SHELF_MODEL=…
```

GitHub 数字 ID 可以在 `https://api.github.com/users/<用户名>` 里查到。改完配置执行 `systemctl restart vibe-shelf`。

## 更新代码

在本机项目目录执行：

```bash
SHELF_DEPLOY_SSH=root@你的服务器 SHELF_DEPLOY_PORT=SSH端口 deploy/push.sh
```

它会把当前代码打包上传成一个新版本，切换过去并重启服务。出问题时，把 `/opt/vibe-shelf/current` 指回上一个版本再重启即可。

## 常用命令

```bash
systemctl status vibe-shelf vibe-shelf-tunnel   # 运行状态
journalctl -u vibe-shelf -n 100                 # 最近日志
ls /var/backups/vibe-shelf                      # 备份
```
